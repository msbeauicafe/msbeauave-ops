-- ============================================================================
-- MS BEAU AVE — undoing a delivery that was never really there
--
-- Someone types 10000 where they meant 1000. Until now the only ways out were
-- both lies: write the extra off as damaged, which puts goods that never
-- existed into the shrinkage report and money that never moved into the loss
-- column, or edit the tables by hand, which is worse because from the outside
-- a corrected ledger and a doctored one look the same.
--
-- What actually happened is that the delivery did not happen. So the honest
-- correction is to unmake it: the stock, the money paid out, and the journal
-- lines, together, in one move.
--
-- The whole safety of this function is in what it refuses. It will only undo a
-- delivery nothing has happened to yet — not sold, not moved, not sent to
-- another shop, not promised to an order, not counted, not written off. The
-- moment any of that is true, the lot is part of the trading history and
-- deleting it would be rewriting the past rather than correcting a typo. There
-- is no override, because an override is the whole vulnerability: a function
-- that can erase a sale is a function that can launder one.
--
-- It leaves a mark. Deleting the receipt removes every trace that it was ever
-- entered, and an undo nobody can see is its own kind of dishonesty, so the
-- reversal is written down with who did it and why before anything is removed.
-- ============================================================================

create table if not exists receipt_reversals (
  id        bigint generated always as identity primary key,
  sku       text not null,
  batch_no  text not null,
  expiry    date not null,
  units     int  not null,
  value     numeric(12,2) not null default 0,
  why       text not null,
  actor     text not null default current_actor(),
  at        timestamptz not null default now()
);

create or replace function reverse_receipt(p_batch bigint, p_why text default null)
returns jsonb language plpgsql security definer as $$
declare
  b        batches%rowtype;
  v_name   text;
  v_units  int;
  v_value  numeric(12,2) := 0;
  v_since  text;
  v_where  text;
  v_why    text;
begin
  -- Only the owner. This deletes a posted expense, which is not a warehouse
  -- job even though receiving is.
  perform require_role('admin');

  v_why := btrim(coalesce(p_why, ''));
  if v_why = '' then
    raise exception 'Say why this delivery is being undone. It goes in the record.';
  end if;

  select * into b from batches where id = p_batch;
  if not found then
    raise exception 'There is no such delivery to undo.';
  end if;
  select name into v_name from products where sku = b.sku;
  v_name := coalesce(v_name, b.sku);

  -- ---------------------------------------------------------------------
  -- Everything below is a reason to say no.
  -- ---------------------------------------------------------------------

  -- The journal is the honest record of what has happened to this lot. If it
  -- says anything other than "received", the lot has been traded.
  select string_agg(distinct reason, ', ' order by reason) into v_since
    from movements where batch_id = p_batch and reason <> 'received';
  if v_since is not null then
    raise exception
      'Batch % of % has been touched since it arrived (%). A delivery can only be undone while nothing has happened to it.',
      b.batch_no, v_name, v_since
      using errcode = 'P0009';
  end if;

  -- Promised to an order that has not shipped yet. The units are still on the
  -- shelf, so the journal is silent, but they are spoken for.
  if exists (select 1 from stock where batch_id = p_batch and committed > 0) then
    raise exception
      'Batch % of % is promised to an order. Cancel the order first.',
      b.batch_no, v_name using errcode = 'P0009';
  end if;

  -- Anything else in the business pointing at this lot means it is in play,
  -- whatever the journal says.
  v_where := null;
  if exists (select 1 from order_lines where batch_id = p_batch) then
    v_where := 'an order';
  elsif exists (select 1 from shrinkage where batch_id = p_batch) then
    v_where := 'a write-off';
  elsif exists (select 1 from returns where batch_id = p_batch) then
    v_where := 'a return';
  elsif exists (select 1 from promos where batch_id = p_batch) then
    v_where := 'a promo';
  end if;
  if v_where is not null then
    raise exception 'Batch % of % is already part of %. It cannot be undone.',
      b.batch_no, v_name, v_where using errcode = 'P0009';
  end if;

  -- Belt and braces: what is on the shelf has to be exactly what came in. If
  -- these disagree, something moved by a route this function does not know
  -- about, and guessing would be worse than refusing.
  select coalesce(sum(on_hand), 0)::int into v_units from stock where batch_id = p_batch;
  if v_units <> coalesce((select sum(qty)::int from movements
                           where batch_id = p_batch and reason = 'received'), -1) then
    raise exception
      'The shelf and the delivery note disagree for batch % of %. Count it and put it right by hand.',
      b.batch_no, v_name using errcode = 'P0009';
  end if;

  -- ---------------------------------------------------------------------
  -- Yes. Write down what is being undone, then undo it.
  -- ---------------------------------------------------------------------
  select coalesce(sum(amount), 0) into v_value
    from expenses where batch_id = p_batch and source = 'receiving';

  insert into receipt_reversals (sku, batch_no, expiry, units, value, why)
  values (b.sku, b.batch_no, b.expiry, v_units, v_value, v_why);

  -- The journal refuses to be rewritten, which is what it is for. Undoing a
  -- delivery that never happened is the one case that has to step around it,
  -- and only for the length of this transaction.
  alter table movements disable trigger movements_immutable;
  delete from movements where batch_id = p_batch;
  alter table movements enable trigger movements_immutable;

  delete from expenses where batch_id = p_batch and source = 'receiving';
  delete from stock    where batch_id = p_batch;
  delete from batches  where id = p_batch;

  -- Note on the unit cost: receiving can update what a product costs, and this
  -- does not put that back, because the earlier figure is not recorded
  -- anywhere. A mis-typed quantity does not make the cost per unit wrong, so
  -- in the case this function is for there is nothing to restore. If the cost
  -- was the thing typed wrongly, correct it on the product.
  return jsonb_build_object(
    'sku', b.sku, 'name', v_name, 'batch_no', b.batch_no,
    'units', v_units, 'value', round(v_value, 2));
end;
$$;

alter function reverse_receipt(bigint, text) set search_path = public, extensions;
revoke all on function reverse_receipt(bigint, text) from public;
grant execute on function reverse_receipt(bigint, text) to app_client;

-- What was received lately, and whether it can still be taken back. The screen
-- needs to know the answer before it offers the button, so that the reason a
-- delivery cannot be undone is visible rather than discovered by clicking.
create or replace view recent_receipts as
select b.id as batch_id, b.sku, p.name, b.batch_no, b.expiry,
       b.qty_received, b.received_at,
       coalesce((select sum(s.on_hand) from stock s where s.batch_id = b.id), 0)::int
         as still_here,
       coalesce((select sum(e.amount) from expenses e
                  where e.batch_id = b.id and e.source = 'receiving'), 0) as value,
       (select string_agg(distinct br.name, ', ' order by br.name)
          from stock s join branches br on br.id = s.branch_id
         where s.batch_id = b.id) as branches,
       case
         when exists (select 1 from movements m
                       where m.batch_id = b.id and m.reason <> 'received')
           then 'already traded'
         when exists (select 1 from stock s where s.batch_id = b.id and s.committed > 0)
           then 'promised to an order'
         when exists (select 1 from order_lines o where o.batch_id = b.id)
           then 'already on an order'
         when exists (select 1 from shrinkage sh where sh.batch_id = b.id)
           then 'already written off'
         when exists (select 1 from returns r where r.batch_id = b.id)
           then 'part of a return'
         when exists (select 1 from promos pr where pr.batch_id = b.id)
           then 'part of a promo'
         else null
       end as held_by
  from batches b
  join products p on p.sku = b.sku
 order by b.received_at desc;

grant select on receipt_reversals to app_client;
grant select on recent_receipts to app_client;

alter table receipt_reversals enable row level security;
drop policy if exists staff_read_receipt_reversals on receipt_reversals;
create policy staff_read_receipt_reversals on receipt_reversals for select
  using (current_role_name() in ('admin','warehouse'));

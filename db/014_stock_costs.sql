-- ============================================================================
-- MS BEAU AVE — paying for stock
--
-- Receiving a delivery is real money leaving, and until now nothing recorded
-- it: the stock value went up and the bank account quietly went down with
-- nobody watching.
--
-- The trap here is double counting. Cost of goods sold already takes the cost
-- of a product off the margin at the moment it is sold. If a delivery were
-- also subtracted as an expense, the same peso would come off twice and every
-- profit figure would be wrong — worse than not recording it at all.
--
-- So a stock purchase is recorded, but it is cash out, not a cost of trading.
-- Profit stays revenue minus what was sold minus the running costs; the money
-- spent on stock appears in the cash figures, where it belongs. The two views
-- answer different questions and a shop needs both: one tells you whether you
-- are making money, the other whether you can pay the rent on Friday.
-- ============================================================================

alter table expenses add column source text not null default 'manual'
  check (source in ('manual', 'receiving'));
alter table expenses add column batch_id bigint references batches (id);

-- 'stock' as a manual kind stays available for anything bought outside the
-- receiving screen, and is treated identically: cash out, never a trading cost.
comment on column expenses.source is
  'receiving = written by receive_stock; manual = entered by hand';

-- ---------------------------------------------------------------------------
-- Receiving, now with what it cost
--
-- The unit cost is optional. Given, it is what this delivery actually cost and
-- it becomes the product's cost from now on — the price the supplier charged
-- today is the best estimate of what the next one will. Omitted, the product's
-- existing cost is used and nothing is overwritten.
--
-- The old four-argument form is dropped rather than left beside this one:
-- two functions of the same name where one silently skips the money is exactly
-- the sort of thing that gets called by accident for a year.
-- ---------------------------------------------------------------------------
drop function if exists receive_stock(text, text, date, int);

create or replace function receive_stock(
  p_sku      text,
  p_batch_no text,
  p_expiry   date,
  p_qty      int,
  p_unit_cost numeric default null,
  p_method   text default 'bank'
) returns bigint
language plpgsql security definer as $$
declare
  v_batch  bigint;
  v_pools  text[]    := array['b2b','shop','reserve'];
  v_share  numeric[];
  v_whole  int[];
  v_frac   numeric[];
  v_spare  int;
  i        int;
  v_pick   int;
  v_cost   numeric(12,2);
  v_name   text;
begin
  perform require_role('admin','warehouse');
  if p_qty <= 0 then
    raise exception 'received quantity must be more than zero';
  end if;
  if p_expiry <= current_date then
    raise exception 'that batch is already expired on arrival (% )', p_expiry;
  end if;
  if p_unit_cost is not null and p_unit_cost < 0 then
    raise exception 'a unit cost cannot be negative';
  end if;

  select name, unit_cost into v_name, v_cost
    from products where sku = p_sku and active;
  if not found then
    raise exception 'no active product with code %', p_sku;
  end if;

  insert into batches (sku, batch_no, expiry, qty_received)
  values (p_sku, p_batch_no, p_expiry, p_qty)
  returning id into v_batch;

  select array_agg(share order by ord) into v_share
    from (select share, row_number() over () as ord from allocation_for(p_sku)) s;

  v_whole := array[floor(p_qty * v_share[1])::int,
                   floor(p_qty * v_share[2])::int,
                   floor(p_qty * v_share[3])::int];
  v_frac  := array[p_qty * v_share[1] - v_whole[1],
                   p_qty * v_share[2] - v_whole[2],
                   p_qty * v_share[3] - v_whole[3]];
  v_spare := p_qty - (v_whole[1] + v_whole[2] + v_whole[3]);

  while v_spare > 0 loop
    v_pick := 1;
    for i in 2..3 loop
      if v_frac[i] > v_frac[v_pick] then v_pick := i; end if;
    end loop;
    v_whole[v_pick] := v_whole[v_pick] + 1;
    v_frac[v_pick]  := -1;              -- each pool takes at most one spare unit
    v_spare := v_spare - 1;
  end loop;

  for i in 1..3 loop
    if v_whole[i] > 0 then
      insert into stock (batch_id, pool, on_hand) values (v_batch, v_pools[i], v_whole[i]);
      insert into movements (batch_id, to_pool, qty, reason)
      values (v_batch, v_pools[i], v_whole[i], 'received');
    end if;
  end loop;

  -- What the delivery cost, and what it costs from now on.
  if p_unit_cost is not null then
    v_cost := p_unit_cost;
    update products set unit_cost = p_unit_cost where sku = p_sku;
  end if;

  if coalesce(v_cost, 0) > 0 then
    insert into expenses (kind, description, amount, method, spent_on, source, batch_id)
    values ('stock',
            format('%s × %s (lot %s)', p_qty, v_name, p_batch_no),
            round(v_cost * p_qty, 2), p_method,
            (now() at time zone 'Asia/Manila')::date, 'receiving', v_batch);
  end if;

  return v_batch;
end;
$$;

alter function receive_stock(text, text, date, int, numeric, text)
  set search_path = public, extensions;
revoke all on function receive_stock(text, text, date, int, numeric, text) from public;
grant execute on function receive_stock(text, text, date, int, numeric, text) to app_client;

-- ---------------------------------------------------------------------------
-- The figures, with the two questions kept apart
--
--   Profit  = what was sold, less what it cost, less the running costs.
--   Cash    = what actually came in, less everything that actually went out,
--             stock included.
--
-- A shop can be profitable and unable to pay the rent, which is precisely what
-- happens when a quarter's stock is bought in one week. Reporting only one of
-- these hides that.
-- ---------------------------------------------------------------------------
create or replace function finance_summary(p_from date, p_to date)
returns jsonb language sql security definer stable as $$
  with counter as (
    select coalesce(sum(revenue), 0) as revenue,
           coalesce(sum(cost), 0)    as cost,
           count(*)                  as sales,
           bool_and(costed)          as fully_costed
      from sale_margins where business_date between p_from and p_to),
  by_method as (
    select jsonb_object_agg(method, total) as split
      from (select method, sum(revenue) as total from sale_margins
             where business_date between p_from and p_to group by method) m),
  cash_in as (
    select coalesce(sum(revenue), 0) as taken
      from sale_margins
     where business_date between p_from and p_to and method in ('cash', 'gcash', 'card')),
  wholesale as (
    select coalesce(sum(revenue), 0) as invoiced,
           coalesce(sum(cost), 0)    as cost,
           count(*)                  as orders
      from wholesale_margins where issued_on between p_from and p_to),
  collected as (
    select coalesce(sum(amount), 0) as received
      from payments where paid_on between p_from and p_to),
  owed as (
    select coalesce(sum(amount - paid), 0) as outstanding
      from invoices where status = 'open'),
  -- Running costs only. Stock is counted through cost of goods sold, so
  -- subtracting it here as well would take the same peso off twice.
  running as (
    select coalesce(sum(amount), 0) as total from expenses
     where not voided and kind <> 'stock' and spent_on between p_from and p_to),
  running_split as (
    select coalesce(jsonb_object_agg(kind, by_kind), '{}'::jsonb) as split
      from (select kind, sum(amount) as by_kind from expenses
             where not voided and kind <> 'stock' and spent_on between p_from and p_to
             group by kind) e),
  stock_bought as (
    select coalesce(sum(amount), 0) as total from expenses
     where not voided and kind = 'stock' and spent_on between p_from and p_to),
  stock_at_cost as (
    select coalesce(sum(st.on_hand * p.unit_cost), 0) as value
      from stock st join batches b on b.id = st.batch_id
      join products p on p.sku = b.sku)
  select jsonb_build_object(
    'from', p_from, 'to', p_to,
    'counter', jsonb_build_object(
      'revenue', c.revenue, 'cost', c.cost, 'margin', c.revenue - c.cost,
      'sales', c.sales, 'by_method', coalesce(bm.split, '{}'::jsonb),
      'fully_costed', coalesce(c.fully_costed, true)),
    'wholesale', jsonb_build_object(
      'invoiced', w.invoiced, 'cost', w.cost, 'margin', w.invoiced - w.cost,
      'orders', w.orders, 'received', col.received, 'outstanding', ow.outstanding),
    'expenses', jsonb_build_object('total', r.total, 'by_kind', rs.split),
    'stock_bought', sb.total,
    'gross_margin', (c.revenue - c.cost) + (w.invoiced - w.cost),
    'net', (c.revenue - c.cost) + (w.invoiced - w.cost) - r.total,
    'cash', jsonb_build_object(
      'in', ci.taken + col.received,
      'out', r.total + sb.total,
      'movement', (ci.taken + col.received) - (r.total + sb.total)),
    'stock_at_cost', sac.value)
    from counter c, by_method bm, cash_in ci, wholesale w, collected col, owed ow,
         running r, running_split rs, stock_bought sb, stock_at_cost sac;
$$;

alter function finance_summary(date, date) set search_path = public, extensions;
revoke all on function finance_summary(date, date) from public;
grant execute on function finance_summary(date, date) to app_client;

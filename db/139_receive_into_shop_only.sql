-- ============================================================================
-- MS BEAU AVE — receiving lands in one pool, not three
--
-- Every delivery used to split itself automatically the moment it was
-- received — a fixed percentage (a product's own, or the house 70/20/10)
-- sent to wholesale, shop and reserve in one move, before anyone at the
-- receiving screen had a say. That is why one delivery read as three rows
-- in the "Just received" journal, and why the owner did not recognise a
-- 100-unit order as 100 units.
--
-- Receiving is no longer the moment that split happens. Everything that
-- comes in lands whole in the shop pool. Sending part of it on to wholesale
-- or reserve afterwards is move_stock's job — the same function Stockroom's
-- "Move stock between pools" already calls — done on purpose by someone who
-- can see the number, not by a percentage nobody chose at the counter.
--
-- allocation_for and the per-product split (alloc_b2b/alloc_shop/
-- alloc_reserve) are untouched — they still show on the Product list as the
-- house's reference split, they are simply no longer applied automatically
-- here.
-- ============================================================================

create or replace function receive_stock(
  p_sku      text,
  p_batch_no text,
  p_expiry   date,
  p_qty      int,
  p_unit_cost numeric default null,
  p_method   text default 'bank',
  p_branch   bigint default null
) returns bigint
language plpgsql security definer as $$
declare
  v_batch  bigint;
  v_cost   numeric(12,2);
  v_name   text;
  v_branch bigint;
begin
  -- 073_data_coordinator widened this beside 'warehouse' by rewriting the
  -- live function text at the time; a plain create-or-replace here would
  -- silently drop that again, so it is named plainly instead.
  perform require_role('admin','warehouse','datacoord');
  if p_qty <= 0 then
    raise exception 'received quantity must be more than zero';
  end if;
  if p_expiry <= current_date then
    raise exception 'that batch is already expired on arrival (% )', p_expiry;
  end if;
  if p_unit_cost is not null and p_unit_cost < 0 then
    raise exception 'a unit cost cannot be negative';
  end if;

  v_branch := branch_or_default(p_branch);
  if not exists (select 1 from branches where id = v_branch and active) then
    raise exception 'That branch is not open.';
  end if;

  select name, unit_cost into v_name, v_cost
    from products where sku = p_sku and active;
  if not found then
    raise exception 'no active product with code %', p_sku;
  end if;

  -- A batch number is one lot from the maker. The same lot arriving at a second
  -- shop is the same batch, not a new one, so its expiry cannot disagree with
  -- itself.
  select id into v_batch from batches where sku = p_sku and batch_no = p_batch_no;
  if found then
    if (select expiry from batches where id = v_batch) <> p_expiry then
      raise exception 'Batch % of % is already recorded expiring %, not %.',
        p_batch_no, v_name, (select expiry from batches where id = v_batch), p_expiry;
    end if;
    update batches set qty_received = qty_received + p_qty where id = v_batch;
  else
    insert into batches (sku, batch_no, expiry, qty_received)
    values (p_sku, p_batch_no, p_expiry, p_qty)
    returning id into v_batch;
  end if;

  insert into stock (batch_id, pool, branch_id, on_hand)
  values (v_batch, 'shop', v_branch, p_qty)
  on conflict (batch_id, pool, branch_id)
    do update set on_hand = stock.on_hand + excluded.on_hand;
  insert into movements (batch_id, to_pool, qty, reason, branch_id)
  values (v_batch, 'shop', p_qty, 'received', v_branch);

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

alter function receive_stock(text, text, date, int, numeric, text, bigint)
  set search_path = public, extensions;

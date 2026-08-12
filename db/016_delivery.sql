-- ============================================================================
-- MS BEAU AVE — a delivery, rather than a line of one
--
-- Stock does not arrive one product at a time. A supplier sends a box with a
-- delivery note listing twenty lines, and until now the only way to enter that
-- was twenty passes through a form. That is not a smaller version of the same
-- job: it is the version where line fourteen gets missed, and nobody finds out
-- until the shelf count disagrees with the system weeks later.
--
-- So the whole note goes in at once, in one transaction. Either the delivery
-- landed or it did not. A half-entered delivery is the worst of the three
-- outcomes, because the totals look plausible and no one goes looking.
--
-- Every line still goes through receive_stock, so the pool split, the expiry
-- rules, the movement journal and the money going out all behave exactly as
-- they do for a single line. This function decides nothing about stock; it
-- only decides that twenty of them succeed or fail together.
-- ============================================================================

create or replace function receive_delivery(p_lines jsonb, p_branch bigint default null)
returns jsonb language plpgsql security definer as $$
declare
  line     jsonb;
  n        int := 0;
  v_sku    text;
  v_batch  text;
  v_qty    int;
  v_expiry date;
  v_cost   numeric;
  v_name   text;
  v_seen   text[] := array[]::text[];
  v_key    text;
  v_id     bigint;
  v_lines  int := 0;
  v_units  int := 0;
  v_value  numeric := 0;
  v_out    jsonb := '[]'::jsonb;
begin
  perform require_role('admin', 'warehouse');

  if jsonb_typeof(p_lines) <> 'array' then
    raise exception 'A delivery has to be a list of lines.';
  end if;
  if jsonb_array_length(p_lines) = 0 then
    raise exception 'That delivery note is empty.';
  end if;

  -- Checked in full before a single unit is booked in. The alternative is
  -- discovering the mistake with half the delivery already on the shelf.
  for line in select * from jsonb_array_elements(p_lines) loop
    n := n + 1;
    v_sku   := upper(btrim(coalesce(line->>'sku', '')));
    v_batch := btrim(coalesce(line->>'batch_no', ''));

    if v_sku = '' then
      raise exception 'Line % has no product code.', n;
    end if;
    select name into v_name from products where sku = v_sku and active;
    if not found then
      raise exception 'Line %: there is no product on sale with the code %.', n, v_sku;
    end if;
    if v_batch = '' then
      raise exception 'Line % (%) has no batch number.', n, v_name;
    end if;

    begin
      v_qty := (line->>'qty')::int;
    exception when others then
      raise exception 'Line % (%): "%" is not a quantity.', n, v_name, line->>'qty';
    end;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Line % (%): the quantity has to be more than zero.', n, v_name;
    end if;

    begin
      v_expiry := (line->>'expiry')::date;
    exception when others then
      raise exception 'Line % (%): "%" is not a date.', n, v_name, line->>'expiry';
    end;
    if v_expiry is null then
      raise exception 'Line % (%) has no expiry date.', n, v_name;
    end if;
    if v_expiry <= current_date then
      raise exception 'Line % (%): that batch expires on %, which has already passed.',
        n, v_name, v_expiry;
    end if;

    if (line->>'unit_cost') is not null and btrim(line->>'unit_cost') <> '' then
      begin
        v_cost := (line->>'unit_cost')::numeric;
      exception when others then
        raise exception 'Line % (%): "%" is not a cost.', n, v_name, line->>'unit_cost';
      end;
      if v_cost < 0 then
        raise exception 'Line % (%): a cost cannot be negative.', n, v_name;
      end if;
    end if;

    -- The same batch number twice for one product would be rejected by the
    -- table anyway; catching it here names the line instead of the constraint.
    v_key := v_sku || '|' || upper(v_batch);
    if v_key = any (v_seen) then
      raise exception 'Line %: batch % of % is on this delivery twice.', n, v_batch, v_name;
    end if;
    v_seen := v_seen || v_key;

    -- The same lot can arrive at a second shop; that is one batch in two
    -- places, not a duplicate. What it cannot do is arrive with a different
    -- expiry, because then it is not the same lot.
    if exists (select 1 from batches
                where sku = v_sku and batch_no = v_batch and expiry <> v_expiry) then
      raise exception 'Line %: batch % of % is already recorded expiring %, not %.',
        n, v_batch, v_name,
        (select expiry from batches where sku = v_sku and batch_no = v_batch), v_expiry;
    end if;
    if exists (
      select 1 from batches b join stock st on st.batch_id = b.id
       where b.sku = v_sku and b.batch_no = v_batch
         and st.branch_id = coalesce(p_branch, default_branch())) then
      raise exception 'Line %: batch % of % is already at this branch.', n, v_batch, v_name;
    end if;
  end loop;

  -- Book it in.
  n := 0;
  for line in select * from jsonb_array_elements(p_lines) loop
    n := n + 1;
    v_sku   := upper(btrim(line->>'sku'));
    v_batch := btrim(line->>'batch_no');
    v_qty   := (line->>'qty')::int;
    v_cost  := nullif(btrim(coalesce(line->>'unit_cost', '')), '')::numeric;

    v_id := receive_stock(v_sku, v_batch, (line->>'expiry')::date, v_qty, v_cost,
                          coalesce(nullif(btrim(coalesce(line->>'method', '')), ''), 'bank'),
                          p_branch);

    v_lines := v_lines + 1;
    v_units := v_units + v_qty;
    v_value := v_value + (coalesce(v_cost, (select unit_cost from products where sku = v_sku), 0)
                          * v_qty);
    v_out := v_out || jsonb_build_object(
      'sku', v_sku, 'batch_id', v_id, 'qty', v_qty,
      'split', (select jsonb_object_agg(pool, on_hand) from stock
                 where batch_id = v_id
                   and branch_id = coalesce(p_branch, default_branch())));
  end loop;

  return jsonb_build_object(
    'lines', v_lines, 'units', v_units, 'value', round(v_value, 2), 'received', v_out);
end;
$$;

drop function if exists receive_delivery(jsonb);
alter function receive_delivery(jsonb, bigint) set search_path = public, extensions;
revoke all on function receive_delivery(jsonb, bigint) from public;
grant execute on function receive_delivery(jsonb, bigint) to app_client;

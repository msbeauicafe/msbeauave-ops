-- ============================================================================
-- MS BEAU AVE — the paper, without receiving it twice
--
-- Transfer to Receive turns an order that has already been quick-received
-- into the formal Receiving Form — the paperwork a delivery still needs on
-- file, not a second delivery. record_receiving_form always called
-- receive_po_line/receive_stock underneath, which is right for a form that
-- is the first record of a delivery, and wrong for one that is documenting
-- a delivery already on the books: it would add the same stock twice and
-- push a purchase order line's received count past what actually arrived.
--
-- p_paperwork_only skips exactly that: the form and its lines are still
-- written down, batch number and expiry are still asked for, only the two
-- calls that move stock and tick a purchase order line off are skipped.
-- ============================================================================

-- A new parameter, not a replaced one — create or replace does not retire
-- the six-argument overload it grew from, and calling this by name with six
-- arguments would then be ambiguous between the two.
drop function if exists record_receiving_form(bigint, jsonb, jsonb, jsonb, bigint, bigint);

create or replace function record_receiving_form(
  p_supplier bigint,
  p_lines    jsonb,
  p_courier  jsonb default '{}'::jsonb,
  p_foot     jsonb default '{}'::jsonb,
  p_po       bigint default null,
  p_branch   bigint default null,
  p_paperwork_only boolean default false
) returns jsonb
language plpgsql security definer as $$
declare
  v_rf bigint; v_no text; v_n int := 0; v_units int := 0; v_boxes int := 0;
  line record; pk record; v_qty int; v_packs int; v_supplier bigint;
begin
  perform require_role('admin', 'warehouse');
  if jsonb_array_length(coalesce(p_lines, '[]'::jsonb)) = 0 then
    raise exception 'A receiving form needs at least one product.';
  end if;

  v_supplier := p_supplier;
  if p_po is not null then
    select supplier_id into v_supplier from purchase_orders where id = p_po;
    if not found then raise exception 'There is no such purchase order.'; end if;
  end if;
  if not exists (select 1 from suppliers where id = v_supplier) then
    raise exception 'Who was this delivered by? Pick a supplier.';
  end if;

  v_no := next_rf_no();
  insert into receiving_forms (
    rf_no, po_id, supplier_id, received_on, received_at, driver_name, plate_no,
    pickup, contact, shipping_fee, shipping_mop, others, guard_on_duty,
    checked_by, approved_by)
  values (
    v_no, p_po, v_supplier,
    coalesce(nullif(btrim(coalesce(p_foot ->> 'received_on', '')), '')::date,
             (now() at time zone 'Asia/Manila')::date),
    nullif(btrim(coalesce(p_courier ->> 'received_at',   '')), ''),
    nullif(btrim(coalesce(p_courier ->> 'driver_name',   '')), ''),
    nullif(btrim(coalesce(p_courier ->> 'plate_no',      '')), ''),
    nullif(btrim(coalesce(p_courier ->> 'pickup',        '')), ''),
    nullif(btrim(coalesce(p_courier ->> 'contact',       '')), ''),
    coalesce(nullif(btrim(coalesce(p_courier ->> 'shipping_fee', '')), '')::numeric, 0),
    nullif(btrim(coalesce(p_courier ->> 'shipping_mop',  '')), ''),
    nullif(btrim(coalesce(p_foot    ->> 'others',        '')), ''),
    nullif(btrim(coalesce(p_foot    ->> 'guard_on_duty', '')), ''),
    nullif(btrim(coalesce(p_foot    ->> 'checked_by',    '')), ''),
    nullif(btrim(coalesce(p_foot    ->> 'approved_by',   '')), ''))
  returning id into v_rf;

  for line in
    select l ->> 'sku' as sku,
           coalesce(nullif(btrim(coalesce(l ->> 'unit', '')), ''), 'PCS') as unit,
           nullif(btrim(coalesce(l ->> 'batch_no', '')), '') as batch_no,
           nullif(btrim(coalesce(l ->> 'expiry', '')), '')::date as expiry,
           nullif(btrim(coalesce(l ->> 'unit_cost', '')), '')::numeric as unit_cost,
           nullif(btrim(coalesce(l ->> 'po_line_id', '')), '')::bigint as po_line_id,
           coalesce(l -> 'packs', '[]'::jsonb) as packs
      from jsonb_array_elements(p_lines) l
  loop
    v_n := v_n + 1;
    if jsonb_array_length(line.packs) = 0 then
      raise exception 'Line %: how did % arrive — how many to a box, and how many boxes?',
        v_n, line.sku;
    end if;
    if line.batch_no is null then
      raise exception 'Line %: what batch number is on the carton?', v_n;
    end if;
    if line.expiry is null then
      raise exception 'Line %: what expiry is on the carton?', v_n;
    end if;

    v_qty := 0; v_packs := 0;
    for pk in
      select coalesce(nullif(btrim(coalesce(p ->> 'pack', '')), ''), 'BOX') as pack,
             (p ->> 'qty_per_box')::int as per,
             coalesce((p ->> 'boxes')::int, 1) as boxes
        from jsonb_array_elements(line.packs) p
    loop
      if pk.per is null or pk.per <= 0 or pk.boxes <= 0 then
        raise exception 'Line %: a packing of % by % is not a count of anything.',
          v_n, pk.boxes, pk.per;
      end if;
      insert into receiving_form_lines (
        rf_id, line_no, sku, unit, pack, qty_per_box, boxes, po_line_id, batch_no)
      values (v_rf, v_n, line.sku, line.unit, pk.pack, pk.per, pk.boxes,
              line.po_line_id, line.batch_no);
      v_qty   := v_qty + pk.per * pk.boxes;
      v_packs := v_packs + pk.boxes;
    end loop;

    -- Into stock once, as the one lot it is — unless this form is only
    -- writing down a delivery that already went through receiving.
    if not p_paperwork_only then
      if line.po_line_id is not null then
        perform receive_po_line(line.po_line_id, line.batch_no, line.expiry, v_qty,
                                line.unit_cost, 'bank', p_branch);
      else
        perform receive_stock(line.sku, line.batch_no, line.expiry, v_qty,
                              line.unit_cost, 'bank', p_branch);
      end if;
    end if;

    v_units := v_units + v_qty;
    v_boxes := v_boxes + v_packs;
  end loop;

  update receiving_forms
     set total_boxes = coalesce(nullif(btrim(coalesce(p_foot ->> 'total_boxes', '')), '')::int,
                                v_boxes)
   where id = v_rf;

  return jsonb_build_object('id', v_rf, 'rf_no', v_no,
                            'lines', v_n, 'units', v_units, 'boxes', v_boxes);
end;
$$;

alter function record_receiving_form(bigint, jsonb, jsonb, jsonb, bigint, bigint, boolean)
  set search_path = public, extensions;
grant execute on function record_receiving_form(bigint, jsonb, jsonb, jsonb, bigint, bigint, boolean)
  to app_client;

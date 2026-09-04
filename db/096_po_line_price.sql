-- ============================================================================
-- MS BEAU AVE — a price on a purchase order line
--
-- A purchase order still prints without prices — the sheet the supplier reads
-- carries none, and the true cost is settled on receiving. But the office wants
-- to write the expected price beside each line as it builds the order, so it is
-- kept here on the line: a nullable figure, editable, that rides along with the
-- order and never touches how cost is recorded when the goods arrive.
-- ============================================================================

alter table purchase_order_lines add column if not exists price numeric;

-- raise_purchase_order, now reading a price off each line when one is given.
create or replace function raise_purchase_order(
  p_supplier bigint, p_lines jsonb, p_note text default null,
  p_ordered_on date default null
) returns jsonb
language plpgsql security definer as $$
declare v_po bigint; v_no text; line record;
begin
  perform require_role('admin', 'warehouse', 'office');
  if jsonb_array_length(coalesce(p_lines, '[]'::jsonb)) = 0 then
    raise exception 'A purchase order needs at least one line.';
  end if;
  if not exists (select 1 from suppliers where id = p_supplier and active) then
    raise exception 'There is no supplier with that number.';
  end if;

  v_no := next_po_no();
  insert into purchase_orders (po_no, supplier_id, note, ordered_on)
  values (v_no, p_supplier, nullif(btrim(coalesce(p_note, '')), ''),
          coalesce(p_ordered_on, (now() at time zone 'Asia/Manila')::date))
  returning id into v_po;

  for line in
    select l ->> 'sku' as sku, (l ->> 'qty')::int as qty,
           coalesce(nullif(btrim(coalesce(l ->> 'unit', '')), ''), 'PCS') as unit,
           nullif(btrim(coalesce(l ->> 'price', '')), '')::numeric as price
      from jsonb_array_elements(p_lines) l
  loop
    if line.qty is null or line.qty <= 0 then
      raise exception 'How many of % are being ordered?', line.sku;
    end if;
    if not exists (select 1 from products where sku = line.sku) then
      raise exception 'There is no product with the code %.', line.sku;
    end if;
    insert into purchase_order_lines (po_id, sku, qty, unit, price)
    values (v_po, line.sku, line.qty, line.unit, line.price);
  end loop;

  return jsonb_build_object('id', v_po, 'po_no', v_no);
end;
$$;

-- revise_purchase_order, keeping the price on each replaced line.
create or replace function revise_purchase_order(
  p_id bigint, p_lines jsonb, p_po_no text, p_note text
) returns jsonb
language plpgsql security definer as $$
declare v_status text; v_no text; line record;
begin
  perform require_role('admin', 'warehouse', 'office');

  select status, po_no into v_status, v_no from purchase_orders where id = p_id;
  if not found then raise exception 'There is no purchase order with that number.'; end if;
  if v_status <> 'open' then
    raise exception 'This purchase order already has deliveries against it; it can no longer be revised.';
  end if;

  if p_po_no is not null then
    if length(btrim(p_po_no)) = 0 then
      raise exception 'A purchase order needs a number.';
    end if;
    if exists (select 1 from purchase_orders where po_no = btrim(p_po_no) and id <> p_id) then
      raise exception 'Purchase order % is already taken.', btrim(p_po_no);
    end if;
    update purchase_orders set po_no = btrim(p_po_no) where id = p_id;
    v_no := btrim(p_po_no);
  end if;

  if p_note is not null then
    update purchase_orders set note = nullif(btrim(p_note), '') where id = p_id;
  end if;

  if p_lines is not null then
    if jsonb_array_length(p_lines) = 0 then
      raise exception 'A purchase order needs at least one line.';
    end if;
    delete from purchase_order_lines where po_id = p_id;
    for line in
      select l ->> 'sku' as sku, (l ->> 'qty')::int as qty,
             coalesce(nullif(btrim(coalesce(l ->> 'unit', '')), ''), 'PCS') as unit,
             nullif(btrim(coalesce(l ->> 'price', '')), '')::numeric as price
        from jsonb_array_elements(p_lines) l
    loop
      if line.qty is null or line.qty <= 0 then
        raise exception 'How many of % are being ordered?', line.sku;
      end if;
      if not exists (select 1 from products where sku = line.sku) then
        raise exception 'There is no product with the code %.', line.sku;
      end if;
      insert into purchase_order_lines (po_id, sku, qty, unit, price)
      values (p_id, line.sku, line.qty, line.unit, line.price);
    end loop;
  end if;

  return jsonb_build_object('id', p_id, 'po_no', v_no);
end;
$$;

alter function raise_purchase_order(bigint, jsonb, text, date)  set search_path = public, extensions;
alter function revise_purchase_order(bigint, jsonb, text, text) set search_path = public, extensions;
grant execute on function raise_purchase_order(bigint, jsonb, text, date)  to app_client;
grant execute on function revise_purchase_order(bigint, jsonb, text, text) to app_client;

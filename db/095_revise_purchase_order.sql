-- ============================================================================
-- MS BEAU AVE — revising a pending purchase order
--
-- A purchase order can be corrected the way a pending customer order can: while
-- it is still open and nothing has been received against it. Once a delivery
-- lands (status part or closed) the lines are fixed — what came in came in, and
-- a screen cannot rewrite a delivery that already happened.
--
-- Three things move here, each only when it is given: the order's number, its
-- comments, and its lines. Passing null for any of them leaves that one alone,
-- so the numbers panel can save the number without touching the lines and the
-- line editor can save the lines without touching the number.
-- ============================================================================

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

  -- The order's own number, if a new one is handed in.
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

  -- Comments, if given (an empty note clears it).
  if p_note is not null then
    update purchase_orders set note = nullif(btrim(p_note), '') where id = p_id;
  end if;

  -- The lines, if given. Nothing is received on an open order, so the whole set
  -- is replaced from what was sent.
  if p_lines is not null then
    if jsonb_array_length(p_lines) = 0 then
      raise exception 'A purchase order needs at least one line.';
    end if;
    delete from purchase_order_lines where po_id = p_id;
    for line in
      select l ->> 'sku' as sku, (l ->> 'qty')::int as qty,
             coalesce(nullif(btrim(coalesce(l ->> 'unit', '')), ''), 'PCS') as unit
        from jsonb_array_elements(p_lines) l
    loop
      if line.qty is null or line.qty <= 0 then
        raise exception 'How many of % are being ordered?', line.sku;
      end if;
      if not exists (select 1 from products where sku = line.sku) then
        raise exception 'There is no product with the code %.', line.sku;
      end if;
      insert into purchase_order_lines (po_id, sku, qty, unit)
      values (p_id, line.sku, line.qty, line.unit);
    end loop;
  end if;

  return jsonb_build_object('id', p_id, 'po_no', v_no);
end;
$$;

alter function revise_purchase_order(bigint, jsonb, text, text)
  set search_path = public, extensions;
grant execute on function revise_purchase_order(bigint, jsonb, text, text) to app_client;

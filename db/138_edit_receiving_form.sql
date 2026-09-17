-- ============================================================================
-- MS BEAU AVE — correcting the paperwork after it is filed
--
-- Everything on a receiving form's own header — who dropped it off, what it
-- cost to ship, who signed for it — is just what got written down, and can be
-- written down again differently with nothing else at stake.
--
-- A batch number or an expiry typed wrong is a different thing: it is not
-- only this form's own record of it, it is the label the shelf and every
-- report since has been reading off the batch itself. Renaming or re-dating
-- that batch here corrects it everywhere at once, which is right — but the
-- quantity that arrived is left alone. Changing how many arrived means
-- adding to or taking from stock that may already be picked, reserved or
-- sold against, and getting that adjustment wrong is a worse mess than the
-- one being fixed. Undoing the delivery and receiving it again still says
-- how many arrived should be corrected — just not from here.
-- ============================================================================

create or replace function edit_receiving_form(
  p_rf bigint, p_courier jsonb default '{}'::jsonb,
  p_foot jsonb default '{}'::jsonb, p_lines jsonb default '[]'::jsonb
) returns jsonb
language plpgsql security definer as $$
declare
  line   record;
  v_sku  text;
  v_old_batch text;
  v_old_expiry date;
begin
  perform require_role('admin', 'warehouse');

  update receiving_forms set
    received_on   = coalesce(nullif(btrim(coalesce(p_foot ->> 'received_on', '')), '')::date, received_on),
    received_at   = nullif(btrim(coalesce(p_courier ->> 'received_at',   '')), ''),
    driver_name   = nullif(btrim(coalesce(p_courier ->> 'driver_name',   '')), ''),
    plate_no      = nullif(btrim(coalesce(p_courier ->> 'plate_no',      '')), ''),
    pickup        = nullif(btrim(coalesce(p_courier ->> 'pickup',        '')), ''),
    contact       = nullif(btrim(coalesce(p_courier ->> 'contact',       '')), ''),
    shipping_fee  = coalesce(nullif(btrim(coalesce(p_courier ->> 'shipping_fee', '')), '')::numeric, 0),
    shipping_mop  = nullif(btrim(coalesce(p_courier ->> 'shipping_mop',  '')), ''),
    others        = nullif(btrim(coalesce(p_foot    ->> 'others',        '')), ''),
    guard_on_duty = nullif(btrim(coalesce(p_foot    ->> 'guard_on_duty', '')), ''),
    checked_by    = nullif(btrim(coalesce(p_foot    ->> 'checked_by',    '')), ''),
    approved_by   = nullif(btrim(coalesce(p_foot    ->> 'approved_by',   '')), ''),
    total_boxes   = coalesce(nullif(btrim(coalesce(p_foot ->> 'total_boxes', '')), '')::int, total_boxes)
   where id = p_rf;
  if not found then raise exception 'There is no such receiving form.'; end if;

  for line in
    select (l ->> 'line_no')::int as line_no,
           nullif(btrim(coalesce(l ->> 'batch_no', '')), '') as batch_no,
           nullif(btrim(coalesce(l ->> 'expiry', '')), '')::date as expiry
      from jsonb_array_elements(p_lines) l
  loop
    if line.batch_no is null or line.expiry is null then continue; end if;

    select sku, batch_no into v_sku, v_old_batch
      from receiving_form_lines
     where rf_id = p_rf and line_no = line.line_no
     limit 1;
    if v_old_batch is null then continue; end if;

    select expiry into v_old_expiry from batches where sku = v_sku and batch_no = v_old_batch;
    if line.batch_no = v_old_batch and line.expiry = v_old_expiry then continue; end if;

    if line.batch_no <> v_old_batch
       and exists (select 1 from batches where sku = v_sku and batch_no = line.batch_no) then
      raise exception 'Line %: % already names a batch on file for %.', line.line_no, line.batch_no, v_sku;
    end if;

    update batches set batch_no = line.batch_no, expiry = line.expiry
     where sku = v_sku and batch_no = v_old_batch;
    update receiving_form_lines set batch_no = line.batch_no
     where rf_id = p_rf and line_no = line.line_no;
  end loop;

  return jsonb_build_object('ok', true);
end;
$$;

alter function edit_receiving_form(bigint, jsonb, jsonb, jsonb)
  set search_path = public, extensions;
grant execute on function edit_receiving_form(bigint, jsonb, jsonb, jsonb)
  to app_client;

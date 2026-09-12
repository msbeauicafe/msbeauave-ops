-- ============================================================================
-- MS BEAU AVE — "Only .00 is still owed." reads like a typo, not a peso
--
-- record_bill_payment's overpay message formats the balance with FM, which
-- also strips the leading zero before the decimal point — a balance of
-- exactly nothing came back as ".00" rather than "0.00". Harmless while the
-- payment form only showed for a bill still owed something, so nobody could
-- ever hit a zero balance here; now that the form stays open on a paid bill
-- too, this is the message an accidental extra payment actually shows.
-- ============================================================================

create or replace function record_bill_payment(
  p_bill bigint, p_amount numeric, p_paid_on date, p_method text, p_note text
) returns jsonb
language plpgsql security definer as $$
declare v_balance numeric; v_id bigint;
begin
  perform require_role('admin', 'warehouse', 'office');
  if coalesce(p_amount, 0) <= 0 then
    raise exception 'How much is coming off?';
  end if;
  if p_method is not null and p_method not in (
    'BANCO DE ORO (BDO)', 'BPI', 'SECURITY BANK', 'GCASH', 'CASH', 'FUNDS'
  ) then
    raise exception 'That is not a mode of payment this shop uses.';
  end if;
  select balance into v_balance from purchase_order_bill_balances where id = p_bill;
  if not found then raise exception 'There is no bill with that number.'; end if;
  if p_amount > v_balance then
    raise exception 'Only % is still owed.', to_char(v_balance, 'FM999,990.00');
  end if;

  insert into purchase_order_bill_payments (bill_id, amount, paid_on, method, note)
  values (p_bill, p_amount, coalesce(p_paid_on, (now() at time zone 'Asia/Manila')::date),
          p_method, nullif(btrim(coalesce(p_note, '')), ''))
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'balance', v_balance - p_amount);
end;
$$;
alter function record_bill_payment(bigint, numeric, date, text, text)
  set search_path = public, extensions;
grant execute on function record_bill_payment(bigint, numeric, date, text, text) to app_client;

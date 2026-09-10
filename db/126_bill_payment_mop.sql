-- ============================================================================
-- MS BEAU AVE — a bill payment's mode is the shop's own list, not a guess
--
-- Bank transfer / Cash / GCash / Card was invented rather than read off what
-- the shop actually uses — the same list Confirm the bank payment already
-- offers through MOP_OPTIONS: the shop's own banks by name, GCash, cash, and
-- funds. A bill payment picks from that list now, same as everywhere else
-- money is recorded coming in or going out.
-- ============================================================================

alter table purchase_order_bill_payments
  drop constraint if exists purchase_order_bill_payments_method_check;
alter table purchase_order_bill_payments
  add constraint purchase_order_bill_payments_method_check
  check (method is null or method in (
    'BANCO DE ORO (BDO)', 'BPI', 'SECURITY BANK', 'GCASH', 'CASH', 'FUNDS'
  ));

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
    raise exception 'Only % is still owed.', to_char(v_balance, 'FM999,999.00');
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

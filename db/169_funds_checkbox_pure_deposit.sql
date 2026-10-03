-- Invoice tab's own Record payment dialog, Funds checkbox unticked: the
-- owner wants money typed there to become plain account credit, the
-- invoice on screen left exactly as it was — not settled, not partly
-- settled, untouched.
--
-- Routing that money through the account's own Confirm the bank payment
-- channel (confirm_reseller_payment / pay_reseller_account) cannot do
-- that: pay_reseller_account pays down whatever is open for the account,
-- oldest first, and the very invoice this dialog is open on is very often
-- that oldest open invoice — so the money paid it anyway, exactly the
-- opposite of what unticking the box was supposed to mean. That function
-- stays untouched; every other screen that depends on its oldest-first
-- behavior keeps meaning what it always meant.
--
-- This is the other thing a payment can be: money that arrives and is
-- banked as credit on purpose, deliberately not applied to anything —
-- the same reseller_credits ledger, the same balance every other screen
-- already reads, just reached without ever touching an open invoice.

create or replace function deposit_account_credit(
  p_reseller bigint, p_amount numeric, p_reference_no text default null
) returns bigint
language plpgsql security definer as $$
declare v_id bigint;
begin
  perform require_role('admin', 'orderdesk');
  if p_amount <= 0 then raise exception 'A deposit must be more than zero.'; end if;
  insert into reseller_credits (reseller_id, amount, reason)
  values (p_reseller, p_amount,
          format('%s banked as account credit%s — not applied to any invoice.',
                 to_char(p_amount, 'FM999,999,990.00'),
                 case when p_reference_no is not null
                      then format(' (ref %s)', p_reference_no) else '' end))
  returning id into v_id;
  return v_id;
end;
$$;
alter function deposit_account_credit(bigint, numeric, text) set search_path = public, extensions;
grant execute on function deposit_account_credit(bigint, numeric, text) to app_client;

-- Invoice tab's own Record payment dialog, Funds checkbox: the owner wants
-- ticking it to act at once — draw down whatever the account's own Funds
-- can cover of this one invoice's own balance, record that as a real
-- payment, and show both updated immediately. raise_invoice already does
-- almost exactly this, but only at the moment an invoice is first raised;
-- there was nothing to draw existing credit against an invoice that is
-- already open and sitting on screen, on demand, later.
--
-- This mirrors raise_invoice's own shape for drawing down credit — record
-- the payment, log the credit drawn against it — rather than inventing a
-- new one. record_payment and reseller_credits are untouched.

create or replace function apply_credit_to_invoice(
  p_invoice bigint, p_amount numeric
) returns void
language plpgsql security definer as $$
declare
  inv      invoices%rowtype;
  v_credit numeric(12,2);
  v_owed   numeric(12,2);
begin
  perform require_role('admin');
  if p_amount <= 0 then raise exception 'Nothing to apply.'; end if;

  select * into inv from invoices where id = p_invoice for update;
  if not found then raise exception 'There is no invoice #%.', p_invoice; end if;
  if inv.status <> 'open' then
    raise exception 'Invoice #% is already %.', p_invoice, inv.status;
  end if;

  v_credit := reseller_credit_balance(inv.reseller_id);
  if p_amount > v_credit then
    raise exception 'Only %s is available in Funds.', to_char(v_credit, 'FM999,999,990.00');
  end if;
  v_owed := inv.amount - inv.paid - inv.discount;
  if p_amount > v_owed then
    raise exception 'Invoice #% only has %s left on it.', p_invoice, to_char(v_owed, 'FM999,999,990.00');
  end if;

  perform record_payment(p_invoice, p_amount, current_date);
  insert into reseller_credits (reseller_id, amount, reason)
  values (inv.reseller_id, -p_amount,
          format('%s applied to invoice #%s from the account''s own Funds.',
                 to_char(p_amount, 'FM999,999,990.00'), p_invoice));
end;
$$;
alter function apply_credit_to_invoice(bigint, numeric) set search_path = public, extensions;
grant execute on function apply_credit_to_invoice(bigint, numeric) to app_client;

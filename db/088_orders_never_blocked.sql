-- ============================================================================
-- MS BEAU AVE — an order is never refused
--
-- The account used to be a gate: past-due, on hold, over its credit limit, or
-- not yet approved, and the order was turned away. The owner has decided the
-- account is a record, not a gate — everyone can order, even past due. What an
-- account owes is still shown, and an account that has not moved in ninety days
-- still reads as inactive, but neither stops an order being placed.
--
-- check_can_order keeps only the sanity that the account exists (and the row
-- lock the order transaction relies on); every business refusal is gone.
-- Shipping is untouched — check_can_ship still decides what actually leaves.
-- ============================================================================

create or replace function check_can_order(p_reseller bigint, p_order_value numeric)
returns void
language plpgsql security definer as $$
declare r resellers%rowtype;
begin
  select * into r from resellers where id = p_reseller for update;
  if not found then
    raise exception 'no such reseller (%)', p_reseller;
  end if;
  -- No past-due, on-hold, credit-limit or not-ready refusal any more: an order
  -- is taken from any account. What they owe is carried on the account for the
  -- record, not enforced here.
end;
$$;
-- create-or-replace wipes stored settings, so the pinned search_path is set
-- again — a security-definer function without it is how the model is bypassed.
alter function check_can_order(bigint, numeric) set search_path = public, extensions;

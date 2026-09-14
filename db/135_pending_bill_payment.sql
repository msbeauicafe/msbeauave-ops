-- ============================================================================
-- MS BEAU AVE — a payment promised, not yet a payment made
--
-- Every row on a bill's ledger so far is money that has actually landed.
-- This is the other thing worth writing down: the supplier said "the 15th"
-- and nobody wants to be the one who forgot. A pending payment is a note,
-- not a transaction — it never touches paid, balance, or what a bill's
-- State tag says, the same way a purchase order's own price never touches
-- what the supplier is actually billed. It becomes real money the ordinary
-- way, by recording an actual payment when it lands.
-- ============================================================================

create table if not exists purchase_order_bill_pending_payments (
  id          bigint generated always as identity primary key,
  bill_id     bigint not null references purchase_order_bills (id) on delete cascade,
  amount      numeric(12,2) not null check (amount > 0),
  expected_on date not null,
  created_at  timestamptz not null default now(),
  created_by  text not null default current_actor()
);
create index if not exists purchase_order_bill_pending_payments_by_bill
  on purchase_order_bill_pending_payments (bill_id);

alter table purchase_order_bill_pending_payments enable row level security;
drop policy if exists stock_reads_purchase_order_bill_pending_payments
  on purchase_order_bill_pending_payments;
create policy stock_reads_purchase_order_bill_pending_payments
  on purchase_order_bill_pending_payments for select
  using (current_role_name() in ('admin', 'warehouse', 'supervisor', 'office'));
grant select on purchase_order_bill_pending_payments to app_client;

create or replace function record_pending_bill_payment(
  p_bill bigint, p_amount numeric, p_expected_on date
) returns purchase_order_bill_pending_payments
language plpgsql security definer as $$
declare out_ purchase_order_bill_pending_payments;
begin
  perform require_role('admin', 'warehouse', 'office');
  if coalesce(p_amount, 0) <= 0 then
    raise exception 'How much is expected?';
  end if;
  if p_expected_on is null then
    raise exception 'When is it expected?';
  end if;
  if not exists (select 1 from purchase_order_bills where id = p_bill) then
    raise exception 'There is no bill with that number.';
  end if;

  insert into purchase_order_bill_pending_payments (bill_id, amount, expected_on)
  values (p_bill, p_amount, p_expected_on)
  returning * into out_;

  return out_;
end;
$$;
alter function record_pending_bill_payment(bigint, numeric, date)
  set search_path = public, extensions;
grant execute on function record_pending_bill_payment(bigint, numeric, date) to app_client;

create or replace function remove_pending_bill_payment(p_id bigint) returns void
language plpgsql security definer as $$
begin
  perform require_role('admin', 'warehouse', 'office');
  delete from purchase_order_bill_pending_payments where id = p_id;
  if not found then raise exception 'There is no such pending payment.'; end if;
end;
$$;
alter function remove_pending_bill_payment(bigint) set search_path = public, extensions;
grant execute on function remove_pending_bill_payment(bigint) to app_client;

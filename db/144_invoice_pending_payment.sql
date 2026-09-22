-- ============================================================================
-- MS BEAU AVE — a payment promised, not yet a payment made
--
-- Purchase order bills already have this (135_pending_bill_payment.sql): a
-- note that the supplier said "the 15th," kept beside the ledger without
-- touching it. Invoices get the same thing, for the same reason — a reseller
-- says money is coming and nobody wants to be the one who forgot. It never
-- touches paid, balance, or Standing; it becomes real money the ordinary way,
-- by recording an actual payment when it lands.
-- ============================================================================

create table if not exists invoice_pending_payments (
  id          bigint generated always as identity primary key,
  invoice_id  bigint not null references invoices (id) on delete cascade,
  amount      numeric(12,2) not null check (amount > 0),
  expected_on date not null,
  created_at  timestamptz not null default now(),
  created_by  text not null default current_actor()
);
create index if not exists invoice_pending_payments_by_invoice
  on invoice_pending_payments (invoice_id);

alter table invoice_pending_payments enable row level security;
drop policy if exists orderdesk_reads_invoice_pending_payments on invoice_pending_payments;
create policy orderdesk_reads_invoice_pending_payments
  on invoice_pending_payments for select
  using (current_role_name() in ('admin', 'orderdesk'));
grant select on invoice_pending_payments to app_client;

create or replace function record_pending_invoice_payment(
  p_invoice bigint, p_amount numeric, p_expected_on date
) returns invoice_pending_payments
language plpgsql security definer as $$
declare out_ invoice_pending_payments;
begin
  perform require_role('admin', 'orderdesk');
  if coalesce(p_amount, 0) <= 0 then
    raise exception 'How much is expected?';
  end if;
  if p_expected_on is null then
    raise exception 'When is it expected?';
  end if;
  if not exists (select 1 from invoices where id = p_invoice) then
    raise exception 'There is no invoice with that number.';
  end if;

  insert into invoice_pending_payments (invoice_id, amount, expected_on)
  values (p_invoice, p_amount, p_expected_on)
  returning * into out_;

  return out_;
end;
$$;
alter function record_pending_invoice_payment(bigint, numeric, date)
  set search_path = public, extensions;
grant execute on function record_pending_invoice_payment(bigint, numeric, date) to app_client;

create or replace function remove_pending_invoice_payment(p_id bigint) returns void
language plpgsql security definer as $$
begin
  perform require_role('admin', 'orderdesk');
  delete from invoice_pending_payments where id = p_id;
  if not found then raise exception 'There is no such pending payment.'; end if;
end;
$$;
alter function remove_pending_invoice_payment(bigint) set search_path = public, extensions;
grant execute on function remove_pending_invoice_payment(bigint) to app_client;

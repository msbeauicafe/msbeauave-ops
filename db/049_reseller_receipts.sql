-- ============================================================================
-- MS BEAU AVE — the OR for a reseller's bank payment
--
-- Every order placed at the counter or online gets a receipt the moment it is
-- paid, from the same 'OR-YYYYMMDD-NNNNN' series. A reseller's order settled
-- by bank transfer never got one: pay_reseller_account applies the money and
-- says nothing more. That was fine while the only record anyone needed was
-- the ledger, but a reseller who pays over Messenger expects the same thing
-- back that a walk-in gets handed at the counter — a receipt number, not a
-- silent balance update.
--
-- One bank transfer can settle more than one open invoice at once, the same
-- way pay_reseller_account already applies it — oldest invoice first, any
-- remainder held as credit. So the receipt is not a row next to a single
-- order the way `sales` is; it is its own record of one payment event,
-- carrying the same invoice-by-invoice breakdown pay_reseller_account always
-- returned, so the paper trail says which invoices this OR actually covered.
-- ============================================================================

create table reseller_receipts (
  id          bigint generated always as identity primary key,
  receipt_no  text   not null unique,
  reseller_id bigint not null references resellers (id),
  amount      numeric(12,2) not null check (amount > 0),
  applied     jsonb  not null,
  credited    numeric(12,2) not null default 0,
  paid_on     date   not null,
  issued_by   text   not null default current_actor(),
  at          timestamptz not null default now()
);
create trigger reseller_receipts_audit after insert or update or delete on reseller_receipts
  for each row execute function write_audit();

alter table reseller_receipts enable row level security;
create policy admin_reads_receipts on reseller_receipts for select
  using (current_role_name() = 'admin');
create policy reseller_reads_own_receipts on reseller_receipts for select
  using (current_role_name() = 'reseller' and reseller_id = current_reseller());

grant select on reseller_receipts to app_client;

-- pay_reseller_account, unchanged, does the applying; this wraps it with the
-- one thing it deliberately never did — putting a number on the payment.
create or replace function issue_reseller_receipt(
  p_reseller bigint, p_amount numeric, p_paid_on date default current_date
) returns jsonb
language plpgsql security definer as $$
declare
  v_result  jsonb;
  v_receipt text;
begin
  perform require_role('admin');
  v_result := pay_reseller_account(p_reseller, p_amount, p_paid_on);

  v_receipt := 'OR-' || to_char(now() at time zone 'Asia/Manila', 'YYYYMMDD')
               || '-' || lpad(nextval('receipt_counter')::text, 5, '0');

  insert into reseller_receipts (receipt_no, reseller_id, amount, applied, credited, paid_on)
  values (v_receipt, p_reseller, p_amount, v_result -> 'applied',
          coalesce((v_result ->> 'credited')::numeric, 0), p_paid_on);

  return v_result || jsonb_build_object('receipt_no', v_receipt);
end;
$$;

alter function issue_reseller_receipt(bigint, numeric, date) set search_path = public, extensions;
revoke all on function issue_reseller_receipt(bigint, numeric, date) from public;
grant execute on function issue_reseller_receipt(bigint, numeric, date) to app_client;

-- Invoice tab's own Record payment dialog: an overpayment split off this
-- invoice does not only ever become idle account credit — pay_reseller_account
-- pays down whatever else is open, oldest first, before anything is left to
-- sit as credit at all. That is correct and stays exactly as it is; nothing
-- here changes it. But it meant the money could vanish from this dialog's own
-- Funds log entirely — applied straight to some other invoice, with nothing
-- in reseller_credits (a credit ledger, not a payment-destination ledger) to
-- show for it, and no earlier screen asked for one.
--
-- This is this one dialog's own record of where an overflow actually went:
-- which invoice it came from (the one being paid here) and which invoice, if
-- any, ended up absorbing it. Written only from Invoice tab's own Record
-- payment save, read only by that same dialog's own Funds log — reseller_credits,
-- pay_reseller_account and confirm_reseller_payment are untouched, and every
-- other screen that already depends on them keeps meaning what it always meant.

create table invoice_payment_overflow (
  id                 bigint generated always as identity primary key,
  reseller_id        bigint not null references resellers (id),
  source_invoice_id  bigint not null references invoices (id),
  -- Null: nothing was open to put it against, so it sits as plain account
  -- credit instead — same as a reseller_credits row with nothing yet to draw
  -- it down.
  target_invoice_id  bigint references invoices (id),
  amount             numeric(12,2) not null check (amount > 0),
  recorded_by        text not null default current_actor(),
  at                 timestamptz not null default now()
);
create index invoice_payment_overflow_by_reseller on invoice_payment_overflow (reseller_id);
create trigger invoice_payment_overflow_audit after insert or update or delete
  on invoice_payment_overflow for each row execute function write_audit();

alter table invoice_payment_overflow enable row level security;
create policy admin_reads_invoice_payment_overflow on invoice_payment_overflow for select
  using (current_role_name() in ('admin', 'observer', 'orderdesk'));
create policy reseller_reads_own_invoice_payment_overflow on invoice_payment_overflow for select
  using (current_role_name() = 'reseller' and reseller_id = current_reseller());
grant select on invoice_payment_overflow to app_client;

create or replace function log_invoice_payment_overflow(
  p_reseller bigint, p_source bigint, p_target bigint, p_amount numeric
) returns bigint
language plpgsql security definer as $$
declare v_id bigint;
begin
  perform require_role('admin', 'orderdesk');
  if p_amount <= 0 then raise exception 'Nothing to log.'; end if;
  insert into invoice_payment_overflow (reseller_id, source_invoice_id, target_invoice_id, amount)
  values (p_reseller, p_source, p_target, p_amount)
  returning id into v_id;
  return v_id;
end;
$$;
alter function log_invoice_payment_overflow(bigint, bigint, bigint, numeric)
  set search_path = public, extensions;
grant execute on function log_invoice_payment_overflow(bigint, bigint, bigint, numeric) to app_client;

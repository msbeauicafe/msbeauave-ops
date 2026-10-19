-- Warehouse receiving management's Goods receipt & inspection form: each
-- receiving form's paperwork and checks — the supplier's DR and invoice
-- numbers, the inspection (For inspection, Approved, Discrepancy) and the
-- accounting document check (Pending, Verified, On-hold), with a note. Kept
-- in a table of its own beside the form, so the receiving form itself, and
-- Warehouse receiving's screen that also lists it, are not touched: a form
-- with no row here is simply For inspection and Pending.

create table if not exists receiving_form_checks (
  rf_id        bigint primary key references receiving_forms (id) on delete cascade,
  dr_no        text,
  invoice_no   text,
  inspection   text not null default 'for_inspection'
               check (inspection in ('for_inspection', 'approved', 'discrepancy')),
  accounting   text not null default 'pending' check (accounting in ('pending', 'verified', 'on_hold')),
  note         text,
  updated_by   text not null default current_actor(),
  updated_at   timestamptz not null default now()
);
alter table receiving_form_checks enable row level security;
revoke all on receiving_form_checks from public;

drop policy if exists stock_reads_receiving_form_checks on receiving_form_checks;
create policy stock_reads_receiving_form_checks on receiving_form_checks for select
  using (current_role_name() in ('admin', 'warehouse', 'supervisor', 'office'));
grant select on receiving_form_checks to app_client;

-- Record a form's DR and invoice numbers, its inspection and its accounting
-- check: the people who receive (admin, warehouse) and the office, which
-- checks the documents.
create or replace function save_receiving_check(p_rf bigint, p jsonb) returns void
language plpgsql security definer as $$
declare
  v_insp text := coalesce(nullif(p ->> 'inspection', ''), 'for_inspection');
  v_acct text := coalesce(nullif(p ->> 'accounting', ''), 'pending');
begin
  perform require_role('admin', 'warehouse', 'office');
  if v_insp not in ('for_inspection', 'approved', 'discrepancy') then
    raise exception 'Pick the inspection status from the list.';
  end if;
  if v_acct not in ('pending', 'verified', 'on_hold') then
    raise exception 'Pick the accounting status from the list.';
  end if;
  if not exists (select 1 from receiving_forms where id = p_rf) then
    raise exception 'There is no such receiving form.';
  end if;
  insert into receiving_form_checks (rf_id, dr_no, invoice_no, inspection, accounting, note)
  values (p_rf, nullif(btrim(p ->> 'dr_no'), ''), nullif(btrim(p ->> 'invoice_no'), ''), v_insp, v_acct,
          nullif(btrim(p ->> 'note'), ''))
  on conflict (rf_id) do update
     set dr_no = excluded.dr_no, invoice_no = excluded.invoice_no, inspection = excluded.inspection,
         accounting = excluded.accounting, note = excluded.note,
         updated_by = current_actor(), updated_at = now();
end;
$$;
alter function save_receiving_check(bigint, jsonb) set search_path = public, extensions;
revoke all on function save_receiving_check(bigint, jsonb) from public;
grant execute on function save_receiving_check(bigint, jsonb) to app_client;

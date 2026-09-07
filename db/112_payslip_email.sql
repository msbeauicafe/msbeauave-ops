-- ============================================================================
-- MS BEAU AVE — sending a payslip
--
-- The office already prints these and already saves them one picture at a
-- time. What it could not do was hand one to the person it belongs to without
-- leaving the screen, which is the whole point of the Payroll menu.
--
-- Who sends is settled: whichever of HR or the operations manager has attached
-- their own mailbox to the deployment is the sender, and their name is on it.
-- The mailbox itself is never kept here — a password does not belong in a
-- table that half the office can read. It lives in the hosting environment,
-- and this file only records that a slip went out.
--
-- The record is the point. "Did she get her August payslip" is a question
-- somebody will ask in November, and a sent folder on one person's laptop is
-- not an answer the company owns.
-- ============================================================================

create table if not exists payslip_emails (
  id          bigint generated always as identity primary key,
  period_id   bigint not null references payroll_periods (id) on delete cascade,
  employee_id bigint not null references employees (id) on delete cascade,
  sent_to     text not null,
  sent_from   text not null,
  sent_at     timestamptz not null default now(),
  sent_by     text not null default current_actor()
);
create index if not exists payslip_emails_by_slip
  on payslip_emails (period_id, employee_id);

alter table payslip_emails enable row level security;
drop policy if exists office_reads_payslip_emails on payslip_emails;
create policy office_reads_payslip_emails on payslip_emails for select
  using (current_role_name() in ('admin', 'office'));
grant select on payslip_emails to app_client;

-- Written after the mail server has accepted the message, never before. A row
-- here means it left the building; it cannot promise anybody read it.
create or replace function record_payslip_email(p_period bigint, p_employee bigint,
                                                p_to text, p_from text)
returns void language plpgsql security definer as $$
begin
  perform require_role('admin', 'office');
  insert into payslip_emails (period_id, employee_id, sent_to, sent_from)
  values (p_period, p_employee, lower(btrim(p_to)), lower(btrim(p_from)));
end;
$$;

alter function record_payslip_email(bigint, bigint, text, text)
  set search_path = public, extensions;
grant execute on function record_payslip_email(bigint, bigint, text, text) to app_client;

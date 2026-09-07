-- ============================================================================
-- MS BEAU AVE — a payroll period
--
-- The shop pays twice a month: the 26th to the 10th, paid on the 15th, and the
-- 11th to the 25th, paid at month end. A period is opened, its lines are filled
-- from what the clock recorded, the office corrects what the clock got wrong,
-- and then it is closed — after which the figures are the record of what was
-- paid and stop moving.
--
-- Each company runs its own period. MS Beau and BOA are paid separately and
-- neither should ever appear on the other's summary.
--
-- A line holds only what is counted: days, hours, minutes. Every peso figure on
-- it is worked out from the person's daily rate at the moment the period is
-- opened — kept on the line, because a rate that changes in November must not
-- quietly rewrite what August paid.
-- ============================================================================

create table if not exists payroll_periods (
  id          bigint generated always as identity primary key,
  company     text not null check (company in ('MS BEAU', 'BOA')),
  starts_on   date not null,
  ends_on     date not null,
  paid_on     date not null,
  status      text not null default 'open' check (status in ('open', 'closed')),
  closed_at   timestamptz,
  closed_by   text,
  created_at  timestamptz not null default now(),
  created_by  text not null default current_actor(),

  constraint period_ends_after_it_starts check (ends_on >= starts_on)
);
create unique index if not exists payroll_one_per_cutoff
  on payroll_periods (company, starts_on, ends_on);

create table if not exists payroll_lines (
  id            bigint generated always as identity primary key,
  period_id     bigint not null references payroll_periods (id) on delete cascade,
  employee_id   bigint not null references employees (id),
  -- The rate this line was worked out at, frozen when the period was opened.
  daily_rate    numeric(12,4) not null default 0,
  -- What was counted.
  days_present  numeric(6,2)  not null default 0,
  nsd_hours     numeric(8,2)  not null default 0,
  ot_hours      numeric(8,2)  not null default 0,
  holidays      numeric(6,2)  not null default 0,
  spe_holidays  numeric(6,2)  not null default 0,
  leave_days    numeric(6,2)  not null default 0,
  late_minutes  numeric(8,2)  not null default 0,
  -- What was typed rather than counted.
  allowance     numeric(12,2) not null default 0,
  adjustment    numeric(12,2) not null default 0,
  sss           numeric(12,2) not null default 0,
  philhealth    numeric(12,2) not null default 0,
  pagibig       numeric(12,2) not null default 0,
  loans         numeric(12,2) not null default 0,
  note          text,

  constraint one_line_per_person unique (period_id, employee_id)
);
create index if not exists payroll_lines_by_period on payroll_lines (period_id);

alter table payroll_periods enable row level security;
alter table payroll_lines   enable row level security;
drop policy if exists office_reads_periods on payroll_periods;
drop policy if exists office_reads_lines   on payroll_lines;
create policy office_reads_periods on payroll_periods for select
  using (current_role_name() in ('admin', 'office'));
create policy office_reads_lines on payroll_lines for select
  using (current_role_name() in ('admin', 'office'));
grant select on payroll_periods, payroll_lines to app_client;

-- ---------------------------------------------------------------------------
-- The arithmetic, in one place
--
-- Every figure a payslip prints, derived from the line and the rate frozen on
-- it. Nothing here is stored: a stored total is a total that can disagree with
-- the numbers it came from.
-- ---------------------------------------------------------------------------
create or replace view payroll_summary as
select l.id, l.period_id, p.company, p.starts_on, p.ends_on, p.paid_on, p.status,
       l.employee_id, e.name, e.position, l.daily_rate,
       l.days_present, l.nsd_hours, l.ot_hours, l.holidays, l.spe_holidays,
       l.leave_days, l.late_minutes, l.allowance, l.adjustment,
       l.sss, l.philhealth, l.pagibig, l.loans, l.note,

       round(l.daily_rate / 8, 4)          as hourly_rate,
       round(l.daily_rate / 8 * 1.25, 4)   as ot_rate,
       round(l.daily_rate / 8 * 0.10, 4)   as nsd_rate,
       round(l.daily_rate / 480, 6)        as minute_rate,
       round(l.daily_rate * 0.30, 4)       as spe_rate,

       round(l.daily_rate * l.days_present, 2)                as basic,
       round(l.daily_rate / 8 * 0.10 * l.nsd_hours, 2)        as nsd,
       round(l.daily_rate / 8 * 1.25 * l.ot_hours, 2)         as overtime,
       round(l.daily_rate * l.holidays, 2)                    as holiday,
       round(l.daily_rate * 0.30 * l.spe_holidays, 2)         as spe_holiday,
       round(l.daily_rate * l.leave_days, 2)                  as leave_pay,
       round(l.daily_rate / 480 * l.late_minutes, 2)          as late_charge,

       round(l.daily_rate * l.days_present
           + l.daily_rate / 8 * 0.10 * l.nsd_hours
           + l.daily_rate / 8 * 1.25 * l.ot_hours
           + l.daily_rate * l.holidays
           + l.daily_rate * 0.30 * l.spe_holidays
           + l.daily_rate * l.leave_days
           + l.allowance + l.adjustment, 2)                   as total_earnings,

       round(l.daily_rate / 480 * l.late_minutes
           + l.sss + l.philhealth + l.pagibig + l.loans, 2)    as total_deductions,

       round(l.daily_rate * l.days_present
           + l.daily_rate / 8 * 0.10 * l.nsd_hours
           + l.daily_rate / 8 * 1.25 * l.ot_hours
           + l.daily_rate * l.holidays
           + l.daily_rate * 0.30 * l.spe_holidays
           + l.daily_rate * l.leave_days
           + l.allowance + l.adjustment
           - l.daily_rate / 480 * l.late_minutes
           - l.sss - l.philhealth - l.pagibig - l.loans, 2)    as net_pay
  from payroll_lines l
  join payroll_periods p on p.id = l.period_id
  join employees e on e.id = l.employee_id;

grant select on payroll_summary to app_client;

-- ---------------------------------------------------------------------------
-- Opening a period
--
-- One line per person on that company's payroll, each carrying the rate and the
-- contributions as they stand today, and the days the clock recorded. What the
-- clock got wrong the office corrects on the line; what it got right nobody has
-- to type at all.
-- ---------------------------------------------------------------------------
create or replace function open_payroll(
  p_company text, p_from date, p_to date, p_paid date
) returns bigint
language plpgsql security definer as $$
declare v_id bigint;
begin
  perform require_role('admin', 'office');
  if coalesce(p_company, '') not in ('MS BEAU', 'BOA') then
    raise exception 'A payroll period belongs to MS Beau or to BOA.';
  end if;
  if p_to < p_from then
    raise exception 'A period cannot end before it starts.';
  end if;
  if exists (select 1 from payroll_periods
              where company = p_company and starts_on = p_from and ends_on = p_to) then
    raise exception 'That cutoff is already open for %.', p_company;
  end if;

  insert into payroll_periods (company, starts_on, ends_on, paid_on)
  values (p_company, p_from, p_to, coalesce(p_paid, p_to + 5))
  returning id into v_id;

  insert into payroll_lines (period_id, employee_id, daily_rate,
                             days_present, sss, philhealth, pagibig)
  select v_id, e.id, e.daily_rate,
         coalesce((select count(distinct sh.business_date)
                     from shifts sh
                    where sh.employee_id = e.id
                      and sh.business_date between p_from and p_to), 0),
         e.sss, e.philhealth, e.pagibig
    from employees e
   where e.company = p_company
     and e.ended_on is null;

  return v_id;
end;
$$;

-- What was counted, corrected. Only on an open period: a closed one is the
-- record of what was paid.
create or replace function save_payroll_line(
  p_id bigint, p_fields jsonb
) returns void
language plpgsql security definer as $$
declare v_status text;
begin
  perform require_role('admin', 'office');
  select p.status into v_status
    from payroll_lines l join payroll_periods p on p.id = l.period_id
   where l.id = p_id;
  if not found then raise exception 'There is no such payroll line.'; end if;
  if v_status <> 'open' then
    raise exception 'This period is closed; its figures are what was paid.';
  end if;

  update payroll_lines set
    days_present = coalesce((p_fields ->> 'days_present')::numeric, days_present),
    nsd_hours    = coalesce((p_fields ->> 'nsd_hours')::numeric,    nsd_hours),
    ot_hours     = coalesce((p_fields ->> 'ot_hours')::numeric,     ot_hours),
    holidays     = coalesce((p_fields ->> 'holidays')::numeric,     holidays),
    spe_holidays = coalesce((p_fields ->> 'spe_holidays')::numeric, spe_holidays),
    leave_days   = coalesce((p_fields ->> 'leave_days')::numeric,   leave_days),
    late_minutes = coalesce((p_fields ->> 'late_minutes')::numeric, late_minutes),
    allowance    = coalesce((p_fields ->> 'allowance')::numeric,    allowance),
    adjustment   = coalesce((p_fields ->> 'adjustment')::numeric,   adjustment),
    sss          = coalesce((p_fields ->> 'sss')::numeric,          sss),
    philhealth   = coalesce((p_fields ->> 'philhealth')::numeric,   philhealth),
    pagibig      = coalesce((p_fields ->> 'pagibig')::numeric,      pagibig),
    loans        = coalesce((p_fields ->> 'loans')::numeric,        loans),
    daily_rate   = coalesce((p_fields ->> 'daily_rate')::numeric,   daily_rate),
    note         = coalesce(nullif(btrim(p_fields ->> 'note'), ''), note)
  where id = p_id;
end;
$$;

create or replace function close_payroll(p_id bigint) returns void
language plpgsql security definer as $$
begin
  perform require_role('admin');
  update payroll_periods
     set status = 'closed', closed_at = now(), closed_by = current_actor()
   where id = p_id and status = 'open';
  if not found then
    raise exception 'That period is not open.';
  end if;
end;
$$;

create or replace function reopen_payroll(p_id bigint) returns void
language plpgsql security definer as $$
begin
  perform require_role('admin');
  update payroll_periods
     set status = 'open', closed_at = null, closed_by = null
   where id = p_id and status = 'closed';
  if not found then raise exception 'That period is not closed.'; end if;
end;
$$;

create or replace function remove_payroll(p_id bigint) returns void
language plpgsql security definer as $$
declare v_status text;
begin
  perform require_role('admin');
  select status into v_status from payroll_periods where id = p_id;
  if not found then raise exception 'There is no such payroll period.'; end if;
  if v_status = 'closed' then
    raise exception 'REMOVE_BLOCKED: a closed period is the record of what was paid and cannot be removed.';
  end if;
  delete from payroll_periods where id = p_id;
end;
$$;

alter function open_payroll(text, date, date, date)  set search_path = public, extensions;
alter function save_payroll_line(bigint, jsonb)      set search_path = public, extensions;
alter function close_payroll(bigint)                 set search_path = public, extensions;
alter function reopen_payroll(bigint)                set search_path = public, extensions;
alter function remove_payroll(bigint)                set search_path = public, extensions;
grant execute on function open_payroll(text, date, date, date)  to app_client;
grant execute on function save_payroll_line(bigint, jsonb)      to app_client;
grant execute on function close_payroll(bigint)                 to app_client;
grant execute on function reopen_payroll(bigint)                to app_client;
grant execute on function remove_payroll(bigint)                to app_client;

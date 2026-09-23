-- Hourly joins daily and monthly as a real third way of being paid, not a
-- label painted over daily math. Basic for an hourly person is the hours the
-- clock counted on this cutoff times what they are worth an hour — the same
-- shape as a monthly person's half-a-month, worked out from its own rate
-- rather than borrowed from daily_rate.
--
-- Everything overtime, night differential, lateness and holiday pay are
-- reckoned from is still a single daily-equivalent rate, the same "rate" a
-- monthly person's salary already turns into for those same figures — an
-- hourly person's is their hourly rate times an eight-hour day, so the /8
-- and /480 arithmetic already in payroll_summary reaches their hourly rate
-- back out untouched.

alter table employees drop constraint if exists employees_pay_basis_check;
alter table employees add constraint employees_pay_basis_check
  check (pay_basis in ('daily', 'monthly', 'hourly'));

alter table payroll_lines drop constraint if exists payroll_lines_pay_basis_check;
alter table payroll_lines add constraint payroll_lines_pay_basis_check
  check (pay_basis in ('daily', 'monthly', 'hourly'));

alter table payroll_lines add column if not exists hours_present numeric(8,2) not null default 0;

create or replace function set_pay_details(
  p_id bigint, p_company text, p_daily numeric,
  p_sss numeric, p_philhealth numeric, p_pagibig numeric,
  p_basis text default 'daily', p_monthly numeric default 0, p_hourly numeric default 0
) returns void
language plpgsql security definer as $$
declare v_basis text;
begin
  perform require_role('admin', 'office', 'hr');
  if coalesce(p_company, '') not in ('MS BEAU', 'BOA') then
    raise exception 'A person is paid by MS Beau or by BOA.';
  end if;
  v_basis := lower(btrim(coalesce(p_basis, 'daily')));
  if v_basis not in ('daily', 'monthly', 'hourly') then
    raise exception 'Somebody is paid daily, monthly, or by the hour.';
  end if;
  update employees
     set company      = p_company,
         pay_basis    = v_basis,
         -- The rate that is not theirs is cleared rather than left lying about
         -- to be read by mistake a year from now.
         daily_rate   = case when v_basis = 'daily'
                             then greatest(coalesce(p_daily, 0), 0) else 0 end,
         monthly_rate = case when v_basis = 'monthly'
                             then greatest(coalesce(p_monthly, 0), 0) else 0 end,
         hourly_rate  = case when v_basis = 'hourly'
                             then greatest(coalesce(p_hourly, 0), 0) else 0 end,
         sss          = greatest(coalesce(p_sss, 0), 0),
         philhealth   = greatest(coalesce(p_philhealth, 0), 0),
         pagibig      = greatest(coalesce(p_pagibig, 200), 0)
   where id = p_id;
  if not found then raise exception 'No such person.'; end if;
end;
$$;

alter function set_pay_details(bigint, text, numeric, numeric, numeric, numeric, text, numeric, numeric)
  set search_path = public, extensions;
grant execute on function set_pay_details(bigint, text, numeric, numeric, numeric, numeric, text, numeric, numeric)
  to app_client;
drop function if exists set_pay_details(bigint, text, numeric, numeric, numeric, numeric, text, numeric);

-- An hourly person's hours are counted from the clock exactly as a daily
-- person's days are — the actual time between clocking in and out, summed
-- over the cutoff — rather than typed in blind.
create or replace function open_payroll(
  p_company text, p_from date, p_to date, p_paid date
) returns bigint
language plpgsql security definer as $$
declare v_id bigint; v_paid_30th boolean; v_paid_on date; r record;
begin
  perform require_role('admin', 'office', 'hr');
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

  v_paid_30th := extract(day from p_to) > 15;
  v_paid_on := coalesce(p_paid, p_to + 5);

  insert into payroll_periods (company, starts_on, ends_on, paid_on)
  values (p_company, p_from, p_to, v_paid_on)
  returning id into v_id;

  insert into payroll_lines (period_id, employee_id, daily_rate, pay_basis, monthly_rate,
                             hourly_rate, days_present, hours_present, sss, philhealth, pagibig)
  select v_id, e.id, e.daily_rate, e.pay_basis, e.monthly_rate, e.hourly_rate,
         coalesce((select count(distinct sh.business_date)
                     from shifts sh
                    where sh.employee_id = e.id
                      and sh.business_date between p_from and p_to), 0),
         coalesce((select round(extract(epoch from
                              sum(coalesce(sh.ended_at, now()) - sh.started_at)) / 3600, 2)
                     from shifts sh
                    where sh.employee_id = e.id
                      and sh.business_date between p_from and p_to), 0),
         case when v_paid_30th then e.sss else 0 end,
         case when v_paid_30th then 0 else e.philhealth end,
         case when v_paid_30th then 0 else e.pagibig end
    from employees e
   where e.company = p_company
     and e.ended_on is null;

  for r in
    select e.id as employee_id, a.id as advance_id,
           least(a.per_cutoff, a.principal - coalesce(paid.amt, 0)) as take
      from employees e
      join advances a on a.employee_id = e.id
      left join lateral (
        select sum(p.amount) as amt from advance_payments p where p.advance_id = a.id
      ) paid on true
     where e.company = p_company
       and e.ended_on is null
       and a.per_cutoff > 0
       and a.principal - coalesce(paid.amt, 0) > 0
       and a.started_on <= v_paid_on
  loop
    insert into advance_payments (advance_id, amount, paid_on, period_id, note)
    values (r.advance_id, r.take, v_paid_on, v_id, 'Automatic — taken when the cutoff opened');
    update payroll_lines set loans = loans + r.take
     where period_id = v_id and employee_id = r.employee_id;
  end loop;

  return v_id;
end;
$$;
alter function open_payroll(text, date, date, date) set search_path = public, extensions;

drop view if exists payroll_summary;

create view payroll_summary as
with line as (
  select l.*,
         case when l.pay_basis = 'monthly' then round(l.monthly_rate / days_in_a_month(), 4)
              when l.pay_basis = 'hourly'  then round(l.hourly_rate * 8, 4)
              else l.daily_rate end as rate
    from payroll_lines l
)
select l.id, l.period_id, p.company, p.starts_on, p.ends_on, p.paid_on, p.status,
       l.employee_id, e.name, e.position,
       l.pay_basis, l.monthly_rate, l.rate as daily_rate, l.hourly_rate,
       l.days_present, l.hours_present, l.nsd_hours, l.ot_hours, l.holidays, l.spe_holidays,
       l.leave_days, l.late_minutes, l.allowance, l.adjustment,
       l.sss, l.philhealth, l.pagibig, l.loans, l.note,
       round(l.rate / 8, 4)          as hourly_equivalent,
       round(l.rate / 8 * 1.25, 4)   as ot_rate,
       round(l.rate / 8 * 0.10, 4)   as nsd_rate,
       round(l.rate / 480, 6)        as minute_rate,
       round(l.rate * 0.30, 4)       as spe_rate,
       case when l.pay_basis = 'monthly' then round(l.monthly_rate / 2, 2)
            when l.pay_basis = 'hourly'  then round(l.hourly_rate * l.hours_present, 2)
            else round(l.rate * l.days_present, 2) end          as basic,
       round(l.rate / 8 * 0.10 * l.nsd_hours, 2)                as nsd,
       round(l.rate / 8 * 1.25 * l.ot_hours, 2)                 as overtime,
       round(l.rate * l.holidays, 2)                            as holiday,
       round(l.rate * 0.30 * l.spe_holidays, 2)                 as spe_holiday,
       round(l.rate * l.leave_days, 2)                          as leave_pay,
       round(l.rate / 480 * l.late_minutes, 2)                  as late_charge,

       loan_taken(l.period_id, l.employee_id, 'ca',      null) as ca_taken,
       loan_taken(l.period_id, l.employee_id, 'pagibig', null) as pagibig_loan,
       loan_taken(l.period_id, l.employee_id, 'sss',     null) as sss_loan,
       loan_taken(l.period_id, l.employee_id, 'pagibig', 'salary')     as pagibig_salary,
       loan_taken(l.period_id, l.employee_id, 'pagibig', 'calamity')   as pagibig_calamity,
       loan_taken(l.period_id, l.employee_id, 'pagibig', 'short term') as pagibig_short,
       loan_taken(l.period_id, l.employee_id, 'sss',     'salary')     as sss_salary,
       loan_taken(l.period_id, l.employee_id, 'sss',     'emergency')  as sss_emergency,
       loan_taken(l.period_id, l.employee_id, 'sss',     'calamity')   as sss_calamity,
       loan_taken(l.period_id, l.employee_id, 'pagibig', null)
         - loan_taken(l.period_id, l.employee_id, 'pagibig', 'salary')
         - loan_taken(l.period_id, l.employee_id, 'pagibig', 'calamity')
         - loan_taken(l.period_id, l.employee_id, 'pagibig', 'short term') as pagibig_other,
       loan_taken(l.period_id, l.employee_id, 'sss', null)
         - loan_taken(l.period_id, l.employee_id, 'sss', 'salary')
         - loan_taken(l.period_id, l.employee_id, 'sss', 'emergency')
         - loan_taken(l.period_id, l.employee_id, 'sss', 'calamity')      as sss_other,

       round((case when l.pay_basis = 'monthly' then l.monthly_rate / 2
                   when l.pay_basis = 'hourly'  then l.hourly_rate * l.hours_present
                   else l.rate * l.days_present end)
           + l.rate / 8 * 0.10 * l.nsd_hours
           + l.rate / 8 * 1.25 * l.ot_hours
           + l.rate * l.holidays
           + l.rate * 0.30 * l.spe_holidays
           + l.rate * l.leave_days
           + l.allowance + l.adjustment, 2)                   as total_earnings,
       round(l.rate / 480 * l.late_minutes
           + l.sss + l.philhealth + l.pagibig + l.loans, 2)    as total_deductions,
       round((case when l.pay_basis = 'monthly' then l.monthly_rate / 2
                   when l.pay_basis = 'hourly'  then l.hourly_rate * l.hours_present
                   else l.rate * l.days_present end)
           + l.rate / 8 * 0.10 * l.nsd_hours
           + l.rate / 8 * 1.25 * l.ot_hours
           + l.rate * l.holidays
           + l.rate * 0.30 * l.spe_holidays
           + l.rate * l.leave_days
           + l.allowance + l.adjustment
           - l.rate / 480 * l.late_minutes
           - l.sss - l.philhealth - l.pagibig - l.loans, 2)    as net_pay
  from line l
  join payroll_periods p on p.id = l.period_id
  join employees e on e.id = l.employee_id;

grant select on payroll_summary to app_client;

create or replace function save_payroll_line(
  p_id bigint, p_fields jsonb
) returns void
language plpgsql security definer as $$
declare v_status text;
begin
  perform require_role('admin', 'office', 'hr');
  select p.status into v_status
    from payroll_lines l join payroll_periods p on p.id = l.period_id
   where l.id = p_id;
  if not found then raise exception 'There is no such payroll line.'; end if;
  if v_status <> 'open' then
    raise exception 'This period is closed; its figures are what was paid.';
  end if;

  update payroll_lines set
    days_present  = coalesce((p_fields ->> 'days_present')::numeric,  days_present),
    hours_present = coalesce((p_fields ->> 'hours_present')::numeric, hours_present),
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
    hourly_rate  = coalesce((p_fields ->> 'hourly_rate')::numeric,  hourly_rate),
    pay_basis    = coalesce(nullif(btrim(p_fields ->> 'pay_basis'), ''), pay_basis),
    monthly_rate = coalesce((p_fields ->> 'monthly_rate')::numeric, monthly_rate),
    note         = coalesce(nullif(btrim(p_fields ->> 'note'), ''), note)
  where id = p_id;
end;
$$;

alter function save_payroll_line(bigint, jsonb) set search_path = public, extensions;

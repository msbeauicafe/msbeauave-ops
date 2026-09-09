-- ============================================================================
-- MS BEAU AVE — somebody paid monthly is paid monthly
--
-- Payroll was built on one idea: a daily rate, and everything worked out from
-- it. That is right for most of the shop and wrong for the people on a salary,
-- who had a rate of nothing and a payslip that said so. Seven of them.
--
-- So a person is paid daily or monthly, and it is said on their record rather
-- than guessed from whether a rate happens to be zero.
--
--   daily    basic is the rate times the days the clock counted.
--   monthly  basic is half the month, because a cutoff is half a month. The
--            days worked do not change it — that is what monthly means.
--
-- Overtime, night differential and lateness still need an hour and a minute to
-- price, and a salary does not name one. The shop's own convention divides a
-- month by 26 to get a day, which is the six-day week it works; that number
-- lives here, once, rather than being typed into a formula six times. Change it
-- and every derived figure moves together.
--
-- What a payroll line freezes does not change: it already keeps the rate it was
-- worked out at, so a cutoff closed last year still reads the way it was paid.
-- It keeps the basis and the monthly figure now as well, for the same reason.
-- ============================================================================

alter table employees add column if not exists pay_basis text not null default 'daily';
alter table employees drop constraint if exists employees_pay_basis_check;
alter table employees add constraint employees_pay_basis_check
  check (pay_basis in ('daily', 'monthly'));
alter table employees add column if not exists monthly_rate numeric(12,2) not null default 0;

alter table payroll_lines add column if not exists pay_basis text not null default 'daily';
alter table payroll_lines drop constraint if exists payroll_lines_pay_basis_check;
alter table payroll_lines add constraint payroll_lines_pay_basis_check
  check (pay_basis in ('daily', 'monthly'));
alter table payroll_lines add column if not exists monthly_rate numeric(12,2) not null default 0;

-- The days a month is taken to hold, for turning a salary into an hour. One
-- place, named, so the shop can argue with the number rather than with the
-- arithmetic.
create or replace function days_in_a_month() returns numeric
language sql immutable as $$ select 26::numeric $$;
alter function days_in_a_month() set search_path = public, extensions;
grant execute on function days_in_a_month() to app_client;

create or replace function set_pay_details(
  p_id bigint, p_company text, p_daily numeric,
  p_sss numeric, p_philhealth numeric, p_pagibig numeric,
  p_basis text default 'daily', p_monthly numeric default 0
) returns void
language plpgsql security definer as $$
declare v_basis text;
begin
  -- The operations manager runs payroll, so setting a rate is hers as well.
  perform require_role('admin', 'office', 'hr');
  if coalesce(p_company, '') not in ('MS BEAU', 'BOA') then
    raise exception 'A person is paid by MS Beau or by BOA.';
  end if;
  v_basis := lower(btrim(coalesce(p_basis, 'daily')));
  if v_basis not in ('daily', 'monthly') then
    raise exception 'Somebody is paid daily or monthly.';
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
         sss          = greatest(coalesce(p_sss, 0), 0),
         philhealth   = greatest(coalesce(p_philhealth, 0), 0),
         pagibig      = greatest(coalesce(p_pagibig, 200), 0)
   where id = p_id;
  if not found then raise exception 'No such person.'; end if;
end;
$$;

alter function set_pay_details(bigint, text, numeric, numeric, numeric, numeric, text, numeric)
  set search_path = public, extensions;
grant execute on function set_pay_details(bigint, text, numeric, numeric, numeric, numeric, text, numeric)
  to app_client;
drop function if exists set_pay_details(bigint, text, numeric, numeric, numeric, numeric);

-- A cutoff carries the basis and both rates, frozen like the rest.
create or replace function open_payroll(
  p_company text, p_from date, p_to date, p_paid date
) returns bigint
language plpgsql security definer as $$
declare v_id bigint;
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

  insert into payroll_periods (company, starts_on, ends_on, paid_on)
  values (p_company, p_from, p_to, coalesce(p_paid, p_to + 5))
  returning id into v_id;

  insert into payroll_lines (period_id, employee_id, daily_rate, pay_basis, monthly_rate,
                             days_present, sss, philhealth, pagibig)
  select v_id, e.id, e.daily_rate, e.pay_basis, e.monthly_rate,
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

alter function open_payroll(text, date, date, date) set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- The summary, with one rate to work from whichever way somebody is paid
-- ---------------------------------------------------------------------------
drop view if exists payroll_summary;

create view payroll_summary as
with line as (
  select l.*,
         -- What a day of this person's time is worth. A salary does not name
         -- one, so it is the month over the days the shop counts in a month —
         -- used for overtime, night hours and lateness, never for basic.
         case when l.pay_basis = 'monthly'
              then round(l.monthly_rate / days_in_a_month(), 4)
              else l.daily_rate end as rate
    from payroll_lines l
)
select l.id, l.period_id, p.company, p.starts_on, p.ends_on, p.paid_on, p.status,
       l.employee_id, e.name, e.position,
       l.pay_basis, l.monthly_rate, l.rate as daily_rate,
       l.days_present, l.nsd_hours, l.ot_hours, l.holidays, l.spe_holidays,
       l.leave_days, l.late_minutes, l.allowance, l.adjustment,
       l.sss, l.philhealth, l.pagibig, l.loans, l.note,
       round(l.rate / 8, 4)          as hourly_rate,
       round(l.rate / 8 * 1.25, 4)   as ot_rate,
       round(l.rate / 8 * 0.10, 4)   as nsd_rate,
       round(l.rate / 480, 6)        as minute_rate,
       round(l.rate * 0.30, 4)       as spe_rate,
       -- Half a month for a salary, whatever the clock counted; the rate times
       -- the days for everybody else.
       case when l.pay_basis = 'monthly' then round(l.monthly_rate / 2, 2)
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

-- The team list says how somebody is paid, so the screen does not have to guess
-- it from a rate of nothing. Appended at the end: create-or-replace refuses to
-- move a view's columns about, and the two new ones are nobody's business but
-- the pay form's.
create or replace view team as
 SELECT e.id,
    e.name,
    e."position",
    e.phone,
    e.started_on,
    e.ended_on,
    e.note,
    e.ended_on IS NULL AS here,
    e.user_id,
    u.username,
    u.role AS signs_in_as,
    ph.employee_id IS NOT NULL AS has_photo,
    s.id IS NOT NULL AS on_shift,
    s.started_at AS since,
    COALESCE(( SELECT sum(COALESCE(sh.ended_at, now()) - sh.started_at) AS sum
           FROM shifts sh
          WHERE sh.employee_id = e.id AND sh.business_date > ((now() AT TIME ZONE 'Asia/Manila'::text)::date - 7)), '00:00:00'::interval) AS hours_this_week,
    e.pin_hash IS NOT NULL AS has_pin,
    e.branch_id,
    br.name AS branch,
    ( SELECT sh.started_at
           FROM shifts sh
          WHERE sh.employee_id = e.id AND sh.business_date = (now() AT TIME ZONE 'Asia/Manila'::text)::date
          ORDER BY sh.started_at DESC
         LIMIT 1) AS today_in,
    ( SELECT sh.ended_at
           FROM shifts sh
          WHERE sh.employee_id = e.id AND sh.business_date = (now() AT TIME ZONE 'Asia/Manila'::text)::date
          ORDER BY sh.started_at DESC
         LIMIT 1) AS today_out,
    ph.updated_at AS photo_at,
    (EXISTS ( SELECT 1
           FROM employee_fingers f
          WHERE f.employee_id = e.id)) AS has_finger,
    e.company,
    e.daily_rate,
    e.sss,
    e.philhealth,
    e.pagibig,
    pay_rates(e.daily_rate) AS rates,
    e.email,
    e.pay_basis,
    e.monthly_rate
   FROM employees e
     LEFT JOIN app_users u ON u.id = e.user_id
     LEFT JOIN employee_photos ph ON ph.employee_id = e.id
     LEFT JOIN shifts s ON s.employee_id = e.id AND s.ended_at IS NULL
     JOIN branches br ON br.id = e.branch_id
  ORDER BY (e.ended_on IS NULL) DESC, e.name;
grant select on team to app_client;

-- A line's basis and monthly figure follow the same rule as its daily rate:
-- typed on an open cutoff, frozen once it closes.
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
    pay_basis    = coalesce(nullif(btrim(p_fields ->> 'pay_basis'), ''), pay_basis),
    monthly_rate = coalesce((p_fields ->> 'monthly_rate')::numeric, monthly_rate),
    note         = coalesce(nullif(btrim(p_fields ->> 'note'), ''), note)
  where id = p_id;
end;
$$;

alter function save_payroll_line(bigint, jsonb) set search_path = public, extensions;

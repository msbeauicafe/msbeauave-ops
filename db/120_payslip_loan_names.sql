-- ============================================================================
-- MS BEAU AVE — which loan came off, by name, on the payslip
--
-- The slip said Pag-IBIG Loan and SSS Loan, one line each. The shop collects
-- six: Pag-IBIG salary, calamity and short term; SSS salary, emergency and
-- calamity. Somebody paying a salary loan and a calamity loan at once read one
-- figure and had to take on trust that it was both of theirs added up.
--
-- Six figures now, each summing the payments filed under that loan for this
-- cutoff. The two family totals stay exactly as they were — they are what the
-- typed Loan/CA figure is reconciled against, and nothing that was arithmetic
-- yesterday is derived from three parts today.
--
-- A loan opened before the six existed has no type, and its money shows on its
-- family's line rather than being guessed into one of them. That is what
-- pagibig_other and sss_other carry.
-- ============================================================================

create or replace function loan_taken(p_period bigint, p_employee bigint,
                                      p_kind text, p_type text)
returns numeric language sql stable as $$
  select coalesce(sum(ap.amount), 0)::numeric(12,2)
    from advance_payments ap
    join advances a on a.id = ap.advance_id
   where ap.period_id = p_period
     and a.employee_id = p_employee
     and a.kind = p_kind
     and (p_type is null or a.loan_type is not distinct from p_type);
$$;

alter function loan_taken(bigint, bigint, text, text)
  set search_path = public, extensions;
grant execute on function loan_taken(bigint, bigint, text, text) to app_client;

drop view if exists payroll_summary;

create view payroll_summary as
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

       loan_taken(l.period_id, l.employee_id, 'ca',      null) as ca_taken,
       loan_taken(l.period_id, l.employee_id, 'pagibig', null) as pagibig_loan,
       loan_taken(l.period_id, l.employee_id, 'sss',     null) as sss_loan,

       -- The six the shop actually collects, each by name.
       loan_taken(l.period_id, l.employee_id, 'pagibig', 'salary')     as pagibig_salary,
       loan_taken(l.period_id, l.employee_id, 'pagibig', 'calamity')   as pagibig_calamity,
       loan_taken(l.period_id, l.employee_id, 'pagibig', 'short term') as pagibig_short,
       loan_taken(l.period_id, l.employee_id, 'sss',     'salary')     as sss_salary,
       loan_taken(l.period_id, l.employee_id, 'sss',     'emergency')  as sss_emergency,
       loan_taken(l.period_id, l.employee_id, 'sss',     'calamity')   as sss_calamity,
       -- Opened before the six existed, so it says only whose loan it is.
       loan_taken(l.period_id, l.employee_id, 'pagibig', null)
         - loan_taken(l.period_id, l.employee_id, 'pagibig', 'salary')
         - loan_taken(l.period_id, l.employee_id, 'pagibig', 'calamity')
         - loan_taken(l.period_id, l.employee_id, 'pagibig', 'short term') as pagibig_other,
       loan_taken(l.period_id, l.employee_id, 'sss', null)
         - loan_taken(l.period_id, l.employee_id, 'sss', 'salary')
         - loan_taken(l.period_id, l.employee_id, 'sss', 'emergency')
         - loan_taken(l.period_id, l.employee_id, 'sss', 'calamity')      as sss_other,

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

-- ============================================================================
-- MS BEAU AVE — which loan came off this cutoff
--
-- The office types one figure for Loan/CA, because that is what it is thinking
-- about while it works: how much comes off her pay. The payslip has to be
-- specific — a person reading a deduction is entitled to know whether the shop
-- took a cash advance back or passed money to Pag-IBIG — and the ledgers
-- already know, because a payment names the period it came off.
--
-- So the summary carries the three totals beside the typed figure. Whatever is
-- left over is a charge typed straight onto the line, and the slip shows it as
-- its own row rather than folding it into one of theirs.
-- ============================================================================

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
       coalesce((select sum(ap.amount) from advance_payments ap
                   join advances a on a.id = ap.advance_id
                  where ap.period_id = l.period_id
                    and a.employee_id = l.employee_id
                    and a.kind = 'ca'), 0)::numeric(12,2)      as ca_taken,
       coalesce((select sum(ap.amount) from advance_payments ap
                   join advances a on a.id = ap.advance_id
                  where ap.period_id = l.period_id
                    and a.employee_id = l.employee_id
                    and a.kind = 'pagibig'), 0)::numeric(12,2) as pagibig_loan,
       coalesce((select sum(ap.amount) from advance_payments ap
                   join advances a on a.id = ap.advance_id
                  where ap.period_id = l.period_id
                    and a.employee_id = l.employee_id
                    and a.kind = 'sss'), 0)::numeric(12,2)     as sss_loan,
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

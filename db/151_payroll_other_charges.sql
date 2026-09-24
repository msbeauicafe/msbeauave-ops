-- A charge that is neither a government contribution nor a loan off a ledger —
-- a uniform, a broken tool, whatever the office needs to take off a cutoff
-- without inventing a loan for it. Typed straight into the line, the same way
-- Loan/CA already is.

alter table payroll_lines add column if not exists other_charges numeric(12,2) not null default 0;

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
    days_present   = coalesce((p_fields ->> 'days_present')::numeric,   days_present),
    hours_present  = coalesce((p_fields ->> 'hours_present')::numeric,  hours_present),
    nsd_hours     = coalesce((p_fields ->> 'nsd_hours')::numeric,     nsd_hours),
    ot_hours      = coalesce((p_fields ->> 'ot_hours')::numeric,      ot_hours),
    holidays      = coalesce((p_fields ->> 'holidays')::numeric,      holidays),
    spe_holidays  = coalesce((p_fields ->> 'spe_holidays')::numeric,  spe_holidays),
    leave_days    = coalesce((p_fields ->> 'leave_days')::numeric,    leave_days),
    late_minutes  = coalesce((p_fields ->> 'late_minutes')::numeric,  late_minutes),
    allowance     = coalesce((p_fields ->> 'allowance')::numeric,     allowance),
    adjustment    = coalesce((p_fields ->> 'adjustment')::numeric,    adjustment),
    sss           = coalesce((p_fields ->> 'sss')::numeric,           sss),
    philhealth    = coalesce((p_fields ->> 'philhealth')::numeric,    philhealth),
    pagibig       = coalesce((p_fields ->> 'pagibig')::numeric,       pagibig),
    loans         = coalesce((p_fields ->> 'loans')::numeric,         loans),
    other_charges = coalesce((p_fields ->> 'other_charges')::numeric, other_charges),
    daily_rate    = coalesce((p_fields ->> 'daily_rate')::numeric,    daily_rate),
    hourly_rate   = coalesce((p_fields ->> 'hourly_rate')::numeric,   hourly_rate),
    pay_basis     = coalesce(nullif(btrim(p_fields ->> 'pay_basis'), ''), pay_basis),
    monthly_rate  = coalesce((p_fields ->> 'monthly_rate')::numeric,  monthly_rate),
    note          = coalesce(nullif(btrim(p_fields ->> 'note'), ''), note)
  where id = p_id;
end;
$$;

alter function save_payroll_line(bigint, jsonb) set search_path = public, extensions;

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
       l.sss, l.philhealth, l.pagibig, l.loans, l.other_charges, l.note,
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
           + l.sss + l.philhealth + l.pagibig + l.loans + l.other_charges, 2) as total_deductions,
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
           - l.sss - l.philhealth - l.pagibig - l.loans - l.other_charges, 2) as net_pay
  from line l
  join payroll_periods p on p.id = l.period_id
  join employees e on e.id = l.employee_id;

grant select on payroll_summary to app_client;

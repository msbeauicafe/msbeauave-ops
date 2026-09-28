-- The Loan box still split one figure across whatever loans happened to be
-- running, the same guessing that made Darevee's and John's split come out
-- as odd fractions tonight. A payslip already breaks a loan down by exact
-- name — SSS Salary, SSS Emergency, Pag-IBIG Calamity, and so on — so the
-- Payroll table now does too: one box per named loan, each mapped to
-- exactly one real ledger, nothing to split ever again.
--
-- Backfilled from loan_taken() itself — the same function the payslip's own
-- named breakdown already reads — so this starts from ground truth, not
-- another guess.

alter table payroll_lines add column if not exists sss_salary_amount      numeric(12,2) not null default 0;
alter table payroll_lines add column if not exists sss_emergency_amount  numeric(12,2) not null default 0;
alter table payroll_lines add column if not exists sss_calamity_amount   numeric(12,2) not null default 0;
alter table payroll_lines add column if not exists pagibig_salary_amount   numeric(12,2) not null default 0;
alter table payroll_lines add column if not exists pagibig_calamity_amount numeric(12,2) not null default 0;
alter table payroll_lines add column if not exists pagibig_short_amount    numeric(12,2) not null default 0;

update payroll_lines set
  sss_salary_amount        = loan_taken(period_id, employee_id, 'sss',     'salary'),
  sss_emergency_amount     = loan_taken(period_id, employee_id, 'sss',     'emergency'),
  sss_calamity_amount      = loan_taken(period_id, employee_id, 'sss',     'calamity'),
  pagibig_salary_amount    = loan_taken(period_id, employee_id, 'pagibig', 'salary'),
  pagibig_calamity_amount  = loan_taken(period_id, employee_id, 'pagibig', 'calamity'),
  pagibig_short_amount     = loan_taken(period_id, employee_id, 'pagibig', 'short term');

-- loan_amount is kept, now the sum of the six named boxes rather than a
-- box of its own — anything still reading "the combined loan figure"
-- keeps working unchanged.
update payroll_lines set loan_amount =
  sss_salary_amount + sss_emergency_amount + sss_calamity_amount
  + pagibig_salary_amount + pagibig_calamity_amount + pagibig_short_amount;

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
    select e.id as employee_id, a.id as advance_id, a.kind, a.loan_type,
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
       and a.started_on <= p_to
  loop
    insert into advance_payments (advance_id, amount, paid_on, period_id, note)
    values (r.advance_id, r.take, v_paid_on, v_id, 'Automatic — taken when the cutoff opened')
    on conflict (advance_id, period_id) where period_id is not null do nothing;
    update payroll_lines set
      loans = loans + r.take,
      ca_amount = ca_amount + case when r.kind = 'ca' then r.take else 0 end,
      loan_amount = loan_amount + case when r.kind <> 'ca' then r.take else 0 end,
      sss_salary_amount = sss_salary_amount
        + case when r.kind = 'sss' and r.loan_type = 'salary' then r.take else 0 end,
      sss_emergency_amount = sss_emergency_amount
        + case when r.kind = 'sss' and r.loan_type = 'emergency' then r.take else 0 end,
      sss_calamity_amount = sss_calamity_amount
        + case when r.kind = 'sss' and r.loan_type = 'calamity' then r.take else 0 end,
      pagibig_salary_amount = pagibig_salary_amount
        + case when r.kind = 'pagibig' and r.loan_type = 'salary' then r.take else 0 end,
      pagibig_calamity_amount = pagibig_calamity_amount
        + case when r.kind = 'pagibig' and r.loan_type = 'calamity' then r.take else 0 end,
      pagibig_short_amount = pagibig_short_amount
        + case when r.kind = 'pagibig' and r.loan_type = 'short term' then r.take else 0 end
     where period_id = v_id and employee_id = r.employee_id;
  end loop;

  return v_id;
end;
$$;
alter function open_payroll(text, date, date, date) set search_path = public, extensions;

-- p_loan_type is null for the CA box (a cash advance has no agency loan
-- behind it) and the exact type for every named loan box — matching the
-- same (kind, loan_type) pair advances_loan_type_check already enforces,
-- so each box now maps to exactly one advance, or is split by per-cutoff
-- share only in the unusual case of two of the very same named loan
-- running for one person at once.
create or replace function sync_payroll_box_to_ledger(
  p_line_id bigint, p_kind text, p_loan_type text, p_label text, p_amount numeric
) returns void
language plpgsql security definer as $$
declare
  v_employee bigint; v_period bigint; v_paid_on date;
  v_total_per_cutoff numeric(12,2);
  r record; v_share numeric(12,2); v_room numeric(12,2);
begin
  select l.employee_id, l.period_id, p.paid_on
    into v_employee, v_period, v_paid_on
    from payroll_lines l join payroll_periods p on p.id = l.period_id
   where l.id = p_line_id;
  if v_employee is null then return; end if;

  select coalesce(sum(a.per_cutoff), 0) into v_total_per_cutoff
    from advances a
   where a.employee_id = v_employee and a.kind = p_kind
     and a.loan_type is not distinct from p_loan_type and a.per_cutoff > 0
     and a.principal - coalesce((select sum(pmt.amount) from advance_payments pmt
                                   where pmt.advance_id = a.id
                                     and pmt.period_id is distinct from v_period), 0) > 0;

  for r in
    select a.id as advance_id, a.per_cutoff, a.principal,
           coalesce((select sum(pmt.amount) from advance_payments pmt
                       where pmt.advance_id = a.id
                         and pmt.period_id is distinct from v_period), 0) as paid_elsewhere
      from advances a
     where a.employee_id = v_employee and a.kind = p_kind
       and a.loan_type is not distinct from p_loan_type and a.per_cutoff > 0
  loop
    v_room := r.principal - r.paid_elsewhere;
    v_share := case when v_total_per_cutoff > 0
                    then round(coalesce(p_amount, 0) * r.per_cutoff / v_total_per_cutoff, 2)
                    else 0 end;
    v_share := least(v_share, greatest(v_room, 0));

    if v_share > 0 then
      insert into advance_payments (advance_id, amount, paid_on, period_id, note)
      values (r.advance_id, v_share, v_paid_on, v_period,
              'Taken — matches this cutoff''s ' || p_label || ' figure')
      on conflict (advance_id, period_id) where period_id is not null
      do update set amount = excluded.amount, paid_on = excluded.paid_on,
                    note = excluded.note;
    else
      delete from advance_payments where advance_id = r.advance_id and period_id = v_period;
    end if;
  end loop;
end;
$$;
alter function sync_payroll_box_to_ledger(bigint, text, text, text, numeric)
  set search_path = public, extensions;
drop function if exists sync_payroll_box_to_ledger(bigint, text[], text, numeric);

create or replace function save_payroll_line(
  p_id bigint, p_fields jsonb
) returns void
language plpgsql security definer as $$
declare v_status text; v_amt numeric(12,2);
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
    ca_amount               = coalesce((p_fields ->> 'ca_amount')::numeric, ca_amount),
    sss_salary_amount       = coalesce((p_fields ->> 'sss_salary_amount')::numeric, sss_salary_amount),
    sss_emergency_amount    = coalesce((p_fields ->> 'sss_emergency_amount')::numeric, sss_emergency_amount),
    sss_calamity_amount     = coalesce((p_fields ->> 'sss_calamity_amount')::numeric, sss_calamity_amount),
    pagibig_salary_amount   = coalesce((p_fields ->> 'pagibig_salary_amount')::numeric, pagibig_salary_amount),
    pagibig_calamity_amount = coalesce((p_fields ->> 'pagibig_calamity_amount')::numeric, pagibig_calamity_amount),
    pagibig_short_amount    = coalesce((p_fields ->> 'pagibig_short_amount')::numeric, pagibig_short_amount),
    other_charges = coalesce((p_fields ->> 'other_charges')::numeric, other_charges),
    daily_rate   = coalesce((p_fields ->> 'daily_rate')::numeric,   daily_rate),
    hourly_rate  = coalesce((p_fields ->> 'hourly_rate')::numeric,  hourly_rate),
    pay_basis    = coalesce(nullif(btrim(p_fields ->> 'pay_basis'), ''), pay_basis),
    monthly_rate = coalesce((p_fields ->> 'monthly_rate')::numeric, monthly_rate),
    note         = coalesce(nullif(btrim(p_fields ->> 'note'), ''), note)
  where id = p_id;

  -- loan_amount and loans stay the combined figures everything else reads.
  update payroll_lines set
    loan_amount = sss_salary_amount + sss_emergency_amount + sss_calamity_amount
      + pagibig_salary_amount + pagibig_calamity_amount + pagibig_short_amount,
    loans = ca_amount + sss_salary_amount + sss_emergency_amount + sss_calamity_amount
      + pagibig_salary_amount + pagibig_calamity_amount + pagibig_short_amount
  where id = p_id;

  if p_fields ? 'ca_amount' then
    select ca_amount into v_amt from payroll_lines where id = p_id;
    perform sync_payroll_box_to_ledger(p_id, 'ca', null, 'CA', v_amt);
  end if;
  if p_fields ? 'sss_salary_amount' then
    select sss_salary_amount into v_amt from payroll_lines where id = p_id;
    perform sync_payroll_box_to_ledger(p_id, 'sss', 'salary', 'SSS Salary Loan', v_amt);
  end if;
  if p_fields ? 'sss_emergency_amount' then
    select sss_emergency_amount into v_amt from payroll_lines where id = p_id;
    perform sync_payroll_box_to_ledger(p_id, 'sss', 'emergency', 'SSS Emergency Loan', v_amt);
  end if;
  if p_fields ? 'sss_calamity_amount' then
    select sss_calamity_amount into v_amt from payroll_lines where id = p_id;
    perform sync_payroll_box_to_ledger(p_id, 'sss', 'calamity', 'SSS Calamity Loan', v_amt);
  end if;
  if p_fields ? 'pagibig_salary_amount' then
    select pagibig_salary_amount into v_amt from payroll_lines where id = p_id;
    perform sync_payroll_box_to_ledger(p_id, 'pagibig', 'salary', 'Pag-IBIG Salary Loan', v_amt);
  end if;
  if p_fields ? 'pagibig_calamity_amount' then
    select pagibig_calamity_amount into v_amt from payroll_lines where id = p_id;
    perform sync_payroll_box_to_ledger(p_id, 'pagibig', 'calamity', 'Pag-IBIG Calamity Loan', v_amt);
  end if;
  if p_fields ? 'pagibig_short_amount' then
    select pagibig_short_amount into v_amt from payroll_lines where id = p_id;
    perform sync_payroll_box_to_ledger(p_id, 'pagibig', 'short term', 'Pag-IBIG Short Term Loan', v_amt);
  end if;
end;
$$;
alter function save_payroll_line(bigint, jsonb) set search_path = public, extensions;

drop view if exists payroll_summary;

create view payroll_summary as
with line as (
  select l.*,
         case when l.pay_basis = 'monthly' then round(l.monthly_rate / days_in_a_month(), 4)
              when l.pay_basis = 'hourly'  then round(l.hourly_rate * 8, 4)
              else l.daily_rate end as rate,
         l.allowance * l.days_present as allowance_total
    from payroll_lines l
)
select l.id, l.period_id, p.company, p.starts_on, p.ends_on, p.paid_on, p.status,
       l.employee_id, e.name, e.position,
       l.pay_basis, l.monthly_rate, l.rate as daily_rate, l.hourly_rate,
       l.days_present, l.hours_present, l.nsd_hours, l.ot_hours, l.holidays, l.spe_holidays,
       l.leave_days, l.late_minutes, l.allowance, l.allowance_total, l.adjustment,
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
           + l.allowance_total + l.adjustment, 2)                   as total_earnings,
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
           + l.allowance_total + l.adjustment
           - l.rate / 480 * l.late_minutes
           - l.sss - l.philhealth - l.pagibig - l.loans - l.other_charges, 2) as net_pay,
       l.ca_amount, l.loan_amount,
       l.sss_salary_amount, l.sss_emergency_amount, l.sss_calamity_amount,
       l.pagibig_salary_amount, l.pagibig_calamity_amount, l.pagibig_short_amount
  from line l
  join payroll_periods p on p.id = l.period_id
  join employees e on e.id = l.employee_id;

grant select on payroll_summary to app_client;

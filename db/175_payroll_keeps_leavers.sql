-- Somebody who leaves partway through a cutoff is still owed the days they
-- worked in it. Opening a cutoff only ever took on people with no leaving
-- date, so a person who left last week — dated out with "They have left",
-- exactly as they should be — was simply not on the payroll that owes them
-- their last pay, and nothing on the screen said so.
--
-- Now a cutoff takes on everybody who was still here on any day of it: no
-- leaving date, or a leaving date on or after the cutoff's first day. Their
-- days are counted from the clock the same as anybody's, which only ever
-- runs up to the day they left, and their running cash advance and loans
-- come off this cutoff the same way too.
--
-- And a cutoff that was already open before this — or somebody added to the
-- team late — needs a way on without throwing the cutoff away and opening it
-- again: add_to_payroll puts one person on an open cutoff by the same rule.
-- Both go through payroll_take_on, so the two can never count differently.

create or replace function payroll_take_on(p_period bigint, p_only bigint)
returns int
language plpgsql security definer as $$
declare
  v_company text; v_from date; v_to date; v_paid_on date;
  v_paid_30th boolean; v_added int; r record;
begin
  select company, starts_on, ends_on, paid_on
    into v_company, v_from, v_to, v_paid_on
    from payroll_periods where id = p_period;
  if not found then raise exception 'There is no such payroll period.'; end if;
  v_paid_30th := extract(day from v_to) > 15;

  with taken as (
    insert into payroll_lines (period_id, employee_id, daily_rate, pay_basis, monthly_rate,
                               hourly_rate, days_present, hours_present, sss, philhealth, pagibig)
    select p_period, e.id, e.daily_rate, e.pay_basis, e.monthly_rate, e.hourly_rate,
           coalesce((select count(distinct sh.business_date)
                       from shifts sh
                      where sh.employee_id = e.id
                        and sh.business_date between v_from and v_to), 0),
           coalesce((select round(extract(epoch from
                                sum(coalesce(sh.ended_at, now()) - sh.started_at)) / 3600, 2)
                       from shifts sh
                      where sh.employee_id = e.id
                        and sh.business_date between v_from and v_to), 0),
           case when v_paid_30th then e.sss else 0 end,
           case when v_paid_30th then 0 else e.philhealth end,
           case when v_paid_30th then 0 else e.pagibig end
      from employees e
     where e.company = v_company
       and (e.ended_on is null or e.ended_on >= v_from)
       and (p_only is null or e.id = p_only)
       and not exists (select 1 from payroll_lines l
                        where l.period_id = p_period and l.employee_id = e.id)
    returning employee_id
  )
  select count(*) into v_added from taken;

  for r in
    select e.id as employee_id, a.id as advance_id, a.kind, a.loan_type,
           least(a.per_cutoff, a.principal - coalesce(paid.amt, 0)) as take
      from employees e
      join advances a on a.employee_id = e.id
      left join lateral (
        select sum(p.amount) as amt from advance_payments p where p.advance_id = a.id
      ) paid on true
     where e.company = v_company
       and (e.ended_on is null or e.ended_on >= v_from)
       and (p_only is null or e.id = p_only)
       and a.per_cutoff > 0
       and a.principal - coalesce(paid.amt, 0) > 0
       and a.started_on <= v_to
       -- Never twice: an advance already taken off this cutoff stays as it is.
       and not exists (select 1 from advance_payments ap
                        where ap.advance_id = a.id and ap.period_id = p_period)
  loop
    insert into advance_payments (advance_id, amount, paid_on, period_id, note)
    values (r.advance_id, r.take, v_paid_on, p_period, 'Automatic — taken when the cutoff opened');
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
     where period_id = p_period and employee_id = r.employee_id;
  end loop;

  return v_added;
end;
$$;
alter function payroll_take_on(bigint, bigint) set search_path = public, extensions;
-- Only ever reached through open_payroll and add_to_payroll, which check the
-- role first.
revoke all on function payroll_take_on(bigint, bigint) from public;

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

  perform payroll_take_on(v_id, null);
  return v_id;
end;
$$;
alter function open_payroll(text, date, date, date) set search_path = public, extensions;

-- One person onto a cutoff that is already open — somebody who left during
-- it, on a cutoff opened before this fix, or somebody added to the team late.
-- Refused, with the reason, for a closed cutoff, somebody already on it,
-- somebody from the other company, or somebody who left before it began.
create or replace function add_to_payroll(p_period bigint, p_employee bigint)
returns text
language plpgsql security definer as $$
declare
  v_status text; v_company text; v_from date;
  v_name text; v_emp_company text; v_left date;
begin
  perform require_role('admin', 'office', 'hr');
  select status, company, starts_on into v_status, v_company, v_from
    from payroll_periods where id = p_period;
  if not found then raise exception 'There is no such payroll period.'; end if;
  if v_status <> 'open' then
    raise exception 'That cutoff is closed. Reopen it first to add somebody.';
  end if;

  select name, company, ended_on into v_name, v_emp_company, v_left
    from employees where id = p_employee;
  if not found then raise exception 'No such person on the team.'; end if;
  if v_emp_company is distinct from v_company then
    raise exception '% is on %, not %.', v_name, coalesce(v_emp_company, 'no company'), v_company;
  end if;
  if v_left is not null and v_left < v_from then
    raise exception '% left on %, before this cutoff began.', v_name, to_char(v_left, 'FMMonth FMDD, YYYY');
  end if;
  if exists (select 1 from payroll_lines where period_id = p_period and employee_id = p_employee) then
    raise exception '% is already on this cutoff.', v_name;
  end if;

  perform payroll_take_on(p_period, p_employee);
  return v_name;
end;
$$;
alter function add_to_payroll(bigint, bigint) set search_path = public, extensions;
revoke all on function add_to_payroll(bigint, bigint) from public;
grant execute on function add_to_payroll(bigint, bigint) to app_client;

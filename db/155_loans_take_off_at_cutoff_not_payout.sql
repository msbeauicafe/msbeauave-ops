-- A loan starting Sep 27 has nothing to do with the Sep 11-25 cutoff — it
-- closed two days earlier — but the old gate compared against the payout
-- date (Sep 30, five days later) and swept it in anyway. The cutoff is
-- closed and computed the moment it closes; payout is only when the money
-- moves. Same fix for the date recorded on the ledger: what it says now is
-- the payout day, when the take actually happened at cutoff close.

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
       and a.started_on <= p_to
  loop
    insert into advance_payments (advance_id, amount, paid_on, period_id, note)
    values (r.advance_id, r.take, p_to, v_id, 'Automatic — taken when the cutoff opened');
    update payroll_lines set loans = loans + r.take
     where period_id = v_id and employee_id = r.employee_id;
  end loop;

  return v_id;
end;
$$;
alter function open_payroll(text, date, date, date) set search_path = public, extensions;

-- SSS, Pag-IBIG and PhilHealth are each due once a month, not once a cutoff.
-- open_payroll used to copy every one of them onto both halves of the month —
-- so a person on ₱581 SSS was having ₱581 taken out twice, ₱1,162 a month.
--
-- The cutoff ending on or before the 10th is paid the 15th; the one ending
-- after that is paid the 30th. SSS goes on the 30th's half; Pag-IBIG and
-- PhilHealth go on the 15th's.

create or replace function open_payroll(
  p_company text, p_from date, p_to date, p_paid date
) returns bigint
language plpgsql security definer as $$
declare v_id bigint; v_paid_30th boolean;
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
         case when v_paid_30th then e.sss else 0 end,
         case when v_paid_30th then 0 else e.philhealth end,
         case when v_paid_30th then 0 else e.pagibig end
    from employees e
   where e.company = p_company
     and e.ended_on is null;

  return v_id;
end;
$$;
alter function open_payroll(text, date, date, date) set search_path = public, extensions;

-- The cutoffs already open (not yet closed, so nothing paid out is disturbed)
-- carried the old double-deducted figures. Line them up with the same rule
-- before they close.
update payroll_lines l
   set sss        = case when extract(day from p.ends_on) > 15 then e.sss else 0 end,
       philhealth = case when extract(day from p.ends_on) > 15 then 0 else e.philhealth end,
       pagibig    = case when extract(day from p.ends_on) > 15 then 0 else e.pagibig end
  from payroll_periods p, employees e
 where l.period_id = p.id
   and l.employee_id = e.id
   and p.status = 'open';

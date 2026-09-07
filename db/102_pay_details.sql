-- ============================================================================
-- MS BEAU AVE — what a person is paid on
--
-- Payroll here is worked out from one figure: the daily rate. Everything the
-- August sheet computes falls out of it —
--
--   overtime per hour        daily / 8 * 1.25
--   night differential/hour  daily / 8 * 0.10
--   a minute late            daily / 480
--   a holiday                daily
--   a special holiday        daily * 0.30
--   a day of leave with pay  daily
--
-- so the rate is kept and the rest is arithmetic, never typed twice.
--
-- Beside it sit the three statutory deductions. Pag-IBIG is 200 for everybody;
-- SSS and PhilHealth follow brackets that move with the law rather than with
-- anything the shop knows, so they are held as the figure the bookkeeper is
-- using and edited when a circular changes it.
--
-- The company matters because the two are paid separately: MS Beau and BOA
-- each get their own summary and their own payslips.
-- ============================================================================

alter table employees
  add column if not exists company    text    not null default 'MS BEAU'
    check (company in ('MS BEAU', 'BOA')),
  add column if not exists daily_rate numeric(12,4) not null default 0
    check (daily_rate >= 0),
  add column if not exists sss        numeric(12,2) not null default 0 check (sss >= 0),
  add column if not exists philhealth numeric(12,2) not null default 0 check (philhealth >= 0),
  add column if not exists pagibig    numeric(12,2) not null default 200 check (pagibig >= 0);

-- The rates a payroll line is built from, derived rather than stored, so a
-- change of daily rate cannot leave six other figures behind.
create or replace function pay_rates(p_daily numeric) returns jsonb
language sql immutable as $$
  select jsonb_build_object(
    'daily',        round(coalesce(p_daily, 0), 4),
    'hourly',       round(coalesce(p_daily, 0) / 8, 4),
    'overtime',     round(coalesce(p_daily, 0) / 8 * 1.25, 4),
    'night',        round(coalesce(p_daily, 0) / 8 * 0.10, 4),
    'per_minute',   round(coalesce(p_daily, 0) / 480, 6),
    'holiday',      round(coalesce(p_daily, 0), 4),
    'spe_holiday',  round(coalesce(p_daily, 0) * 0.30, 4),
    'leave',        round(coalesce(p_daily, 0), 4));
$$;

create or replace function set_pay_details(
  p_id bigint, p_company text, p_daily numeric,
  p_sss numeric, p_philhealth numeric, p_pagibig numeric
) returns void
language plpgsql security definer as $$
begin
  perform require_role('admin');
  if coalesce(p_company, '') not in ('MS BEAU', 'BOA') then
    raise exception 'A person is paid by MS Beau or by BOA.';
  end if;
  update employees
     set company    = p_company,
         daily_rate = greatest(coalesce(p_daily, 0), 0),
         sss        = greatest(coalesce(p_sss, 0), 0),
         philhealth = greatest(coalesce(p_philhealth, 0), 0),
         pagibig    = greatest(coalesce(p_pagibig, 200), 0)
   where id = p_id;
  if not found then raise exception 'No such person.'; end if;
end;
$$;

alter function pay_rates(numeric) set search_path = public, extensions;
alter function set_pay_details(bigint, text, numeric, numeric, numeric, numeric)
  set search_path = public, extensions;
grant execute on function pay_rates(numeric) to app_client;
grant execute on function set_pay_details(bigint, text, numeric, numeric, numeric, numeric)
  to app_client;

-- The team view carries the pay figures too. Five numbers on a row that is
-- already read constantly — nothing like the photograph that had to be moved
-- out of it.
create or replace view team as
select e.id, e.name, e.position, e.phone, e.started_on, e.ended_on, e.note,
       (e.ended_on is null) as here,
       e.user_id, u.username, u.role as signs_in_as,
       (ph.employee_id is not null) as has_photo,
       (s.id is not null) as on_shift,
       s.started_at as since,
       coalesce((select sum(coalesce(sh.ended_at, now()) - sh.started_at)
                   from shifts sh
                  where sh.employee_id = e.id
                    and sh.business_date > (now() at time zone 'Asia/Manila')::date - 7),
                interval '0') as hours_this_week,
       (e.pin_hash is not null) as has_pin,
       e.branch_id, br.name as branch,
       (select sh.started_at from shifts sh
         where sh.employee_id = e.id
           and sh.business_date = (now() at time zone 'Asia/Manila')::date
         order by sh.started_at desc limit 1) as today_in,
       (select sh.ended_at from shifts sh
         where sh.employee_id = e.id
           and sh.business_date = (now() at time zone 'Asia/Manila')::date
         order by sh.started_at desc limit 1) as today_out,
       ph.updated_at as photo_at,
       exists (select 1 from employee_fingers f where f.employee_id = e.id) as has_finger,
       e.company, e.daily_rate, e.sss, e.philhealth, e.pagibig,
       pay_rates(e.daily_rate) as rates
  from employees e
  left join app_users u on u.id = e.user_id
  left join employee_photos ph on ph.employee_id = e.id
  left join shifts s on s.employee_id = e.id and s.ended_at is null
  join branches br on br.id = e.branch_id
 order by (e.ended_on is null) desc, e.name;

grant select on team to app_client;

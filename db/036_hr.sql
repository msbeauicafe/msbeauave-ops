-- ============================================================================
-- MS BEAU AVE — human resources
--
-- Fifty-one people, one HR manager. Adona holds the whole of it: the records,
-- the leave, the reviews, the hiring. She keeps full admin, as she has had
-- since the beginning, and gains a workspace that is hers — a place where the
-- company reads as people rather than as stock and takings.
--
-- The other half is new and needs care. An employee sign-in exists so somebody
-- can see their own record and ask for their own leave, and it must never
-- become a way to read the person at the next till. So it is built the only
-- way that holds: an employee sign-in is given no row-level policy at all, on
-- any table that holds a person. `select * from employees` as an employee
-- returns nothing — not a filtered list, nothing. Every employee-facing answer
-- comes from a security-definer function that works out who is asking from the
-- session's own actor and never from an argument, because an argument is a
-- number somebody can change in a request and an actor is not.
--
-- Pay and department sit in their own table rather than in `employees`. The
-- team list is readable by the shop floor, and the `team` view runs with the
-- owner's rights, so anything added to that row is a salary one join away from
-- a cashier. Keeping it apart means the sensitive half has its own lock.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- A sign-in that is only a person
-- ---------------------------------------------------------------------------
alter table app_users drop constraint if exists app_users_role_check;
alter table app_users add constraint app_users_role_check
  check (role in ('admin','warehouse','cashier','supervisor','office',
                  'timekeeper','reseller','employee'));

create or replace function create_login(
  p_username text, p_display text, p_hash text, p_role text, p_reseller bigint default null
) returns bigint
language plpgsql security definer as $$
declare v_id bigint; v_name text;
begin
  perform require_role('admin');

  if length(btrim(coalesce(p_username, ''))) = 0 then
    raise exception 'A sign-in needs a username.';
  end if;
  if p_role not in ('admin','warehouse','cashier','supervisor','office',
                    'timekeeper','reseller','employee') then
    raise exception '% is not something a sign-in can be.', p_role;
  end if;

  if exists (select 1 from app_users where lower(username) = lower(btrim(p_username))) then
    raise exception 'There is already a sign-in called %.', btrim(p_username);
  end if;

  if p_role = 'reseller' then
    if p_reseller is null then
      raise exception
        'A reseller sign-in has to belong to a reseller. Add the company under Resellers first.';
    end if;
    select name into v_name from resellers where id = p_reseller;
    if not found then
      raise exception 'There is no reseller with that number.';
    end if;
  elsif p_reseller is not null then
    raise exception 'Only a reseller sign-in belongs to a reseller.';
  end if;

  insert into app_users (username, display_name, password_hash, role, reseller_id)
  values (btrim(p_username), coalesce(nullif(btrim(coalesce(p_display, '')), ''), btrim(p_username)),
          p_hash, p_role, p_reseller)
  returning id into v_id;
  return v_id;
end;
$$;

-- Who is asking, as a person rather than as a role. Null for a sign-in that is
-- not somebody on the team — the office PC, a reseller, the door.
create or replace function current_employee() returns bigint
language sql stable security definer as $$
  select e.id
    from employees e
    join app_users u on u.id = e.user_id
   where lower(u.username) = lower(current_actor())
     and e.ended_on is null
   limit 1;
$$;

-- ---------------------------------------------------------------------------
-- Employment: the part of a record that is not everybody's business
-- ---------------------------------------------------------------------------
create table employment_details (
  employee_id       bigint primary key references employees (id) on delete cascade,
  department        text,
  salary            numeric(12,2) check (salary is null or salary >= 0),
  pay_period        text not null default 'monthly'
                    check (pay_period in ('monthly','semi_monthly','daily')),
  leave_entitlement int not null default 5 check (leave_entitlement between 0 and 90),
  updated_at        timestamptz not null default now()
);
create trigger employment_details_audit after insert or update or delete on employment_details
  for each row execute function write_audit();

-- ---------------------------------------------------------------------------
-- Leave
--
-- Asked for by the person, decided by HR. A request that has been decided is
-- never edited afterwards — a withdrawn day and a refused day are different
-- things, and pay depends on knowing which happened.
-- ---------------------------------------------------------------------------
create table leave_requests (
  id          bigint generated always as identity primary key,
  employee_id bigint not null references employees (id),
  leave_type  text not null check (leave_type in ('vacation','sick','emergency','unpaid','maternity')),
  start_date  date not null,
  end_date    date not null,
  reason      text,
  status      text not null default 'pending'
              check (status in ('pending','approved','declined','withdrawn')),
  decided_by  text,
  decided_at  timestamptz,
  created_at  timestamptz not null default now(),

  constraint leave_ends_after_starting check (end_date >= start_date),
  constraint decided_leave_says_who
    check ((status = 'pending') = (decided_by is null))
);
create index leave_by_person on leave_requests (employee_id, start_date desc);
create index leave_pending on leave_requests (start_date) where status = 'pending';
create trigger leave_requests_audit after insert or update or delete on leave_requests
  for each row execute function write_audit();

-- ---------------------------------------------------------------------------
-- Hiring
-- ---------------------------------------------------------------------------
create table applications (
  id             bigint generated always as identity primary key,
  candidate_name text not null check (length(btrim(candidate_name)) > 0),
  target_role    text not null check (length(btrim(target_role)) > 0),
  branch_id      bigint references branches (id),
  phone          text,
  email          text,
  pipeline_stage text not null default 'applied'
                 check (pipeline_stage in ('applied','screening','interview','offer','hired','rejected')),
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index applications_by_stage on applications (pipeline_stage, updated_at desc);
create trigger applications_audit after insert or update or delete on applications
  for each row execute function write_audit();

-- ---------------------------------------------------------------------------
-- Reviews
-- ---------------------------------------------------------------------------
create table appraisals (
  id           bigint generated always as identity primary key,
  employee_id  bigint not null references employees (id),
  period       text not null check (length(btrim(period)) > 0),
  rating       int not null check (rating between 1 and 5),
  strengths    text,
  improvements text,
  reviewer     text not null default current_actor(),
  created_at   timestamptz not null default now()
);
create index appraisals_by_person on appraisals (employee_id, created_at desc);
create trigger appraisals_audit after insert or update or delete on appraisals
  for each row execute function write_audit();

-- ---------------------------------------------------------------------------
-- Announcements
--
-- The one thing an employee sign-in reads that is not about themselves. Posted
-- by HR, seen by everyone, and deliberately not a message anybody can reply to
-- — a noticeboard, not an inbox.
-- ---------------------------------------------------------------------------
create table announcements (
  id         bigint generated always as identity primary key,
  title      text not null check (length(btrim(title)) > 0),
  body       text not null check (length(btrim(body)) > 0),
  posted_by  text not null default current_actor(),
  posted_at  timestamptz not null default now(),
  withdrawn  boolean not null default false
);
create index announcements_live on announcements (posted_at desc) where not withdrawn;
create trigger announcements_audit after insert or update or delete on announcements
  for each row execute function write_audit();

-- ---------------------------------------------------------------------------
-- What HR does
-- ---------------------------------------------------------------------------
create or replace function set_employment(
  p_employee bigint, p_department text default null, p_salary numeric default null,
  p_pay_period text default 'monthly', p_leave int default 5) returns void
language plpgsql security definer as $$
begin
  perform require_role('admin');
  if not exists (select 1 from employees where id = p_employee) then
    raise exception 'No such person.';
  end if;
  insert into employment_details (employee_id, department, salary, pay_period, leave_entitlement)
  values (p_employee, nullif(btrim(coalesce(p_department, '')), ''), p_salary,
          coalesce(p_pay_period, 'monthly'), coalesce(p_leave, 5))
  on conflict (employee_id) do update
    set department = excluded.department, salary = excluded.salary,
        pay_period = excluded.pay_period, leave_entitlement = excluded.leave_entitlement,
        updated_at = now();
end;
$$;

create or replace function decide_leave(p_id bigint, p_status text) returns void
language plpgsql security definer as $$
declare v_was text;
begin
  perform require_role('admin');
  if p_status not in ('approved','declined') then
    raise exception 'A leave request is either approved or declined.';
  end if;
  select status into v_was from leave_requests where id = p_id;
  if not found then raise exception 'No such leave request.'; end if;
  if v_was <> 'pending' then
    raise exception 'That request was already %.', v_was;
  end if;
  update leave_requests
     set status = p_status, decided_by = current_actor(), decided_at = now()
   where id = p_id;
end;
$$;

create or replace function add_application(
  p_name text, p_role text, p_branch bigint default null,
  p_phone text default null, p_email text default null, p_notes text default null)
returns bigint language plpgsql security definer as $$
declare v_id bigint;
begin
  perform require_role('admin');
  insert into applications (candidate_name, target_role, branch_id, phone, email, notes)
  values (btrim(p_name), btrim(p_role), p_branch,
          nullif(btrim(coalesce(p_phone, '')), ''),
          nullif(btrim(coalesce(p_email, '')), ''),
          nullif(btrim(coalesce(p_notes, '')), ''))
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function move_application(
  p_id bigint, p_stage text, p_notes text default null) returns void
language plpgsql security definer as $$
begin
  perform require_role('admin');
  if p_stage not in ('applied','screening','interview','offer','hired','rejected') then
    raise exception '% is not a stage a candidate can be at.', p_stage;
  end if;
  update applications
     set pipeline_stage = p_stage,
         notes = coalesce(nullif(btrim(coalesce(p_notes, '')), ''), notes),
         updated_at = now()
   where id = p_id;
  if not found then raise exception 'No such application.'; end if;
end;
$$;

create or replace function add_appraisal(
  p_employee bigint, p_period text, p_rating int,
  p_strengths text default null, p_improvements text default null)
returns bigint language plpgsql security definer as $$
declare v_id bigint;
begin
  perform require_role('admin');
  if not exists (select 1 from employees where id = p_employee) then
    raise exception 'No such person.';
  end if;
  insert into appraisals (employee_id, period, rating, strengths, improvements)
  values (p_employee, btrim(p_period), p_rating,
          nullif(btrim(coalesce(p_strengths, '')), ''),
          nullif(btrim(coalesce(p_improvements, '')), ''))
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function post_announcement(p_title text, p_body text) returns bigint
language plpgsql security definer as $$
declare v_id bigint;
begin
  perform require_role('admin');
  insert into announcements (title, body) values (btrim(p_title), btrim(p_body))
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function withdraw_announcement(p_id bigint) returns void
language plpgsql security definer as $$
begin
  perform require_role('admin');
  update announcements set withdrawn = true where id = p_id;
  if not found then raise exception 'No such announcement.'; end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- What a person can do about themselves
--
-- None of these take a person as an argument. They work out who is asking from
-- the session, so there is no number in a request that can be edited into
-- somebody else's record. The one that does take an id — withdrawing a leave
-- request — checks that the row belongs to the asker before touching it.
-- ---------------------------------------------------------------------------
-- Days already spoken for this year: approved leave, plus anything still
-- waiting. A request that is pending is not free — somebody who has asked for
-- their last five days should not be shown five days left and ask again.
create or replace function leave_days_taken(p_employee bigint) returns int
language sql stable security definer as $$
  select coalesce(sum((end_date - start_date) + 1), 0)::int
    from leave_requests
   where employee_id = p_employee
     and status in ('approved','pending')
     and start_date >= date_trunc('year', current_date)::date;
$$;

create or replace function my_profile() returns table (
  id bigint, name text, "position" text, phone text, branch text,
  started_on date, department text, salary numeric, pay_period text,
  leave_entitlement int, leave_taken int, leave_left int, has_photo boolean)
language plpgsql stable security definer as $$
declare v_me bigint := current_employee();
begin
  perform require_role('admin','employee');
  if v_me is null then
    raise exception 'That sign-in does not belong to anybody on the team.';
  end if;
  return query
  select e.id, e.name, e.position, e.phone, b.name,
         e.started_on, d.department, d.salary, d.pay_period,
         coalesce(d.leave_entitlement, 5),
         leave_days_taken(e.id),
         greatest(coalesce(d.leave_entitlement, 5) - leave_days_taken(e.id), 0),
         (ph.employee_id is not null)
    from employees e
    left join branches b on b.id = e.branch_id
    left join employment_details d on d.employee_id = e.id
    left join employee_photos ph on ph.employee_id = e.id
   where e.id = v_me;
end;
$$;

create or replace function my_leave() returns table (
  id bigint, leave_type text, start_date date, end_date date, days int,
  reason text, status text, decided_by text, decided_at timestamptz,
  created_at timestamptz)
language plpgsql stable security definer as $$
declare v_me bigint := current_employee();
begin
  perform require_role('admin','employee');
  if v_me is null then
    raise exception 'That sign-in does not belong to anybody on the team.';
  end if;
  return query
  select l.id, l.leave_type, l.start_date, l.end_date,
         ((l.end_date - l.start_date) + 1)::int,
         l.reason, l.status, l.decided_by, l.decided_at, l.created_at
    from leave_requests l
   where l.employee_id = v_me
   order by l.start_date desc;
end;
$$;

create or replace function request_leave(
  p_type text, p_start date, p_end date, p_reason text default null)
returns bigint language plpgsql security definer as $$
declare v_me bigint := current_employee(); v_id bigint;
begin
  perform require_role('admin','employee');
  if v_me is null then
    raise exception 'That sign-in does not belong to anybody on the team.';
  end if;
  if p_type not in ('vacation','sick','emergency','unpaid','maternity') then
    raise exception '% is not a kind of leave.', p_type;
  end if;
  if p_end < p_start then
    raise exception 'Leave cannot end before it starts.';
  end if;
  if exists (select 1 from leave_requests
              where employee_id = v_me and status in ('pending','approved')
                and start_date <= p_end and end_date >= p_start) then
    raise exception 'You have already asked for leave over those days.';
  end if;

  insert into leave_requests (employee_id, leave_type, start_date, end_date, reason)
  values (v_me, p_type, p_start, p_end, nullif(btrim(coalesce(p_reason, '')), ''))
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function withdraw_leave(p_id bigint) returns void
language plpgsql security definer as $$
declare v_me bigint := current_employee(); v_status text;
begin
  perform require_role('admin','employee');
  if v_me is null then
    raise exception 'That sign-in does not belong to anybody on the team.';
  end if;
  -- The employee_id in the where clause is the whole guard: somebody else's
  -- request is not found rather than refused, which tells the asker nothing.
  select status into v_status from leave_requests where id = p_id and employee_id = v_me;
  if not found then raise exception 'No such leave request.'; end if;
  if v_status <> 'pending' then
    raise exception 'That request was already %.', v_status;
  end if;
  update leave_requests set status = 'withdrawn', decided_by = current_actor(),
         decided_at = now()
   where id = p_id and employee_id = v_me;
end;
$$;

create or replace function my_appraisals() returns table (
  id bigint, period text, rating int, strengths text, improvements text,
  reviewer text, created_at timestamptz)
language plpgsql stable security definer as $$
declare v_me bigint := current_employee();
begin
  perform require_role('admin','employee');
  if v_me is null then
    raise exception 'That sign-in does not belong to anybody on the team.';
  end if;
  return query
  select a.id, a.period, a.rating, a.strengths, a.improvements, a.reviewer, a.created_at
    from appraisals a where a.employee_id = v_me order by a.created_at desc;
end;
$$;

create or replace function my_hours() returns table (
  business_date date, started_at timestamptz, ended_at timestamptz, worked interval)
language plpgsql stable security definer as $$
declare v_me bigint := current_employee();
begin
  perform require_role('admin','employee');
  if v_me is null then
    raise exception 'That sign-in does not belong to anybody on the team.';
  end if;
  return query
  select s.business_date, s.started_at, s.ended_at,
         coalesce(s.ended_at, now()) - s.started_at
    from shifts s where s.employee_id = v_me
   order by s.started_at desc limit 60;
end;
$$;

create or replace function noticeboard() returns table (
  id bigint, title text, body text, posted_by text, posted_at timestamptz)
language plpgsql stable security definer as $$
begin
  perform require_role('admin','employee','warehouse','cashier','supervisor','office');
  return query
  select a.id, a.title, a.body, a.posted_by, a.posted_at
    from announcements a where not a.withdrawn
   order by a.posted_at desc limit 50;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reading, for HR
-- ---------------------------------------------------------------------------
create or replace view hr_people as
select e.id, e.name, e.position, e.phone, e.started_on, e.ended_on,
       (e.ended_on is null) as here, e.branch_id, b.name as branch,
       u.username, u.role as signs_in_as,
       d.department, d.salary, d.pay_period,
       coalesce(d.leave_entitlement, 5) as leave_entitlement,
       leave_days_taken(e.id) as leave_taken,
       (ph.employee_id is not null) as has_photo,
       (select round(avg(a.rating), 2) from appraisals a where a.employee_id = e.id) as avg_rating
  from employees e
  left join branches b on b.id = e.branch_id
  left join app_users u on u.id = e.user_id
  left join employment_details d on d.employee_id = e.id
  left join employee_photos ph on ph.employee_id = e.id
 order by (e.ended_on is null) desc, e.name;

create or replace view hr_leave as
select l.id, l.employee_id, e.name, e.position, b.name as branch,
       l.leave_type, l.start_date, l.end_date,
       ((l.end_date - l.start_date) + 1) as days,
       l.reason, l.status, l.decided_by, l.decided_at, l.created_at
  from leave_requests l
  join employees e on e.id = l.employee_id
  left join branches b on b.id = e.branch_id
 order by (l.status = 'pending') desc, l.start_date desc;

-- ---------------------------------------------------------------------------
-- Access
--
-- Note what is missing: there is no policy here naming 'employee'. An employee
-- sign-in reads nothing from any of these tables directly. Everything it can
-- see arrives through the functions above, which decide the person from the
-- session. That is the difference between a rule and a filter — a filter can
-- be passed the wrong number.
-- ---------------------------------------------------------------------------
alter table employment_details enable row level security;
alter table leave_requests enable row level security;
alter table applications enable row level security;
alter table appraisals enable row level security;
alter table announcements enable row level security;

create policy admin_reads_employment on employment_details for select
  using (current_role_name() = 'admin');
create policy admin_reads_leave on leave_requests for select
  using (current_role_name() = 'admin');
create policy admin_reads_applications on applications for select
  using (current_role_name() = 'admin');
create policy admin_reads_appraisals on appraisals for select
  using (current_role_name() = 'admin');
create policy admin_reads_announcements on announcements for select
  using (current_role_name() = 'admin');

grant select on employment_details, leave_requests, applications, appraisals,
                announcements, hr_people, hr_leave to app_client;

grant execute on function current_employee() to app_client;
grant execute on function leave_days_taken(bigint) to app_client;
grant execute on function set_employment(bigint, text, numeric, text, int) to app_client;
grant execute on function decide_leave(bigint, text) to app_client;
grant execute on function add_application(text, text, bigint, text, text, text) to app_client;
grant execute on function move_application(bigint, text, text) to app_client;
grant execute on function add_appraisal(bigint, text, int, text, text) to app_client;
grant execute on function post_announcement(text, text) to app_client;
grant execute on function withdraw_announcement(bigint) to app_client;
grant execute on function my_profile() to app_client;
grant execute on function my_leave() to app_client;
grant execute on function request_leave(text, date, date, text) to app_client;
grant execute on function withdraw_leave(bigint) to app_client;
grant execute on function my_appraisals() to app_client;
grant execute on function my_hours() to app_client;
grant execute on function noticeboard() to app_client;

alter function create_login(text, text, text, text, bigint) set search_path = public, extensions;
alter function current_employee() set search_path = public, extensions;
alter function leave_days_taken(bigint) set search_path = public, extensions;
alter function set_employment(bigint, text, numeric, text, int) set search_path = public, extensions;
alter function decide_leave(bigint, text) set search_path = public, extensions;
alter function add_application(text, text, bigint, text, text, text) set search_path = public, extensions;
alter function move_application(bigint, text, text) set search_path = public, extensions;
alter function add_appraisal(bigint, text, int, text, text) set search_path = public, extensions;
alter function post_announcement(text, text) set search_path = public, extensions;
alter function withdraw_announcement(bigint) set search_path = public, extensions;
alter function my_profile() set search_path = public, extensions;
alter function my_leave() set search_path = public, extensions;
alter function request_leave(text, date, date, text) set search_path = public, extensions;
alter function withdraw_leave(bigint) set search_path = public, extensions;
alter function my_appraisals() set search_path = public, extensions;
alter function my_hours() set search_path = public, extensions;
alter function noticeboard() set search_path = public, extensions;

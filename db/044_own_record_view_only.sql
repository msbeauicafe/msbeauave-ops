-- ============================================================================
-- MS BEAU AVE — a view-only manager's own record
--
-- The sixteen people who may look and not touch are not auditors from outside.
-- They work here: they clock on at the same door, take leave from the same
-- allowance and are reviewed like everybody else. They were the only people in
-- the building with no way to see their own hours, because the tier was built
-- as a way of reading the company and their own record is not the company.
--
-- So the six my_* functions take an observer, and the boundary does not move
-- an inch: every one of them resolves the person from current_actor() and has
-- no argument to point anywhere else. Reading them as somebody who may look
-- and not touch can only produce their own row.
--
-- Their own pay comes with it. The tier is "everything except finance and
-- salaries", and salaries there means everybody else's — hr_people still has
-- the column stripped out of the reply for them, and employment_details still
-- has no policy naming observer, so the only pay figure they can reach is the
-- one on their own payslip. A cashier already sees theirs.
--
-- What is deliberately not on this list: request_leave and withdraw_leave.
-- They write, and read-only is what these sixteen were given. Their leave
-- balance shows on their record; asking for the days is still a conversation
-- with HR, exactly as it was yesterday.
-- ============================================================================

create or replace function my_profile() returns table (
  id bigint, name text, "position" text, phone text, branch text,
  started_on date, department text, salary numeric, pay_period text,
  leave_entitlement int, leave_taken int, leave_left int, has_photo boolean)
language plpgsql stable security definer as $$
declare v_me bigint := current_employee();
begin
  perform require_role('admin','employee','observer');
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
  perform require_role('admin','employee','observer');
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

create or replace function my_appraisals() returns table (
  id bigint, period text, rating int, strengths text, improvements text,
  reviewer text, created_at timestamptz)
language plpgsql stable security definer as $$
declare v_me bigint := current_employee();
begin
  perform require_role('admin','employee','observer');
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
  perform require_role('admin','employee','observer');
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

-- The noticeboard is the one thing everybody reads the same copy of, and these
-- sixteen were left off it — they already see the same announcements on the HR
-- screen, so this is only so /api/my answers them at all. It is also simply
-- true: a notice pinned up for the whole company is for them too.
create or replace function noticeboard() returns table (
  id bigint, title text, body text, posted_by text, posted_at timestamptz)
language plpgsql stable security definer as $$
begin
  perform require_role('admin','employee','warehouse','cashier','supervisor',
                       'office','observer');
  return query
  select a.id, a.title, a.body, a.posted_by, a.posted_at
    from announcements a where not a.withdrawn
   order by a.posted_at desc limit 50;
end;
$$;

create or replace function my_photo()
returns table (mime text, bytes bytea, updated_at timestamptz)
language plpgsql stable security definer as $$
declare v_me bigint := current_employee();
begin
  perform require_role('admin','employee','observer');
  if v_me is null then
    raise exception 'That sign-in does not belong to anybody on the team.';
  end if;
  return query
  select p.mime, p.bytes, p.updated_at
    from employee_photos p where p.employee_id = v_me;
end;
$$;

-- create or replace wipes a function's stored settings, so every one of these
-- lost its pinned search_path the moment it was rewritten above — on
-- security-definer functions, which is precisely where it matters. Nothing
-- warns about it. tests/search-path.test.js now fails if any definer function
-- in the schema is missing one, so the next rewrite cannot lose it quietly.
alter function my_profile()    set search_path = public, extensions;
alter function my_leave()      set search_path = public, extensions;
alter function my_appraisals() set search_path = public, extensions;
alter function my_hours()      set search_path = public, extensions;
alter function my_photo()      set search_path = public, extensions;
alter function noticeboard()   set search_path = public, extensions;

-- Four more, found by that test the first time it ran, and none of them mine.
-- The observer migration widened attendance_on, attendance_summary,
-- attendance_detail and create_login the same way — `create or replace` to add
-- a role — and lost their search_path in exactly the same silence. Which is
-- the argument for the test: this had already happened once and nobody knew.
alter function attendance_on(date, bigint)
  set search_path = public, extensions;
alter function attendance_summary(date, date, bigint)
  set search_path = public, extensions;
alter function attendance_detail(date, bigint)
  set search_path = public, extensions;
alter function create_login(text, text, text, text, bigint)
  set search_path = public, extensions;

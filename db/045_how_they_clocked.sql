-- ============================================================================
-- MS BEAU AVE — which way somebody clocked
--
-- The shift row already says who wrote it: "Timekeeper" for a door screen, or
-- a supervisor's own username when they enter one by hand. What it never said
-- was how the person at the door proved who they were. Asked whether this
-- morning's fifteen at Beauty Obsession Ave were fingers or PINs, the honest
-- answer was that the record does not know — which is a poor answer about a
-- fingerprint door that took a day to get working.
--
-- Nothing has to be installed anywhere for this. The method is already implied
-- by which door the request came through: the program at the shop PC calls
-- /api/clock/by-finger and the tablet page calls /api/clock/by-pin, and they
-- have always been separate. This only writes down what the API already knew
-- and threw away.
--
--   finger  a fingerprint matched at the door
--   pin     a PIN typed at the door, name picked or not
--   hand    entered by a person in the back office, for somebody who could not
--
-- Null means before this migration, or a caller that has not been told to say.
-- It is deliberately not defaulted to 'pin': a guess written into an hours
-- record is worse than a blank, because a blank cannot be argued with.
--
-- The one-argument clock_toggle stays, calling the new one with no method.
-- The database is migrated before the API that uses it is deployed, and there
-- are people standing at both doors — a window where the live API calls a
-- function that no longer exists is a window where nobody can clock on.
-- ============================================================================

alter table shifts add column if not exists started_how text;
alter table shifts add column if not exists ended_how   text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'how_they_clocked') then
    alter table shifts add constraint how_they_clocked check (
      (started_how is null or started_how in ('finger','pin','hand')) and
      (ended_how   is null or ended_how   in ('finger','pin','hand')));
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- The door
-- ---------------------------------------------------------------------------
create or replace function clock_toggle(p_employee bigint, p_how text)
returns jsonb language plpgsql security definer as $$
declare
  v_name    text;
  v_open    shifts%rowtype;
  v_worked  interval;
begin
  -- The timekeeper belongs on this line. It was added by 031 and this file
  -- very nearly dropped it again by starting from the 019 body — the same way
  -- the pinned search_path gets lost, and with a louder result: no door at
  -- either shop could clock anybody on.
  perform require_role('admin', 'cashier', 'warehouse', 'timekeeper');
  if p_how is not null and p_how not in ('finger','pin','hand') then
    raise exception '% is not a way of clocking on.', p_how;
  end if;

  select name into v_name from employees where id = p_employee and ended_on is null;
  if not found then
    raise exception 'That person is not on the team.';
  end if;

  -- Recorded on the way out as well as the way in. Somebody can present a
  -- finger in the morning and type their PIN at night — usually because the
  -- scanner would not read them the second time, which is exactly the thing
  -- this column exists to make visible.
  select * into v_open from shifts where employee_id = p_employee and ended_at is null;
  if found then
    update shifts set ended_at = now(), ended_by = current_actor(), ended_how = p_how
     where id = v_open.id
     returning now() - started_at into v_worked;
    return jsonb_build_object('action', 'out', 'name', v_name, 'at', now(),
                              'how', p_how,
                              'worked_minutes', round(extract(epoch from v_worked) / 60));
  end if;

  insert into shifts (employee_id, started_how) values (p_employee, p_how);
  return jsonb_build_object('action', 'in', 'name', v_name, 'at', now(), 'how', p_how);
end;
$$;

-- Kept so that the API running right now keeps working until the new one is
-- deployed. It records no method, which is true of it.
create or replace function clock_toggle(p_employee bigint)
returns jsonb language plpgsql security definer as $$
begin
  return clock_toggle(p_employee, null);
end;
$$;

create or replace function clock_by_finger(p_employee bigint, p_branch bigint)
returns jsonb
language plpgsql security definer as $$
declare v_ok boolean;
begin
  perform require_role('admin', 'cashier', 'warehouse', 'timekeeper');

  select exists (
    select 1 from employees e
     where e.id = p_employee
       and e.ended_on is null
       and (p_branch is null or e.branch_id = p_branch)
       and exists (select 1 from employee_fingers f where f.employee_id = e.id)
  ) into v_ok;

  if not v_ok then
    raise exception 'That finger does not belong to anybody here.'
      using errcode = 'P0007';
  end if;

  -- Not passed in from outside. This function is only reachable by matching a
  -- finger, so it is the one place that can say so without being told.
  return clock_toggle(p_employee, 'finger');
end;
$$;

-- ---------------------------------------------------------------------------
-- The back office
--
-- These two are only ever the till's own buttons — somebody entering a shift
-- for a person who could not clock on themselves — so they can say 'hand'
-- without being asked.
-- ---------------------------------------------------------------------------
create or replace function clock_in(p_employee bigint) returns bigint
language plpgsql security definer as $$
declare new_id bigint; v_name text;
begin
  perform require_role('admin', 'cashier');
  select name into v_name from employees where id = p_employee and ended_on is null;
  if not found then
    raise exception 'That person is not on the team.';
  end if;
  if exists (select 1 from shifts where employee_id = p_employee and ended_at is null) then
    raise exception '% is already clocked in.', v_name;
  end if;

  insert into shifts (employee_id, started_how) values (p_employee, 'hand')
  returning id into new_id;
  return new_id;
end;
$$;

create or replace function clock_out(p_employee bigint) returns interval
language plpgsql security definer as $$
declare v_started timestamptz; v_name text;
begin
  perform require_role('admin', 'cashier');
  select e.name into v_name from employees e where e.id = p_employee;

  update shifts set ended_at = now(), ended_by = current_actor(), ended_how = 'hand'
   where employee_id = p_employee and ended_at is null
   returning started_at into v_started;
  if not found then
    raise exception '% is not clocked in.', coalesce(v_name, 'That person');
  end if;
  return now() - v_started;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reading it back
-- ---------------------------------------------------------------------------
-- Dropped rather than replaced: create or replace cannot change the shape of a
-- RETURNS TABLE. Safe to drop, unlike anything on the clocking path — this is
-- only read by HR's Attendance screen, and the gap is inside one transaction.
drop function if exists attendance_detail(date, bigint);
create or replace function attendance_detail(p_day date default null, p_branch bigint default null)
returns table (
  id bigint, employee_id bigint, name text, branch text,
  started_at timestamptz, ended_at timestamptz, worked interval,
  started_by text, ended_by text, started_how text, ended_how text, note text)
language plpgsql stable security definer as $$
declare v_day date := coalesce(p_day, (now() at time zone 'Asia/Manila')::date);
begin
  perform require_role('admin','observer');
  return query
  select s.id, s.employee_id, e.name, b.name,
         s.started_at, s.ended_at,
         coalesce(s.ended_at, now()) - s.started_at,
         s.started_by, s.ended_by, s.started_how, s.ended_how, s.note
    from shifts s
    join employees e on e.id = s.employee_id
    join branches b on b.id = e.branch_id
   where s.business_date = v_day
     and (p_branch is null or e.branch_id = p_branch)
   order by s.started_at;
end;
$$;

create or replace view shifts_recent as
-- The two new columns go on the end. `create or replace view` may append
-- columns and nothing else, so putting them next to started_by — where they
-- belong to a reader — would refuse to install.
select s.id, s.employee_id, e.name, e.position, s.business_date,
       s.started_at, s.ended_at, s.started_by, s.ended_by,
       coalesce(s.ended_at, now()) - s.started_at as worked,
       s.started_how, s.ended_how
  from shifts s join employees e on e.id = s.employee_id
 order by s.started_at desc
 limit 200;

grant execute on function clock_toggle(bigint, text) to app_client;
revoke all on function clock_toggle(bigint, text) from public;

-- create or replace wipes a function's stored settings, so every one rewritten
-- above needs its search_path pinning again. tests/search-path.test.js is what
-- notices if one is forgotten.
alter function clock_toggle(bigint)             set search_path = public, extensions;
alter function clock_toggle(bigint, text)       set search_path = public, extensions;
alter function clock_by_finger(bigint, bigint)  set search_path = public, extensions;
alter function clock_in(bigint)                 set search_path = public, extensions;
alter function clock_out(bigint)                set search_path = public, extensions;
alter function attendance_detail(date, bigint)  set search_path = public, extensions;

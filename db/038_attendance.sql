-- ============================================================================
-- MS BEAU AVE — the attendance sheet
--
-- HR's question is not the one the door asks. The door asks "who is here right
-- now"; HR asks "who came in on Tuesday, when, and who did not come at all" —
-- and the second question is answered by the people who are missing from the
-- shift table, which means it cannot be a query over shifts. It has to start
-- from everybody on the team and hang the day's stretches off that.
--
-- So absence is a left join returning nulls, and it is the whole point of the
-- function. Somebody who never clocked on is exactly the row worth reading.
--
-- One row per person per day, not one per stretch. A day with a lunch break in
-- the middle of it is one day at work: first in, last out, and the hours
-- actually stood up, which is the sum of the stretches and not the gap between
-- the ends of them.
-- ============================================================================
create or replace function attendance_on(p_day date default null, p_branch bigint default null)
returns table (
  employee_id bigint, name text, "position" text, branch text, branch_id bigint,
  has_photo boolean, first_in timestamptz, last_out timestamptz,
  stretches int, worked interval, still_on boolean)
language plpgsql stable security definer as $$
declare v_day date := coalesce(p_day, (now() at time zone 'Asia/Manila')::date);
begin
  perform require_role('admin');
  return query
  select e.id, e.name, e.position, b.name, e.branch_id,
         (ph.employee_id is not null),
         min(s.started_at),
         -- Blank while somebody is still on shift rather than the end of the
         -- stretch before it: a person who came back from lunch has not left.
         case when coalesce(bool_or(s.id is not null and s.ended_at is null), false)
              then null else max(s.ended_at) end,
         count(s.id)::int,
         coalesce(sum(coalesce(s.ended_at, now()) - s.started_at), interval '0'),
         -- `s.id is not null` is doing the work. Without it, the null a left
         -- join produces for somebody who never clocked on satisfies
         -- "ended_at is null" just as an open shift does, and everybody absent
         -- is reported as still at work — which is the exact opposite of what
         -- this column is for.
         coalesce(bool_or(s.id is not null and s.ended_at is null), false)
    from employees e
    join branches b on b.id = e.branch_id
    left join employee_photos ph on ph.employee_id = e.id
    left join shifts s on s.employee_id = e.id and s.business_date = v_day
   where e.ended_on is null
     and (p_branch is null or e.branch_id = p_branch)
   group by e.id, e.name, e.position, b.name, e.branch_id, ph.employee_id
   -- Whoever turned up, in the order they turned up; everybody who did not,
   -- alphabetically underneath. The same shape as the board at the door, for
   -- the same reason: a name is found by looking rather than by reading.
   order by (min(s.started_at) is null), min(s.started_at), e.name;
end;
$$;

-- A fortnight of totals per person, for the run-up to a payday. Absence is
-- carried here too — a week with no rows in it is the thing being looked for.
create or replace function attendance_summary(
  p_from date, p_to date, p_branch bigint default null)
returns table (
  employee_id bigint, name text, "position" text, branch text,
  days_present int, stretches int, worked interval, last_seen timestamptz)
language plpgsql stable security definer as $$
begin
  perform require_role('admin');
  return query
  select e.id, e.name, e.position, b.name,
         count(distinct s.business_date)::int,
         count(s.id)::int,
         coalesce(sum(coalesce(s.ended_at, now()) - s.started_at), interval '0'),
         max(s.started_at)
    from employees e
    join branches b on b.id = e.branch_id
    left join shifts s on s.employee_id = e.id
         and s.business_date between p_from and p_to
   where e.ended_on is null
     and (p_branch is null or e.branch_id = p_branch)
   group by e.id, e.name, e.position, b.name
   order by count(distinct s.business_date), e.name;
end;
$$;

-- Every stretch of a single day, for the times HR needs to see the shape of it
-- rather than the totals — somebody who clocked out at noon and never came
-- back, or four presses in a minute that were somebody testing a scanner.
create or replace function attendance_detail(p_day date default null, p_branch bigint default null)
returns table (
  id bigint, employee_id bigint, name text, branch text,
  started_at timestamptz, ended_at timestamptz, worked interval,
  started_by text, ended_by text, note text)
language plpgsql stable security definer as $$
declare v_day date := coalesce(p_day, (now() at time zone 'Asia/Manila')::date);
begin
  perform require_role('admin');
  return query
  select s.id, s.employee_id, e.name, b.name,
         s.started_at, s.ended_at,
         coalesce(s.ended_at, now()) - s.started_at,
         s.started_by, s.ended_by, s.note
    from shifts s
    join employees e on e.id = s.employee_id
    join branches b on b.id = e.branch_id
   where s.business_date = v_day
     and (p_branch is null or e.branch_id = p_branch)
   order by s.started_at;
end;
$$;

grant execute on function attendance_on(date, bigint) to app_client;
grant execute on function attendance_summary(date, date, bigint) to app_client;
grant execute on function attendance_detail(date, bigint) to app_client;

alter function attendance_on(date, bigint) set search_path = public, extensions;
alter function attendance_summary(date, date, bigint) set search_path = public, extensions;
alter function attendance_detail(date, bigint) set search_path = public, extensions;

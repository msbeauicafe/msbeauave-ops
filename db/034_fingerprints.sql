-- ============================================================================
-- MS BEAU AVE — fingerprints at the door
--
-- The PIN answers one question: was this person's four digits typed? It does
-- not answer whether the person typed them, and that is the whole point of an
-- attendance record. A finger answers the second question.
--
-- What lives here is only half the story, because of what the scanner is. A
-- ZK9500 is a camera for fingers and nothing more: turning an image into a
-- template, and matching a template against a shop's worth of people, happens
-- in the manufacturer's closed library on the machine the scanner is plugged
-- into. Postgres cannot compare two fingerprints and never will. So the
-- database's job is to be the master copy — the one place a template is
-- enrolled, kept and taken away — while the matching happens at the door.
--
-- That means templates have to travel to the door, which is the uncomfortable
-- part and the reason for the shape below. A door only ever receives the
-- templates of people who work at that door: `fingers_for_branch` takes a
-- branch and refuses to hand over anybody else's. If one shop's machine is
-- stolen, what has been taken is that shop's staff, not the company's.
--
-- Templates, never images. A template is the manufacturer's derived form; it
-- is not a picture of anybody's finger and cannot be turned back into one.
-- Under the Data Privacy Act this is sensitive personal information either
-- way, which is why enrolling is owner-only, every enrolment is stamped with
-- who did it, and taking a person's fingers back is one call.
-- ============================================================================

create table if not exists employee_fingers (
  id           bigserial primary key,
  employee_id  bigint not null references employees(id) on delete cascade,
  -- Two per person in practice: a cut thumb on a Monday should not cost
  -- somebody their day's hours.
  finger       int not null check (finger between 0 and 9),
  template     bytea not null,
  quality      int,
  enrolled_at  timestamptz not null default now(),
  enrolled_by  text,
  unique (employee_id, finger)
);

comment on table employee_fingers is
  'Fingerprint templates, not images. Matching happens at the door; this is the master copy.';

create index if not exists employee_fingers_by_person on employee_fingers (employee_id);

-- ---------------------------------------------------------------------------
-- Enrolling. Owner-only, and it says who did it.
-- ---------------------------------------------------------------------------
create or replace function enrol_finger(
  p_employee bigint, p_finger int, p_template bytea, p_quality int
) returns void
language plpgsql security definer as $$
declare v_name text;
begin
  perform require_role('admin');

  if p_template is null or length(p_template) = 0 then
    raise exception 'That scan produced nothing. Try again.';
  end if;

  select name into v_name from employees where id = p_employee and ended_on is null;
  if not found then
    raise exception 'No such person on the team.';
  end if;

  insert into employee_fingers (employee_id, finger, template, quality, enrolled_by)
  values (p_employee, p_finger, p_template, p_quality, current_actor())
  on conflict (employee_id, finger) do update
    set template = excluded.template, quality = excluded.quality,
        enrolled_at = now(), enrolled_by = excluded.enrolled_by;
end;
$$;

-- ---------------------------------------------------------------------------
-- Taking them back. The same gap the PIN had, and the same answer: somebody
-- who leaves must stop opening the door, and there has to be a way to say so.
-- ---------------------------------------------------------------------------
create or replace function clear_fingers(p_employee bigint) returns int
language plpgsql security definer as $$
declare v_gone int;
begin
  perform require_role('admin');
  delete from employee_fingers where employee_id = p_employee;
  get diagnostics v_gone = row_count;
  return v_gone;
end;
$$;

-- ---------------------------------------------------------------------------
-- What one door may hold.
--
-- The reason this is a function rather than a view: a view would hand the
-- caller a branch to filter by and trust them to do it. This one takes the
-- branch and does the narrowing itself, so a door that asks for everybody
-- gets its own people and no more.
-- ---------------------------------------------------------------------------
create or replace function fingers_for_branch(p_branch bigint)
returns table (employee_id bigint, name text, finger int, template bytea)
language plpgsql stable security definer as $$
begin
  perform require_role('admin', 'cashier', 'warehouse', 'timekeeper');

  if p_branch is null then
    raise exception 'A door belongs to one shop. Say which.';
  end if;

  return query
    select f.employee_id, e.name, f.finger, f.template
      from employee_fingers f
      join employees e on e.id = f.employee_id
     where e.ended_on is null
       and e.branch_id = p_branch
     order by e.name, f.finger;
end;
$$;

-- ---------------------------------------------------------------------------
-- Clocking on a finger.
--
-- The door says who it recognised; this decides whether to believe it. The
-- person must still work here, must work at that door, and must have a finger
-- enrolled — otherwise a compromised door could name anybody and be believed.
-- It is the same trust as the PIN pad, where the door's own sign-in is what
-- says the tap happened at the shop, with one more thing checked.
-- ---------------------------------------------------------------------------
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

  return clock_toggle(p_employee);
end;
$$;

-- Who is enrolled, for the Team screen. Counts only — a template is not
-- something to put on a page.
create or replace view team_fingers as
select e.id as employee_id, count(f.id)::int as fingers,
       max(f.enrolled_at) as last_enrolled
  from employees e
  left join employee_fingers f on f.employee_id = e.id
 group by e.id;

alter table employee_fingers enable row level security;
drop policy if exists admin_reads_fingers on employee_fingers;
create policy admin_reads_fingers on employee_fingers for select
  using (current_role_name() = 'admin');

grant select on employee_fingers to app_client;
grant select on team_fingers to app_client;

alter function enrol_finger(bigint, int, bytea, int) set search_path = public, extensions;
alter function clear_fingers(bigint) set search_path = public, extensions;
alter function fingers_for_branch(bigint) set search_path = public, extensions;
alter function clock_by_finger(bigint, bigint) set search_path = public, extensions;
revoke all on function enrol_finger(bigint, int, bytea, int) from public;
revoke all on function clear_fingers(bigint) from public;
revoke all on function fingers_for_branch(bigint) from public;
revoke all on function clock_by_finger(bigint, bigint) from public;
grant execute on function enrol_finger(bigint, int, bytea, int) to app_client;
grant execute on function clear_fingers(bigint) to app_client;
grant execute on function fingers_for_branch(bigint) to app_client;
grant execute on function clock_by_finger(bigint, bigint) to app_client;

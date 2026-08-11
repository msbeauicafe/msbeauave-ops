-- ============================================================================
-- MS BEAU AVE — the team
--
-- Who works here, and when they were actually here. Two things a shop needs
-- and a payroll package does not have to be bought for: a list of people with
-- their positions, and an honest record of hours.
--
-- An employee is not a sign-in. Most of the people on this list will have one,
-- but a stockroom hand who never touches the system is still an employee, and
-- a shared till login is not a person. The link between them is optional and
-- points one way, from the employee to the account they use.
-- ============================================================================

create table employees (
  id         bigint generated always as identity primary key,
  name       text not null check (length(btrim(name)) > 0),
  position   text not null check (length(btrim(position)) > 0),
  phone      text,
  user_id    bigint references app_users (id),
  started_on date not null default current_date,
  ended_on   date,
  note       text,
  created_at timestamptz not null default now(),

  constraint left_after_starting check (ended_on is null or ended_on >= started_on)
);
-- One employee per sign-in: two people sharing an account is exactly the thing
-- an hours record must not be able to represent.
create unique index employees_one_per_login on employees (user_id) where user_id is not null;
create index employees_here on employees (name) where ended_on is null;
create trigger employees_audit after insert or update or delete on employees
  for each row execute function write_audit();

-- Photographs, kept out of the row for the same reason product ones are: the
-- team list is read constantly and the picture is the heaviest thing on it.
create table employee_photos (
  employee_id bigint primary key references employees (id) on delete cascade,
  mime        text not null check (mime in ('image/jpeg', 'image/png', 'image/webp')),
  bytes       bytea not null check (length(bytes) between 1 and 900000),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Hours
--
-- One row per stretch of work. Open-ended while somebody is still on, closed
-- when they leave — so "who is here right now" is a question about nulls
-- rather than about the clock.
-- ---------------------------------------------------------------------------
create table shifts (
  id            bigint generated always as identity primary key,
  employee_id   bigint not null references employees (id),
  business_date date not null default (now() at time zone 'Asia/Manila')::date,
  started_at    timestamptz not null default now(),
  ended_at      timestamptz,
  started_by    text not null default current_actor(),
  ended_by      text,
  note          text,

  constraint ends_after_starting check (ended_at is null or ended_at >= started_at)
);
-- Nobody can be on two shifts at once, which is what makes the hours add up.
create unique index shifts_one_open_per_employee on shifts (employee_id) where ended_at is null;
create index shifts_by_day on shifts (business_date, employee_id);
create trigger shifts_audit after insert or update or delete on shifts
  for each row execute function write_audit();

-- ---------------------------------------------------------------------------
-- Keeping the list
-- ---------------------------------------------------------------------------
create or replace function add_employee(
  p_name text, p_position text, p_phone text default null,
  p_user bigint default null, p_started date default null,
  p_note text default null) returns bigint
language plpgsql security definer as $$
declare new_id bigint;
begin
  perform require_role('admin');
  if p_user is not null and exists (select 1 from employees where user_id = p_user) then
    raise exception 'That sign-in already belongs to someone on the team.';
  end if;

  insert into employees (name, position, phone, user_id, started_on, note)
  values (btrim(p_name), btrim(p_position), nullif(btrim(coalesce(p_phone, '')), ''),
          p_user, coalesce(p_started, current_date),
          nullif(btrim(coalesce(p_note, '')), ''))
  returning id into new_id;
  return new_id;
end;
$$;

create or replace function update_employee(
  p_id bigint, p_name text, p_position text, p_phone text default null,
  p_user bigint default null, p_note text default null) returns void
language plpgsql security definer as $$
begin
  perform require_role('admin');
  if p_user is not null
     and exists (select 1 from employees where user_id = p_user and id <> p_id) then
    raise exception 'That sign-in already belongs to someone else on the team.';
  end if;

  update employees
     set name = btrim(p_name), position = btrim(p_position),
         phone = nullif(btrim(coalesce(p_phone, '')), ''),
         user_id = p_user,
         note = nullif(btrim(coalesce(p_note, '')), '')
   where id = p_id;
  if not found then raise exception 'No such person.'; end if;
end;
$$;

-- Leaving is dated, not deleted. Somebody who worked here in March is part of
-- March's hours forever, and a delete would quietly rewrite that.
create or replace function end_employment(p_id bigint, p_on date default null)
returns void language plpgsql security definer as $$
begin
  perform require_role('admin');
  update employees set ended_on = coalesce(p_on, current_date) where id = p_id;
  if not found then raise exception 'No such person.'; end if;
  update shifts set ended_at = now(), ended_by = current_actor()
   where employee_id = p_id and ended_at is null;
end;
$$;

create or replace function set_employee_photo(p_id bigint, p_mime text, p_bytes bytea)
returns void language plpgsql security definer as $$
begin
  perform require_role('admin');
  if not exists (select 1 from employees where id = p_id) then
    raise exception 'No such person.';
  end if;
  insert into employee_photos (employee_id, mime, bytes)
  values (p_id, p_mime, p_bytes)
  on conflict (employee_id) do update
    set mime = excluded.mime, bytes = excluded.bytes, updated_at = now();
end;
$$;

-- ---------------------------------------------------------------------------
-- Clocking on and off
--
-- Done at the counter, by whoever is running it, and every one of these writes
-- the actor into the row. An hours record whose entries cannot be traced back
-- to who made them is a record nobody can argue with — which is worse, not
-- better, when there is a disagreement about pay.
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

  insert into shifts (employee_id) values (p_employee) returning id into new_id;
  return new_id;
end;
$$;

create or replace function clock_out(p_employee bigint) returns interval
language plpgsql security definer as $$
declare v_started timestamptz; v_name text;
begin
  perform require_role('admin', 'cashier');
  select e.name into v_name from employees e where e.id = p_employee;

  update shifts set ended_at = now(), ended_by = current_actor()
   where employee_id = p_employee and ended_at is null
   returning started_at into v_started;
  if not found then
    raise exception '% is not clocked in.', coalesce(v_name, 'That person');
  end if;
  return now() - v_started;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reading
-- ---------------------------------------------------------------------------
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
                interval '0') as hours_this_week
  from employees e
  left join app_users u on u.id = e.user_id
  left join employee_photos ph on ph.employee_id = e.id
  left join shifts s on s.employee_id = e.id and s.ended_at is null
 order by (e.ended_on is null) desc, e.name;

create or replace view shifts_recent as
select s.id, s.employee_id, e.name, e.position, s.business_date,
       s.started_at, s.ended_at, s.started_by, s.ended_by,
       coalesce(s.ended_at, now()) - s.started_at as worked
  from shifts s join employees e on e.id = s.employee_id
 order by s.started_at desc
 limit 200;

-- ---------------------------------------------------------------------------
-- Access
--
-- Everybody on staff may see who they work with, and the counter needs the
-- list to clock people on. Shift rows are narrower — a cashier can see them
-- because clocking on is their job, a warehouse hand cannot. Phone numbers,
-- notes and hours worked are the owner's business; the application sends
-- those only to an owner, and the routes are where that is enforced.
-- ---------------------------------------------------------------------------
alter table employees enable row level security;
alter table employee_photos enable row level security;
alter table shifts enable row level security;

create policy staff_read_employees on employees for select
  using (current_role_name() in ('admin', 'warehouse', 'cashier'));
create policy staff_read_photos on employee_photos for select
  using (current_role_name() in ('admin', 'warehouse', 'cashier'));
create policy admin_reads_shifts on shifts for select
  using (current_role_name() in ('admin', 'cashier'));

grant select on employees, employee_photos, shifts, team, shifts_recent to app_client;
grant execute on function add_employee(text, text, text, bigint, date, text) to app_client;
grant execute on function update_employee(bigint, text, text, text, bigint, text) to app_client;
grant execute on function end_employment(bigint, date) to app_client;
grant execute on function set_employee_photo(bigint, text, bytea) to app_client;
grant execute on function clock_in(bigint) to app_client;
grant execute on function clock_out(bigint) to app_client;

alter function add_employee(text, text, text, bigint, date, text) set search_path = public, extensions;
alter function update_employee(bigint, text, text, text, bigint, text) set search_path = public, extensions;
alter function end_employment(bigint, date) set search_path = public, extensions;
alter function set_employee_photo(bigint, text, bytea) set search_path = public, extensions;
alter function clock_in(bigint) set search_path = public, extensions;
alter function clock_out(bigint) set search_path = public, extensions;
revoke all on function add_employee(text, text, text, bigint, date, text) from public;
revoke all on function update_employee(bigint, text, text, text, bigint, text) from public;
revoke all on function end_employment(bigint, date) from public;
revoke all on function set_employee_photo(bigint, text, bytea) from public;
revoke all on function clock_in(bigint) from public;
revoke all on function clock_out(bigint) from public;

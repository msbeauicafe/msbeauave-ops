-- ============================================================================
-- MS BEAU AVE — branches, the foundations
--
-- A shop with two doors is not one shop with a bigger number in it. Sooner or
-- later every count, every till and every payroll line has to say which door
-- it belongs to, and retrofitting that across a working system is a great deal
-- harder than leaving room for it now.
--
-- This lays the ground and stops there, deliberately. What becomes
-- branch-aware here is everything about people: who works where, which door
-- they clock in at, and which shop a sign-in belongs to. Those are safe to
-- split because nothing about them can go wrong quietly — a person is at one
-- branch or another, and if that is wrong somebody notices the same day.
--
-- What is NOT split here is stock, sales and money. That is the harder half
-- and it touches the picking engine: the promise that a unit is never
-- committed twice depends on every path knowing which shelf it is reaching
-- for. Half-splitting it would leave the totals adding up perfectly for the
-- wrong shop, which is the sort of wrong that is found in a stock count three
-- months later. When there is a second branch to test against, that work
-- starts from here rather than from nothing.
--
-- So today the shop trades exactly as it did. What changes is that everything
-- has an address to belong to.
-- ============================================================================

create table branches (
  id         bigint generated always as identity primary key,
  name       text not null unique check (length(btrim(name)) > 0),
  address    text,
  phone      text,
  opens      text,                    -- free text: "9am – 7pm" reads better
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
create trigger branches_audit after insert or update or delete on branches
  for each row execute function write_audit();

-- The shop as it stands. Everything already here belongs to it, because
-- everything already here happened there.
insert into branches (name, address, phone, opens)
values ('Bayan Bayanan', 'Bayan Bayanan, Marikina City', null, '9am – 7pm');

-- People belong somewhere. Not null, because "which branch does this person
-- work at" has an answer for every employee that has ever existed, and a null
-- would quietly mean "not counted anywhere" on the day the second shop opens.
alter table employees add column branch_id bigint references branches (id);
update employees set branch_id = (select id from branches order by id limit 1);
alter table employees alter column branch_id set not null;
create index employees_by_branch on employees (branch_id) where ended_on is null;

-- A sign-in belongs to a branch too, so a shared device by one door knows
-- whose faces to show. Null is meaningful here and means the opposite of a
-- missing value: the owner works across all of them.
alter table app_users add column branch_id bigint references branches (id);
comment on column app_users.branch_id is
  'the branch this sign-in works at; null means every branch, which is the owner';

-- ---------------------------------------------------------------------------
-- Keeping the list
-- ---------------------------------------------------------------------------
create or replace function add_branch(
  p_name text, p_address text default null,
  p_phone text default null, p_opens text default null) returns bigint
language plpgsql security definer as $$
declare new_id bigint;
begin
  perform require_role('admin');
  if length(btrim(coalesce(p_name, ''))) = 0 then
    raise exception 'A branch needs a name.';
  end if;
  if exists (select 1 from branches where lower(name) = lower(btrim(p_name))) then
    raise exception 'There is already a branch called %.', btrim(p_name);
  end if;

  insert into branches (name, address, phone, opens)
  values (btrim(p_name), nullif(btrim(coalesce(p_address, '')), ''),
          nullif(btrim(coalesce(p_phone, '')), ''),
          nullif(btrim(coalesce(p_opens, '')), ''))
  returning id into new_id;
  return new_id;
end;
$$;

create or replace function update_branch(
  p_id bigint, p_name text, p_address text default null,
  p_phone text default null, p_opens text default null) returns void
language plpgsql security definer as $$
begin
  perform require_role('admin');
  if exists (select 1 from branches
              where lower(name) = lower(btrim(p_name)) and id <> p_id) then
    raise exception 'There is already a branch called %.', btrim(p_name);
  end if;

  update branches
     set name = btrim(p_name),
         address = nullif(btrim(coalesce(p_address, '')), ''),
         phone = nullif(btrim(coalesce(p_phone, '')), ''),
         opens = nullif(btrim(coalesce(p_opens, '')), '')
   where id = p_id;
  if not found then raise exception 'No such branch.'; end if;
end;
$$;

-- Closing rather than deleting: a branch that traded is in last year's figures
-- and has to keep existing for them to add up. The one thing it will not do is
-- close a shop that still has people at it — they would end up nowhere.
create or replace function close_branch(p_id bigint) returns void
language plpgsql security definer as $$
declare v_name text; v_people int;
begin
  perform require_role('admin');

  select name into v_name from branches where id = p_id;
  if not found then raise exception 'No such branch.'; end if;

  select count(*) into v_people
    from employees where branch_id = p_id and ended_on is null;
  if v_people > 0 then
    raise exception
      '% still has % on the team. Move them to another branch first.',
      v_name, v_people || case when v_people = 1 then ' person' else ' people' end;
  end if;

  if (select count(*) from branches where active) <= 1 then
    raise exception 'That is the only branch open. There has to be somewhere to trade.';
  end if;

  update branches set active = false where id = p_id;
end;
$$;

create or replace function reopen_branch(p_id bigint) returns void
language plpgsql security definer as $$
begin
  perform require_role('admin');
  update branches set active = true where id = p_id;
  if not found then raise exception 'No such branch.'; end if;
end;
$$;

-- Moving somebody between shops. Its own function rather than a field on the
-- employee editor, because it is a thing that happens on a date and somebody
-- will ask when.
create or replace function move_employee(p_id bigint, p_branch bigint)
returns void language plpgsql security definer as $$
declare v_name text; v_to text;
begin
  perform require_role('admin');

  select name into v_name from employees where id = p_id and ended_on is null;
  if not found then raise exception 'That person is not on the team.'; end if;

  select name into v_to from branches where id = p_branch and active;
  if not found then raise exception 'That branch is not open.'; end if;

  update employees set branch_id = p_branch where id = p_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reading
-- ---------------------------------------------------------------------------
create or replace view branch_list as
select b.id, b.name, b.address, b.phone, b.opens, b.active,
       (select count(*)::int from employees e
         where e.branch_id = b.id and e.ended_on is null) as people,
       (select count(*)::int from employees e
          join shifts s on s.employee_id = e.id and s.ended_at is null
         where e.branch_id = b.id) as on_shift
  from branches b
 order by b.active desc, b.name;

-- The team list gains where each person works.
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
       e.branch_id, br.name as branch
  from employees e
  left join app_users u on u.id = e.user_id
  left join employee_photos ph on ph.employee_id = e.id
  left join shifts s on s.employee_id = e.id and s.ended_at is null
  join branches br on br.id = e.branch_id
 order by (e.ended_on is null) desc, e.name;

grant select on team, branch_list, branches to app_client;

-- ---------------------------------------------------------------------------
-- Taking people on, now that they have somewhere to work
-- ---------------------------------------------------------------------------
create or replace function add_employee(
  p_name text, p_position text, p_phone text default null,
  p_user bigint default null, p_started date default null,
  p_note text default null, p_branch bigint default null) returns bigint
language plpgsql security definer as $$
declare new_id bigint; v_branch bigint;
begin
  perform require_role('admin');
  if p_user is not null and exists (select 1 from employees where user_id = p_user) then
    raise exception 'That sign-in already belongs to someone on the team.';
  end if;

  v_branch := coalesce(p_branch, (select id from branches where active order by id limit 1));
  if not exists (select 1 from branches where id = v_branch and active) then
    raise exception 'That branch is not open.';
  end if;

  insert into employees (name, position, phone, user_id, started_on, note, branch_id)
  values (btrim(p_name), btrim(p_position), nullif(btrim(coalesce(p_phone, '')), ''),
          p_user, coalesce(p_started, current_date),
          nullif(btrim(coalesce(p_note, '')), ''), v_branch)
  returning id into new_id;
  return new_id;
end;
$$;

create or replace function add_employees(p_people jsonb, p_branch bigint default null)
returns jsonb language plpgsql security definer as $$
declare
  person   jsonb;
  n        int := 0;
  v_name   text;
  v_pos    text;
  v_added  int := 0;
  v_seen   text[] := array[]::text[];
  v_branch bigint;
begin
  perform require_role('admin');

  if jsonb_typeof(p_people) <> 'array' or jsonb_array_length(p_people) = 0 then
    raise exception 'That list is empty.';
  end if;

  v_branch := coalesce(p_branch, (select id from branches where active order by id limit 1));
  if not exists (select 1 from branches where id = v_branch and active) then
    raise exception 'That branch is not open.';
  end if;

  for person in select * from jsonb_array_elements(p_people) loop
    n := n + 1;
    v_name := btrim(coalesce(person->>'name', ''));
    v_pos  := btrim(coalesce(person->>'position', ''));
    if v_name = '' then
      raise exception 'Line % has no name.', n;
    end if;
    if v_pos = '' then
      raise exception 'Line % (%) has no position.', n, v_name;
    end if;
    if lower(v_name) = any (v_seen) then
      raise exception '% is on the list twice.', v_name;
    end if;
    v_seen := v_seen || lower(v_name);

    if (person->>'started') is not null and btrim(person->>'started') <> '' then
      begin
        perform (person->>'started')::date;
      exception when others then
        raise exception 'Line % (%): "%" is not a date.', n, v_name, person->>'started';
      end;
    end if;
  end loop;

  for person in select * from jsonb_array_elements(p_people) loop
    insert into employees (name, position, phone, started_on, note, branch_id)
    values (btrim(person->>'name'), btrim(person->>'position'),
            nullif(btrim(coalesce(person->>'phone', '')), ''),
            coalesce(nullif(btrim(coalesce(person->>'started', '')), '')::date, current_date),
            nullif(btrim(coalesce(person->>'note', '')), ''), v_branch);
    v_added := v_added + 1;
  end loop;

  return jsonb_build_object('added', v_added,
    'on_the_team', (select count(*) from employees where ended_on is null));
end;
$$;

-- Hours, per branch as well as per person, so a payroll run can be done one
-- shop at a time.
create or replace function hours_worked(
  p_from date, p_to date, p_branch bigint default null)
returns table (
  employee_id bigint, name text, "position" text, branch text, here boolean,
  days int, hours numeric, still_open int, longest_hours numeric
)
language sql security definer stable as $$
  select e.id, e.name, e.position, br.name, (e.ended_on is null),
         count(distinct s.business_date)::int,
         round(coalesce(sum(extract(epoch from
           coalesce(s.ended_at, now()) - s.started_at)) / 3600, 0)::numeric, 2),
         count(*) filter (where s.ended_at is null)::int,
         round(coalesce(max(extract(epoch from
           coalesce(s.ended_at, now()) - s.started_at)) / 3600, 0)::numeric, 2)
    from employees e
    join branches br on br.id = e.branch_id
    left join shifts s on s.employee_id = e.id
                      and s.business_date between p_from and p_to
   where p_branch is null or e.branch_id = p_branch
   group by e.id, e.name, e.position, br.name, e.ended_on
   having count(s.id) > 0 or e.ended_on is null
   order by br.name, e.name;
$$;

drop function if exists hours_worked(date, date);
drop function if exists add_employee(text, text, text, bigint, date, text);
drop function if exists add_employees(jsonb);

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------
alter table branches enable row level security;
create policy staff_read_branches on branches for select
  using (current_role_name() in ('admin', 'warehouse', 'cashier'));

alter function add_branch(text, text, text, text) set search_path = public, extensions;
alter function update_branch(bigint, text, text, text, text) set search_path = public, extensions;
alter function close_branch(bigint) set search_path = public, extensions;
alter function reopen_branch(bigint) set search_path = public, extensions;
alter function move_employee(bigint, bigint) set search_path = public, extensions;
alter function add_employee(text, text, text, bigint, date, text, bigint)
  set search_path = public, extensions;
alter function add_employees(jsonb, bigint) set search_path = public, extensions;
alter function hours_worked(date, date, bigint) set search_path = public, extensions;

revoke all on function add_branch(text, text, text, text) from public;
revoke all on function update_branch(bigint, text, text, text, text) from public;
revoke all on function close_branch(bigint) from public;
revoke all on function reopen_branch(bigint) from public;
revoke all on function move_employee(bigint, bigint) from public;
revoke all on function add_employee(text, text, text, bigint, date, text, bigint) from public;
revoke all on function add_employees(jsonb, bigint) from public;
revoke all on function hours_worked(date, date, bigint) from public;

grant execute on function add_branch(text, text, text, text) to app_client;
grant execute on function update_branch(bigint, text, text, text, text) to app_client;
grant execute on function close_branch(bigint) to app_client;
grant execute on function reopen_branch(bigint) to app_client;
grant execute on function move_employee(bigint, bigint) to app_client;
grant execute on function add_employee(text, text, text, bigint, date, text, bigint) to app_client;
grant execute on function add_employees(jsonb, bigint) to app_client;
grant execute on function hours_worked(date, date, bigint) to app_client;

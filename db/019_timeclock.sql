-- ============================================================================
-- MS BEAU AVE — a time clock that sixty people can actually use
--
-- Clocking on used to be something a cashier did on somebody's behalf. That is
-- fine for a counter team of five and impossible for sixty: the queue to be
-- clocked in becomes longer than the queue to be served, and the person
-- holding the till ends up vouching for arrivals they did not see.
--
-- So the employee does it themselves, on a shared device by the door. They
-- pick their face and type a PIN. The PIN is not security theatre and it is
-- not a password either — it exists so that one person cannot clock in
-- another, which is the only attack an attendance system really has.
--
-- What this deliberately does not do is pay anybody. Hours are a fact about
-- who was here; wages are a calculation over rates, overtime, night
-- differential, holidays and statutory contributions, and those change by law.
-- This produces clean hours for whatever does the paying.
-- ============================================================================

-- Four digits, hashed like a password. Null means no PIN set yet, and somebody
-- without a PIN cannot use the clock — better than a default everybody knows.
alter table employees add column pin_hash text;
comment on column employees.pin_hash is
  'scrypt hash of the clock PIN; null means this person cannot use the time clock yet';

-- The team list needs to show who still cannot clock on, without the hash ever
-- leaving the database. Appended rather than inserted: a view's existing
-- columns cannot be renamed in place.
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
       (e.pin_hash is not null) as has_pin
  from employees e
  left join app_users u on u.id = e.user_id
  left join employee_photos ph on ph.employee_id = e.id
  left join shifts s on s.employee_id = e.id and s.ended_at is null
 order by (e.ended_on is null) desc, e.name;

grant select on team to app_client;

create or replace function set_employee_pin(p_id bigint, p_hash text)
returns void language plpgsql security definer as $$
begin
  perform require_role('admin');
  update employees set pin_hash = p_hash where id = p_id and ended_on is null;
  if not found then
    raise exception 'No such person on the team.';
  end if;
end;
$$;

-- The application checks the PIN before calling this, because the hashing
-- lives with the rest of the password handling. What the database enforces is
-- everything else: that the person is on the team, and that clocking in twice
-- is impossible.
create or replace function clock_toggle(p_employee bigint)
returns jsonb language plpgsql security definer as $$
declare
  v_name    text;
  v_open    shifts%rowtype;
  v_worked  interval;
begin
  perform require_role('admin', 'cashier', 'warehouse');

  select name into v_name from employees where id = p_employee and ended_on is null;
  if not found then
    raise exception 'That person is not on the team.';
  end if;

  select * into v_open from shifts where employee_id = p_employee and ended_at is null;
  if found then
    update shifts set ended_at = now(), ended_by = current_actor()
     where id = v_open.id
     returning now() - started_at into v_worked;
    return jsonb_build_object('action', 'out', 'name', v_name, 'at', now(),
                              'worked_minutes', round(extract(epoch from v_worked) / 60));
  end if;

  insert into shifts (employee_id) values (p_employee);
  return jsonb_build_object('action', 'in', 'name', v_name, 'at', now());
end;
$$;

-- ---------------------------------------------------------------------------
-- Hours over a period
--
-- "This week" is the wrong window for anybody who pays on the 15th and the
-- 30th. This totals whatever range is asked for, per person, and counts the
-- days as well as the hours — a total of 96 hours means one thing over twelve
-- days and something worth asking about over four.
--
-- An open shift is counted up to now, so the figure is live rather than
-- pretending somebody who forgot to clock out worked nothing.
-- ---------------------------------------------------------------------------
create or replace function hours_worked(p_from date, p_to date)
returns table (
  employee_id bigint, name text, "position" text, here boolean,
  days int, hours numeric, still_open int, longest_hours numeric
)
language sql security definer stable as $$
  select e.id, e.name, e.position, (e.ended_on is null),
         count(distinct s.business_date)::int,
         round(coalesce(sum(extract(epoch from
           coalesce(s.ended_at, now()) - s.started_at)) / 3600, 0)::numeric, 2),
         count(*) filter (where s.ended_at is null)::int,
         round(coalesce(max(extract(epoch from
           coalesce(s.ended_at, now()) - s.started_at)) / 3600, 0)::numeric, 2)
    from employees e
    left join shifts s on s.employee_id = e.id
                      and s.business_date between p_from and p_to
   group by e.id, e.name, e.position, e.ended_on
   having count(s.id) > 0 or e.ended_on is null
   order by e.name;
$$;

-- ---------------------------------------------------------------------------
-- Taking on a lot of people at once
--
-- Sixty people through sixty dialogs is how the sixty-first gets forgotten.
-- Same shape as the price list: everything checked before anything is written.
-- ---------------------------------------------------------------------------
create or replace function add_employees(p_people jsonb)
returns jsonb language plpgsql security definer as $$
declare
  person  jsonb;
  n       int := 0;
  v_name  text;
  v_pos   text;
  v_added int := 0;
  v_seen  text[] := array[]::text[];
begin
  perform require_role('admin');

  if jsonb_typeof(p_people) <> 'array' or jsonb_array_length(p_people) = 0 then
    raise exception 'That list is empty.';
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
    insert into employees (name, position, phone, started_on, note)
    values (btrim(person->>'name'), btrim(person->>'position'),
            nullif(btrim(coalesce(person->>'phone', '')), ''),
            coalesce(nullif(btrim(coalesce(person->>'started', '')), '')::date, current_date),
            nullif(btrim(coalesce(person->>'note', '')), ''));
    v_added := v_added + 1;
  end loop;

  return jsonb_build_object('added', v_added,
    'on_the_team', (select count(*) from employees where ended_on is null));
end;
$$;

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------
alter function set_employee_pin(bigint, text) set search_path = public, extensions;
alter function clock_toggle(bigint)           set search_path = public, extensions;
alter function hours_worked(date, date)       set search_path = public, extensions;
alter function add_employees(jsonb)           set search_path = public, extensions;
revoke all on function set_employee_pin(bigint, text) from public;
revoke all on function clock_toggle(bigint)           from public;
revoke all on function hours_worked(date, date)       from public;
revoke all on function add_employees(jsonb)           from public;
grant execute on function set_employee_pin(bigint, text) to app_client;
grant execute on function clock_toggle(bigint)           to app_client;
grant execute on function hours_worked(date, date)       to app_client;
grant execute on function add_employees(jsonb)           to app_client;

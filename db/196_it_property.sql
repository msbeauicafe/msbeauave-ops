-- IT's company property register: every device, appliance and piece of
-- furniture the company owns that is not on the hardware masterlist — the
-- pantry's water cooler, the hallway's printer, each employee's drawer, chair
-- and table, the cabinets — where it is, who uses it, and what state it is in.
--
-- Where things are is picked from a list (the rooms of the building), never
-- typed, so a location is one place however many times it is chosen. IT can
-- add a room to the list. Every move — to another room or another person —
-- is kept, so an item's history can be read back.
--
-- IT's alone, like the masterlist (db/184): nothing on the tables is granted,
-- every read and write goes through the functions below, which check first.

create table if not exists it_property_locations (
  id    bigint generated always as identity primary key,
  name  text not null check (length(btrim(name)) > 0),
  sort  int not null default 100
);
create unique index if not exists it_property_locations_one on it_property_locations (lower(btrim(name)));
insert into it_property_locations (name, sort) values
  ('Warehouse 1st floor', 10), ('Hallway 1st floor', 20), ('Pantry', 30),
  ('Accounting 2nd floor', 40), ('Head office 2nd floor', 50), ('HR 2nd floor', 60),
  ('2nd floor warehouse stair', 70), ('2nd floor warehouse lobby', 80)
on conflict do nothing;

create table if not exists it_property (
  id            bigint generated always as identity primary key,
  tag           text not null,
  category      text not null check (category in ('device', 'appliance', 'furniture')),
  item          text not null check (length(btrim(item)) > 0),
  brand         text,
  model         text,
  serial_no     text,
  qty           int not null default 1 check (qty > 0),
  location_id   bigint references it_property_locations (id),
  assigned_to   text,
  condition     text not null default 'good'
                check (condition in ('good', 'fair', 'repair', 'broken', 'disposed')),
  acquired_on   date,
  notes         text,
  logged_at     timestamptz not null default now(),
  logged_by     text not null default current_actor(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists it_property_one_tag on it_property (upper(btrim(tag)));

-- Each move: from where and whom, to where and whom, when, by whom.
create table if not exists it_property_moves (
  id            bigint generated always as identity primary key,
  property_id   bigint not null references it_property (id) on delete cascade,
  at            timestamptz not null default now(),
  by_actor      text not null default current_actor(),
  from_location text,
  to_location   text,
  from_person   text,
  to_person     text,
  condition     text,
  note          text
);
create index if not exists it_property_moves_item on it_property_moves (property_id, at desc);

alter table it_property_locations enable row level security;
alter table it_property enable row level security;
alter table it_property_moves enable row level security;
revoke all on it_property_locations from public;
revoke all on it_property from public;
revoke all on it_property_moves from public;

-- The rooms, in the building's order.
create or replace function it_property_locations_all() returns jsonb
language plpgsql stable security definer as $$
begin
  perform it_require_it();
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by sort, name)
                     from it_property_locations), '[]'::jsonb);
end;
$$;
alter function it_property_locations_all() set search_path = public, extensions;

create or replace function it_property_location_add(p_name text) returns bigint
language plpgsql security definer as $$
declare v_id bigint; v_name text := btrim(coalesce(p_name, ''));
begin
  perform it_require_it();
  if v_name = '' then raise exception 'Name the location first.'; end if;
  select id into v_id from it_property_locations where lower(btrim(name)) = lower(v_name);
  if v_id is not null then return v_id; end if;
  insert into it_property_locations (name, sort)
  values (v_name, coalesce((select max(sort) from it_property_locations), 0) + 10)
  returning id into v_id;
  return v_id;
end;
$$;
alter function it_property_location_add(text) set search_path = public, extensions;

-- Every item, newest first, with its room's name and its moves.
create or replace function it_property_all() returns jsonb
language plpgsql stable security definer as $$
begin
  perform it_require_it();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
        'id', p.id, 'tag', p.tag, 'category', p.category, 'item', p.item, 'brand', p.brand,
        'model', p.model, 'serial_no', p.serial_no, 'qty', p.qty,
        'location_id', p.location_id, 'location', l.name, 'assigned_to', p.assigned_to,
        'condition', p.condition, 'acquired_on', p.acquired_on, 'notes', p.notes,
        'logged_at', p.logged_at, 'logged_by', p.logged_by, 'updated_at', p.updated_at,
        'moves', coalesce((select jsonb_agg(jsonb_build_object(
            'at', m.at, 'by', m.by_actor, 'from_location', m.from_location, 'to_location', m.to_location,
            'from_person', m.from_person, 'to_person', m.to_person, 'condition', m.condition, 'note', m.note)
            order by m.at desc, m.id desc)
          from it_property_moves m where m.property_id = p.id), '[]'::jsonb))
      order by p.logged_at desc, p.id desc)
    from it_property p left join it_property_locations l on l.id = p.location_id), '[]'::jsonb);
end;
$$;
alter function it_property_all() set search_path = public, extensions;

-- Add an item, or save one already on the register. A change of room or
-- person is written to its history.
create or replace function it_property_save(p jsonb) returns bigint
language plpgsql security definer as $$
declare
  v_id bigint := nullif(p ->> 'id', '')::bigint;
  v_tag text := upper(btrim(coalesce(p ->> 'tag', '')));
  v_loc bigint := nullif(p ->> 'location_id', '')::bigint;
  v_person text := nullif(btrim(p ->> 'assigned_to'), '');
  v_cond text := coalesce(nullif(p ->> 'condition', ''), 'good');
  v_old it_property;
  v_old_loc text; v_new_loc text;
begin
  perform it_require_it();
  if v_tag = '' then raise exception 'Give it a property tag first.'; end if;
  if coalesce(btrim(p ->> 'item'), '') = '' then raise exception 'What is it? Name the item.'; end if;
  if v_loc is not null and not exists (select 1 from it_property_locations where id = v_loc) then
    raise exception 'Pick a location from the list.';
  end if;
  if exists (select 1 from it_property where upper(btrim(tag)) = v_tag and id is distinct from v_id) then
    raise exception 'Property tag % is already on the register.', v_tag;
  end if;
  select name into v_new_loc from it_property_locations where id = v_loc;

  if v_id is null then
    insert into it_property (tag, category, item, brand, model, serial_no, qty, location_id,
                             assigned_to, condition, acquired_on, notes)
    values (v_tag, p ->> 'category', btrim(p ->> 'item'), nullif(btrim(p ->> 'brand'), ''),
            nullif(btrim(p ->> 'model'), ''), nullif(btrim(p ->> 'serial_no'), ''),
            greatest(coalesce(nullif(p ->> 'qty', '')::int, 1), 1), v_loc, v_person, v_cond,
            nullif(p ->> 'acquired_on', '')::date, nullif(btrim(p ->> 'notes'), ''))
    returning id into v_id;
    insert into it_property_moves (property_id, to_location, to_person, condition, note)
    values (v_id, v_new_loc, v_person, v_cond, 'Added to the register');
    return v_id;
  end if;

  select * into v_old from it_property where id = v_id;
  if not found then raise exception 'There is no such item.'; end if;
  select name into v_old_loc from it_property_locations where id = v_old.location_id;
  update it_property set
    tag = v_tag, category = p ->> 'category', item = btrim(p ->> 'item'),
    brand = nullif(btrim(p ->> 'brand'), ''), model = nullif(btrim(p ->> 'model'), ''),
    serial_no = nullif(btrim(p ->> 'serial_no'), ''),
    qty = greatest(coalesce(nullif(p ->> 'qty', '')::int, 1), 1),
    location_id = v_loc, assigned_to = v_person, condition = v_cond,
    acquired_on = nullif(p ->> 'acquired_on', '')::date, notes = nullif(btrim(p ->> 'notes'), ''),
    updated_at = now()
  where id = v_id;
  if v_old.location_id is distinct from v_loc or v_old.assigned_to is distinct from v_person
     or v_old.condition is distinct from v_cond then
    insert into it_property_moves (property_id, from_location, to_location, from_person, to_person, condition, note)
    values (v_id, v_old_loc, v_new_loc, v_old.assigned_to, v_person, v_cond, nullif(btrim(p ->> 'move_note'), ''));
  end if;
  return v_id;
end;
$$;
alter function it_property_save(jsonb) set search_path = public, extensions;

-- Entered in error. Something the company no longer has is marked
-- Disposed instead, which keeps its history.
create or replace function it_property_delete(p_id bigint) returns void
language plpgsql security definer as $$
begin
  perform it_require_it();
  delete from it_property where id = p_id;
  if not found then raise exception 'There is no such item.'; end if;
end;
$$;
alter function it_property_delete(bigint) set search_path = public, extensions;

revoke all on function it_property_locations_all() from public;
revoke all on function it_property_location_add(text) from public;
revoke all on function it_property_all() from public;
revoke all on function it_property_save(jsonb) from public;
revoke all on function it_property_delete(bigint) from public;
grant execute on function it_property_locations_all() to app_client;
grant execute on function it_property_location_add(text) to app_client;
grant execute on function it_property_all() to app_client;
grant execute on function it_property_save(jsonb) to app_client;
grant execute on function it_property_delete(bigint) to app_client;

-- Company property's photos: pictures of what is in each room — the pantry's
-- water cooler, the hallway's printer and cabinet — filed against the room,
-- and against the item in the picture when IT says which one it is. Kept like
-- a masterlist unit's photos (db/185), and IT's alone the same way: nothing on
-- the table is granted, everything goes through the functions below.

create table if not exists it_property_files (
  id           bigint generated always as identity primary key,
  location_id  bigint not null references it_property_locations (id) on delete cascade,
  property_id  bigint references it_property (id) on delete set null,
  caption      text,
  mime         text   not null,
  bytes        bytea  not null,
  uploaded_by  text   not null default current_actor(),
  uploaded_at  timestamptz not null default now()
);
create index if not exists it_property_files_by_room on it_property_files (location_id, uploaded_at desc);
alter table it_property_files enable row level security;
revoke all on it_property_files from public;

create or replace function it_property_add_file(p_location bigint, p_property bigint, p_caption text,
                                                p_mime text, p_bytes bytea)
returns bigint
language plpgsql security definer as $$
declare v_id bigint;
begin
  perform it_require_it();
  if not exists (select 1 from it_property_locations where id = p_location) then
    raise exception 'There is no such location.';
  end if;
  if p_property is not null and not exists (select 1 from it_property where id = p_property) then
    raise exception 'There is no such item.';
  end if;
  insert into it_property_files (location_id, property_id, caption, mime, bytes)
  values (p_location, p_property, nullif(btrim(p_caption), ''), p_mime, p_bytes)
  returning id into v_id;
  return v_id;
end;
$$;
alter function it_property_add_file(bigint, bigint, text, text, bytea) set search_path = public, extensions;

-- A room's photos, newest first: which file, of which item, not their bytes.
create or replace function it_property_files_of(p_location bigint) returns jsonb
language plpgsql stable security definer as $$
begin
  perform it_require_it();
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', f.id, 'property_id', f.property_id, 'tag', p.tag, 'item', p.item, 'caption', f.caption,
      'uploaded_at', f.uploaded_at, 'uploaded_by', f.uploaded_by) order by f.uploaded_at desc, f.id desc)
    from it_property_files f left join it_property p on p.id = f.property_id
   where f.location_id = p_location), '[]'::jsonb);
end;
$$;
alter function it_property_files_of(bigint) set search_path = public, extensions;

create or replace function it_property_file(p_id bigint)
returns table (mime text, bytes bytea, uploaded_at timestamptz)
language plpgsql stable security definer as $$
begin
  perform it_require_it();
  return query select f.mime, f.bytes, f.uploaded_at from it_property_files f where f.id = p_id;
end;
$$;
alter function it_property_file(bigint) set search_path = public, extensions;

create or replace function it_property_drop_file(p_id bigint) returns void
language plpgsql security definer as $$
begin
  perform it_require_it();
  delete from it_property_files where id = p_id;
  if not found then raise exception 'There is no such photo.'; end if;
end;
$$;
alter function it_property_drop_file(bigint) set search_path = public, extensions;

revoke all on function it_property_add_file(bigint, bigint, text, text, bytea) from public;
revoke all on function it_property_files_of(bigint) from public;
revoke all on function it_property_file(bigint) from public;
revoke all on function it_property_drop_file(bigint) from public;
grant execute on function it_property_add_file(bigint, bigint, text, text, bytea) to app_client;
grant execute on function it_property_files_of(bigint) to app_client;
grant execute on function it_property_file(bigint) to app_client;
grant execute on function it_property_drop_file(bigint) to app_client;

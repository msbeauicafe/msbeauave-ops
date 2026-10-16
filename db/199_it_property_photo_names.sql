-- Company property's photos carry a name — Fire alarm, CCTV camera, Aircon —
-- so a room's pictures can be told apart at a glance. A photo of an item on
-- the register is named after the item when nothing else is given; a photo
-- of the whole room has to be named. A name can be changed afterwards.

create or replace function it_property_add_file(p_location bigint, p_property bigint, p_caption text,
                                                p_mime text, p_bytes bytea)
returns bigint
language plpgsql security definer as $$
declare v_id bigint; v_name text := nullif(btrim(p_caption), '');
begin
  perform it_require_it();
  if not exists (select 1 from it_property_locations where id = p_location) then
    raise exception 'There is no such location.';
  end if;
  if p_property is not null and not exists (select 1 from it_property where id = p_property) then
    raise exception 'There is no such item.';
  end if;
  if v_name is null and p_property is not null then
    select item into v_name from it_property where id = p_property;
  end if;
  if v_name is null then raise exception 'Name the photo first — e.g. Fire alarm.'; end if;
  insert into it_property_files (location_id, property_id, caption, mime, bytes)
  values (p_location, p_property, v_name, p_mime, p_bytes)
  returning id into v_id;
  return v_id;
end;
$$;
alter function it_property_add_file(bigint, bigint, text, text, bytea) set search_path = public, extensions;

create or replace function it_property_rename_file(p_id bigint, p_name text) returns void
language plpgsql security definer as $$
begin
  perform it_require_it();
  if coalesce(btrim(p_name), '') = '' then raise exception 'Give the photo a name.'; end if;
  update it_property_files set caption = btrim(p_name) where id = p_id;
  if not found then raise exception 'There is no such photo.'; end if;
end;
$$;
alter function it_property_rename_file(bigint, text) set search_path = public, extensions;
revoke all on function it_property_rename_file(bigint, text) from public;
grant execute on function it_property_rename_file(bigint, text) to app_client;

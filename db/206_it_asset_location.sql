-- A masterlist unit sits on a floor: the same rooms Company property uses
-- (db/196) — Warehouse 1st floor, HR 2nd floor and the rest. So a desktop or
-- laptop can be found where it is, and Company property's rooms and its
-- Desktop / Laptop kinds show the masterlist's computers in their room.

alter table it_assets add column if not exists location_id bigint references it_property_locations (id);

create or replace function it_asset_json(a it_assets) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'id', a.id, 'tag', a.tag, 'kind', a.kind, 'brand', a.brand, 'model', a.model,
    'serial_no', a.serial_no, 'supplier', a.supplier, 'po_ref', a.po_ref, 'specs', a.specs,
    'condition', to_jsonb(a.condition), 'status', a.status,
    'assigned_to', a.assigned_to, 'department', a.department,
    'deployed_on', a.deployed_on, 'notes', a.notes,
    'logged_at', a.logged_at, 'logged_by', a.logged_by, 'updated_at', a.updated_at,
    'health', a.health, 'last_checked_at', a.last_checked_at, 'checked_by', a.checked_by,
    'location_id', a.location_id,
    'location', (select l.name from it_property_locations l where l.id = a.location_id),
    'checks', coalesce((select jsonb_agg(jsonb_build_object(
                          'at', c.at, 'by', c.by_actor, 'health', c.health, 'note', c.note)
                          order by c.at desc, c.id desc)
                          from (select * from it_asset_checks where asset_id = a.id
                                 order by at desc, id desc limit 10) c), '[]'::jsonb),
    'files', coalesce((select jsonb_agg(jsonb_build_object(
                         'id', f.id, 'kind', f.kind, 'uploaded_at', f.uploaded_at)
                         order by f.kind, f.id)
                         from it_asset_files f where f.asset_id = a.id), '[]'::jsonb));
$$;
alter function it_asset_json(it_assets) set search_path = public, extensions;

-- Where a unit is: a room from the list, or nowhere yet.
create or replace function it_asset_set_location(p_id bigint, p_location bigint) returns void
language plpgsql security definer as $$
begin
  perform it_require_it();
  if p_location is not null and not exists (select 1 from it_property_locations where id = p_location) then
    raise exception 'Pick a location from the list.';
  end if;
  update it_assets set location_id = p_location, updated_at = now() where id = p_id;
  if not found then raise exception 'There is no such asset.'; end if;
end;
$$;
alter function it_asset_set_location(bigint, bigint) set search_path = public, extensions;
revoke all on function it_asset_set_location(bigint, bigint) from public;
grant execute on function it_asset_set_location(bigint, bigint) to app_client;

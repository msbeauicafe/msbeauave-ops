-- IT checks the masterlist's units from time to time. Each check is kept:
-- when, by whom, the unit's health then — working well, needs maintenance,
-- needs replacement, defective — and a note. The unit carries its latest
-- health and the date it was last checked, so the masterlist can show how
-- recently each one was looked at and colour the ones that need something.

alter table it_assets add column if not exists health text not null default 'good';
alter table it_assets drop constraint if exists it_assets_health_check;
alter table it_assets add constraint it_assets_health_check
  check (health in ('good', 'maintenance', 'replace', 'defective'));
alter table it_assets add column if not exists last_checked_at timestamptz;
alter table it_assets add column if not exists checked_by text;

create table if not exists it_asset_checks (
  id         bigint generated always as identity primary key,
  asset_id   bigint not null references it_assets (id) on delete cascade,
  at         timestamptz not null default now(),
  by_actor   text not null default current_actor(),
  health     text not null check (health in ('good', 'maintenance', 'replace', 'defective')),
  note       text
);
create index if not exists it_asset_checks_by_asset on it_asset_checks (asset_id, at desc);
alter table it_asset_checks enable row level security;
revoke all on it_asset_checks from public;

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

-- A check: the unit's health now and a note, dated today, by whoever is IT.
create or replace function it_asset_check(p_id bigint, p jsonb) returns void
language plpgsql security definer as $$
declare v_health text := coalesce(nullif(p ->> 'health', ''), 'good');
begin
  perform it_require_it();
  if v_health not in ('good', 'maintenance', 'replace', 'defective') then
    raise exception 'Pick the unit''s health from the list.';
  end if;
  update it_assets set health = v_health, last_checked_at = now(), checked_by = current_actor(),
         updated_at = now()
   where id = p_id;
  if not found then raise exception 'There is no such asset.'; end if;
  insert into it_asset_checks (asset_id, health, note) values (p_id, v_health, nullif(btrim(p ->> 'note'), ''));
end;
$$;
alter function it_asset_check(bigint, jsonb) set search_path = public, extensions;
revoke all on function it_asset_check(bigint, jsonb) from public;
grant execute on function it_asset_check(bigint, jsonb) to app_client;

-- A unit's paperwork and pictures: the receipt it came with and photos of
-- the unit itself, taken at unboxing. Filed against the one asset they
-- belong to — the same shape a payment's proof photo is kept (db/163) — and,
-- like the masterlist itself (db/184), IT's alone: nothing on the table is
-- granted, everything goes through the functions below.

create table if not exists it_asset_files (
  id          bigint generated always as identity primary key,
  asset_id    bigint not null references it_assets (id) on delete cascade,
  kind        text   not null check (kind in ('receipt', 'photo')),
  mime        text   not null,
  bytes       bytea  not null,
  uploaded_by text   not null default current_actor(),
  uploaded_at timestamptz not null default now()
);
create index if not exists it_asset_files_by_asset on it_asset_files (asset_id);
alter table it_asset_files enable row level security;
revoke all on it_asset_files from public;

create or replace function it_asset_add_file(p_asset bigint, p_kind text, p_mime text, p_bytes bytea)
returns bigint
language plpgsql security definer as $$
declare v_id bigint;
begin
  perform it_require_it();
  if not exists (select 1 from it_assets where id = p_asset) then
    raise exception 'There is no such asset.';
  end if;
  if p_kind not in ('receipt', 'photo') then
    raise exception 'An attachment is a receipt or a photo.';
  end if;
  insert into it_asset_files (asset_id, kind, mime, bytes)
  values (p_asset, p_kind, p_mime, p_bytes)
  returning id into v_id;
  return v_id;
end;
$$;
alter function it_asset_add_file(bigint, text, text, bytea) set search_path = public, extensions;

create or replace function it_asset_file(p_id bigint)
returns table (mime text, bytes bytea, uploaded_at timestamptz)
language plpgsql stable security definer as $$
begin
  perform it_require_it();
  return query select f.mime, f.bytes, f.uploaded_at from it_asset_files f where f.id = p_id;
end;
$$;
alter function it_asset_file(bigint) set search_path = public, extensions;

create or replace function it_asset_drop_file(p_id bigint) returns void
language plpgsql security definer as $$
begin
  perform it_require_it();
  delete from it_asset_files where id = p_id;
  if not found then raise exception 'There is no such attachment.'; end if;
end;
$$;
alter function it_asset_drop_file(bigint) set search_path = public, extensions;

-- Each asset now says what is attached to it — which files, not their bytes.
create or replace function it_asset_json(a it_assets) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'id', a.id, 'tag', a.tag, 'kind', a.kind, 'brand', a.brand, 'model', a.model,
    'serial_no', a.serial_no, 'supplier', a.supplier, 'po_ref', a.po_ref,
    'condition', to_jsonb(a.condition), 'status', a.status,
    'assigned_to', a.assigned_to, 'department', a.department,
    'deployed_on', a.deployed_on, 'notes', a.notes,
    'logged_at', a.logged_at, 'logged_by', a.logged_by, 'updated_at', a.updated_at,
    'files', coalesce((select jsonb_agg(jsonb_build_object(
                         'id', f.id, 'kind', f.kind, 'uploaded_at', f.uploaded_at)
                         order by f.kind, f.id)
                         from it_asset_files f where f.asset_id = a.id), '[]'::jsonb));
$$;
alter function it_asset_json(it_assets) set search_path = public, extensions;

revoke all on function it_asset_add_file(bigint, text, text, bytea) from public;
revoke all on function it_asset_file(bigint) from public;
revoke all on function it_asset_drop_file(bigint) from public;
grant execute on function it_asset_add_file(bigint, text, text, bytea) to app_client;
grant execute on function it_asset_file(bigint) to app_client;
grant execute on function it_asset_drop_file(bigint) to app_client;

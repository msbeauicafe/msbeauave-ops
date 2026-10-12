-- IT's hardware masterlist: every laptop, desktop, phone, monitor and
-- peripheral the company owns, from the day it arrives — received, unboxed,
-- asset-tagged, logged — to who has it now, what is in for repair, and what
-- has been retired.
--
-- Kept in the database, not the browser, for the same reason the tickets are
-- (db/180): a list that lives in one PC's browser is gone the day that
-- browser's data is cleared, and can't be opened from any other desk.
--
-- IT's alone, like the queue (db/182): only the sign-in marked as IT reads or
-- writes it. Nothing on the table is granted; everything goes through the
-- functions below, which check first.

create table if not exists it_assets (
  id           bigint generated always as identity primary key,
  tag          text not null,
  kind         text not null check (kind in ('laptop', 'desktop', 'smartphone', 'monitor', 'peripheral')),
  brand        text not null,
  model        text,
  serial_no    text,
  supplier     text,
  po_ref       text,
  -- Ticked at unboxing: any of brand_new, sealed, unboxed, missing_items.
  condition    text[] not null default '{}',
  status       text not null default 'storage'
               check (status in ('storage', 'assigned', 'repair', 'retired')),
  assigned_to  text,
  department   text,
  deployed_on  date,
  notes        text,
  logged_at    timestamptz not null default now(),
  logged_by    text not null default current_actor(),
  updated_at   timestamptz not null default now(),

  constraint it_assets_condition_known check (
    condition <@ array['brand_new', 'sealed', 'unboxed', 'missing_items']::text[]),
  -- Assigned means assigned to somebody.
  constraint it_assets_assigned_has_someone check (
    status <> 'assigned' or coalesce(btrim(assigned_to), '') <> '')
);
-- One tag, one unit — however it was typed.
create unique index if not exists it_assets_one_tag on it_assets (upper(btrim(tag)));
-- A serial number is the maker's: two units never share one.
create unique index if not exists it_assets_one_serial on it_assets (upper(btrim(serial_no)))
  where coalesce(btrim(serial_no), '') <> '';

alter table it_assets enable row level security;
revoke all on it_assets from public;

create or replace function it_asset_json(a it_assets) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'id', a.id, 'tag', a.tag, 'kind', a.kind, 'brand', a.brand, 'model', a.model,
    'serial_no', a.serial_no, 'supplier', a.supplier, 'po_ref', a.po_ref,
    'condition', to_jsonb(a.condition), 'status', a.status,
    'assigned_to', a.assigned_to, 'department', a.department,
    'deployed_on', a.deployed_on, 'notes', a.notes,
    'logged_at', a.logged_at, 'logged_by', a.logged_by, 'updated_at', a.updated_at);
$$;
alter function it_asset_json(it_assets) set search_path = public, extensions;

create or replace function it_assets_all() returns jsonb
language plpgsql stable security definer as $$
begin
  perform it_require_it();
  return coalesce((select jsonb_agg(it_asset_json(a) order by a.logged_at desc, a.id desc)
                     from it_assets a), '[]'::jsonb);
end;
$$;
alter function it_assets_all() set search_path = public, extensions;

-- Received, unboxed, tagged: onto the masterlist, in storage until somebody
-- is given it.
create or replace function it_asset_add(p jsonb) returns bigint
language plpgsql security definer as $$
declare v_id bigint; v_tag text := upper(btrim(coalesce(p ->> 'tag', '')));
begin
  perform it_require_it();
  if v_tag = '' then raise exception 'Give it an asset tag first.'; end if;
  if coalesce(btrim(p ->> 'brand'), '') = '' then raise exception 'Which brand is it?'; end if;
  if exists (select 1 from it_assets where upper(btrim(tag)) = v_tag) then
    raise exception 'Asset tag % is already on the masterlist.', v_tag;
  end if;
  if coalesce(btrim(p ->> 'serial_no'), '') <> '' and exists (
       select 1 from it_assets where upper(btrim(serial_no)) = upper(btrim(p ->> 'serial_no'))) then
    raise exception 'Serial number % is already logged.', btrim(p ->> 'serial_no');
  end if;

  insert into it_assets (tag, kind, brand, model, serial_no, supplier, po_ref, condition)
  values (v_tag, p ->> 'kind', btrim(p ->> 'brand'),
          nullif(btrim(p ->> 'model'), ''), nullif(btrim(p ->> 'serial_no'), ''),
          nullif(btrim(p ->> 'supplier'), ''), nullif(btrim(p ->> 'po_ref'), ''),
          coalesce(array(select jsonb_array_elements_text(p -> 'condition')), '{}'))
  returning id into v_id;
  return v_id;
end;
$$;
alter function it_asset_add(jsonb) set search_path = public, extensions;

-- Who has it now: assigned, back in storage, in for repair, or retired.
create or replace function it_asset_assign(p_id bigint, p jsonb) returns void
language plpgsql security definer as $$
declare v_status text := coalesce(p ->> 'status', 'assigned');
begin
  perform it_require_it();
  if v_status = 'assigned' and coalesce(btrim(p ->> 'assigned_to'), '') = '' then
    raise exception 'Pick who it is assigned to.';
  end if;
  update it_assets set
    status      = v_status,
    -- Back in storage or retired, nobody has it any more.
    assigned_to = case when v_status in ('storage', 'retired') then null
                       else nullif(btrim(p ->> 'assigned_to'), '') end,
    department  = case when v_status in ('storage', 'retired') then null
                       else nullif(btrim(p ->> 'department'), '') end,
    deployed_on = case when v_status in ('storage', 'retired') then null
                       else nullif(p ->> 'deployed_on', '')::date end,
    notes       = nullif(btrim(p ->> 'notes'), ''),
    updated_at  = now()
  where id = p_id;
  if not found then raise exception 'There is no such asset.'; end if;
end;
$$;
alter function it_asset_assign(bigint, jsonb) set search_path = public, extensions;

revoke all on function it_assets_all() from public;
revoke all on function it_asset_add(jsonb) from public;
revoke all on function it_asset_assign(bigint, jsonb) from public;
grant execute on function it_assets_all() to app_client;
grant execute on function it_asset_add(jsonb) to app_client;
grant execute on function it_asset_assign(bigint, jsonb) to app_client;

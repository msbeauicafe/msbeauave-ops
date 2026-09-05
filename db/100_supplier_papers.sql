-- ============================================================================
-- MS BEAU AVE — a supplier's picture, business details and papers
--
-- The same three things a reseller's profile carries, mirrored onto a supplier:
--   * a PICTURE for their card — shrunk once on the way in, never on the way out;
--   * the BUSINESS DETAILS off their certificate — tax type, trade name,
--     taxpayer name, TIN, address (the last two were already on the row);
--   * their PAPERS — a valid ID, BIR 2303, permit — kept as the image, legible.
-- Suppliers are the stockroom's and the office's, so these are theirs to keep,
-- not admin's alone.
-- ============================================================================

alter table suppliers add column if not exists tax_type      text;
alter table suppliers add column if not exists trade_name    text;
alter table suppliers add column if not exists taxpayer_name text;

create or replace function set_supplier_tax(
  p_id bigint, p_tax_type text, p_trade_name text,
  p_taxpayer text, p_tin text, p_address text
) returns void
language plpgsql security definer as $$
begin
  perform require_role('admin', 'warehouse', 'office');
  update suppliers
     set tax_type      = nullif(btrim(coalesce(p_tax_type, '')), ''),
         trade_name    = nullif(btrim(coalesce(p_trade_name, '')), ''),
         taxpayer_name = nullif(btrim(coalesce(p_taxpayer, '')), ''),
         tin           = nullif(btrim(coalesce(p_tin, '')), ''),
         address       = nullif(btrim(coalesce(p_address, '')), '')
   where id = p_id;
  if not found then raise exception 'There is no supplier with that number.'; end if;
end;
$$;

create table if not exists supplier_photos (
  supplier_id bigint primary key references suppliers (id) on delete cascade,
  mime        text        not null,
  bytes       bytea       not null,
  updated_at  timestamptz not null default now()
);
alter table supplier_photos enable row level security;

create or replace function set_supplier_photo(p_id bigint, p_mime text, p_bytes bytea)
returns void language plpgsql security definer as $$
begin
  perform require_role('admin', 'warehouse', 'office');
  if not exists (select 1 from suppliers where id = p_id) then
    raise exception 'There is no supplier with that number.';
  end if;
  insert into supplier_photos (supplier_id, mime, bytes)
  values (p_id, p_mime, p_bytes)
  on conflict (supplier_id) do update
    set mime = excluded.mime, bytes = excluded.bytes, updated_at = now();
end;
$$;

create or replace function clear_supplier_photo(p_id bigint)
returns void language plpgsql security definer as $$
begin
  perform require_role('admin', 'warehouse', 'office');
  delete from supplier_photos where supplier_id = p_id;
end;
$$;

drop policy if exists staff_read_supplier_photos on supplier_photos;
create policy staff_read_supplier_photos on supplier_photos for select
  using (current_role_name() in ('admin', 'warehouse', 'cashier', 'supervisor', 'office'));

create table if not exists supplier_files (
  id          bigint generated always as identity primary key,
  supplier_id bigint not null references suppliers (id) on delete cascade,
  category    text   not null check (category in ('document')),
  label       text,
  mime        text   not null,
  bytes       bytea  not null,
  uploaded_by text   not null default current_actor(),
  uploaded_at timestamptz not null default now()
);
create index if not exists supplier_files_by_supplier on supplier_files (supplier_id);
alter table supplier_files enable row level security;

create or replace function add_supplier_file(
  p_supplier bigint, p_label text, p_mime text, p_bytes bytea
) returns bigint
language plpgsql security definer as $$
declare v_id bigint;
begin
  perform require_role('admin', 'warehouse', 'office');
  if not exists (select 1 from suppliers where id = p_supplier) then
    raise exception 'There is no supplier with that number.';
  end if;
  insert into supplier_files (supplier_id, category, label, mime, bytes)
  values (p_supplier, 'document', nullif(btrim(coalesce(p_label, '')), ''), p_mime, p_bytes)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function remove_supplier_file(p_file bigint)
returns void language plpgsql security definer as $$
begin
  perform require_role('admin', 'warehouse', 'office');
  delete from supplier_files where id = p_file;
  if not found then raise exception 'There is no such file.'; end if;
end;
$$;

drop policy if exists stock_supplier_files on supplier_files;
create policy stock_supplier_files on supplier_files for all
  using (current_role_name() in ('admin', 'warehouse', 'office'))
  with check (current_role_name() in ('admin', 'warehouse', 'office'));

grant select on supplier_photos to app_client;
grant select, insert, update, delete on supplier_files to app_client;
grant execute on function set_supplier_tax(bigint, text, text, text, text, text) to app_client;
grant execute on function set_supplier_photo(bigint, text, bytea)              to app_client;
grant execute on function clear_supplier_photo(bigint)                         to app_client;
grant execute on function add_supplier_file(bigint, text, text, bytea)         to app_client;
grant execute on function remove_supplier_file(bigint)                         to app_client;
alter function set_supplier_tax(bigint, text, text, text, text, text) set search_path = public, extensions;
alter function set_supplier_photo(bigint, text, bytea)              set search_path = public, extensions;
alter function clear_supplier_photo(bigint)                         set search_path = public, extensions;
alter function add_supplier_file(bigint, text, text, bytea)         set search_path = public, extensions;
alter function remove_supplier_file(bigint)                         set search_path = public, extensions;

-- ============================================================================
-- MS BEAU AVE — product photographs
--
-- One photo per product, held in the database rather than an object store.
-- That is the right trade at this size: a few dozen products, each picture
-- shrunk in the browser before it is sent, and no second service to configure,
-- pay for, or lose the keys to. If the catalogue ever runs to thousands of
-- products this is the thing to move out first.
--
-- The bytes live in their own table so that `select * from products` — which
-- happens on nearly every screen — does not drag a megabyte of JPEG with it.
-- ============================================================================

create table product_photos (
  sku        text primary key references products (sku) on delete cascade,
  mime       text not null check (mime in ('image/jpeg', 'image/png', 'image/webp')),
  bytes      bytea not null check (length(bytes) between 1 and 900000),
  updated_at timestamptz not null default now(),
  updated_by text not null default current_actor()
);

-- Cheap enough to ask for alongside a product listing, unlike the bytes.
create or replace view product_has_photo as
select p.sku, (ph.sku is not null) as has_photo, ph.updated_at as photo_updated_at
  from products p left join product_photos ph on ph.sku = p.sku;

-- ---------------------------------------------------------------------------
-- Setting one
--
-- Replacing is the normal case — someone re-shoots a product — so this is an
-- upsert rather than an insert the caller has to guess about.
-- ---------------------------------------------------------------------------
create or replace function set_product_photo(p_sku text, p_mime text, p_bytes bytea)
returns void language plpgsql security definer as $$
begin
  if current_role_name() <> 'admin' then
    raise exception 'Only the owner can change product photographs.';
  end if;
  if not exists (select 1 from products where sku = p_sku) then
    raise exception 'There is no product with the code %.', p_sku;
  end if;

  insert into product_photos (sku, mime, bytes)
  values (p_sku, p_mime, p_bytes)
  on conflict (sku) do update
    set mime = excluded.mime, bytes = excluded.bytes,
        updated_at = now(), updated_by = current_actor();
end;
$$;

create or replace function clear_product_photo(p_sku text)
returns void language plpgsql security definer as $$
begin
  if current_role_name() <> 'admin' then
    raise exception 'Only the owner can change product photographs.';
  end if;
  delete from product_photos where sku = p_sku;
end;
$$;

-- ---------------------------------------------------------------------------
-- Access
--
-- A product photograph is public by design: it is the picture a customer sees
-- in the shop. The policy says so plainly rather than leaving the table with
-- row-level security off, so that the intent is recorded rather than inferred.
-- ---------------------------------------------------------------------------
alter table product_photos enable row level security;
create policy photos_are_public on product_photos for select using (true);

grant select on product_photos, product_has_photo to app_client;
grant execute on function set_product_photo(text, text, bytea) to app_client;
grant execute on function clear_product_photo(text) to app_client;

alter function set_product_photo(text, text, bytea) set search_path = public, extensions;
alter function clear_product_photo(text) set search_path = public, extensions;
revoke all on function set_product_photo(text, text, bytea) from public;
revoke all on function clear_product_photo(text) from public;

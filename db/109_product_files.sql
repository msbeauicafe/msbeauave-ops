-- ============================================================================
-- MS BEAU AVE — a product's FDA registration
--
-- The supplier's FDA paper says the company may sell; this one says the product
-- may be sold. They are different papers, asked for by different people, and
-- they expire on different days — so the registration is kept beside the
-- product it registers rather than in the supplier's pile.
-- ============================================================================

create table if not exists product_files (
  id          bigint generated always as identity primary key,
  sku         text not null references products (sku) on delete cascade,
  category    text not null check (category in ('fda')),
  label       text,
  mime        text not null,
  bytes       bytea not null check (length(bytes) between 1 and 3000000),
  uploaded_at timestamptz not null default now(),
  uploaded_by text not null default current_actor()
);
create index if not exists product_files_by_sku on product_files (sku);
alter table product_files enable row level security;
drop policy if exists stock_reads_product_files on product_files;
create policy stock_reads_product_files on product_files for select
  using (current_role_name() in ('admin', 'warehouse', 'office', 'supervisor'));
grant select on product_files to app_client;

create or replace function add_product_file(
  p_sku text, p_label text, p_mime text, p_bytes bytea
) returns bigint
language plpgsql security definer as $$
declare v_id bigint;
begin
  perform require_role('admin', 'warehouse', 'office');
  if not exists (select 1 from products where sku = p_sku) then
    raise exception 'There is no product with the code %.', p_sku;
  end if;
  insert into product_files (sku, category, label, mime, bytes)
  values (p_sku, 'fda', nullif(btrim(coalesce(p_label, '')), ''), p_mime, p_bytes)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function remove_product_file(p_file bigint) returns void
language plpgsql security definer as $$
begin
  perform require_role('admin', 'warehouse', 'office');
  delete from product_files where id = p_file;
  if not found then raise exception 'There is no such file.'; end if;
end;
$$;

alter function add_product_file(text, text, text, bytea) set search_path = public, extensions;
alter function remove_product_file(bigint) set search_path = public, extensions;
grant execute on function add_product_file(text, text, text, bytea) to app_client;
grant execute on function remove_product_file(bigint) to app_client;

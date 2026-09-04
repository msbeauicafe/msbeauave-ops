-- ============================================================================
-- MS BEAU AVE — a brand of its own
--
-- A brand used to be only the text a product carried. This makes it a thing you
-- keep: a name, the supplier behind it, their TIN and address. Four boxes, one
-- row per brand, edited on the Brand list.
-- ============================================================================

create table if not exists brands (
  id            bigint generated always as identity primary key,
  brand_name    text   not null,
  supplier_name text,
  tin           text,
  address       text,
  created_at    timestamptz not null default now()
);
create unique index if not exists brands_by_name on brands (lower(brand_name));

alter table brands enable row level security;
drop policy if exists stock_reads_brands on brands;
create policy stock_reads_brands on brands for select
  using (current_role_name() in ('admin', 'warehouse', 'supervisor', 'office'));
grant select on brands to app_client;

create or replace function save_brand(
  p_id bigint, p_brand text, p_supplier_name text, p_tin text, p_address text
) returns bigint
language plpgsql security definer as $$
declare v_id bigint;
begin
  perform require_role('admin', 'warehouse', 'office');
  if length(btrim(coalesce(p_brand, ''))) = 0 then
    raise exception 'A brand needs a name.';
  end if;

  if p_id is null then
    insert into brands (brand_name, supplier_name, tin, address)
    values (btrim(p_brand),
            nullif(btrim(coalesce(p_supplier_name, '')), ''),
            nullif(btrim(coalesce(p_tin, '')), ''),
            nullif(btrim(coalesce(p_address, '')), ''))
    returning id into v_id;
  else
    update brands
       set brand_name    = btrim(p_brand),
           supplier_name = nullif(btrim(coalesce(p_supplier_name, '')), ''),
           tin           = nullif(btrim(coalesce(p_tin, '')), ''),
           address       = nullif(btrim(coalesce(p_address, '')), '')
     where id = p_id returning id into v_id;
    if v_id is null then raise exception 'There is no brand with that number.'; end if;
  end if;
  return v_id;
end;
$$;

alter function save_brand(bigint, text, text, text, text) set search_path = public, extensions;
grant execute on function save_brand(bigint, text, text, text, text) to app_client;

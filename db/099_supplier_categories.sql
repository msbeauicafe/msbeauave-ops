-- ============================================================================
-- MS BEAU AVE — what a supplier supplies
--
-- A supplier is ticked as supplying promos, freebies, products — any of the
-- three. Kept as a list on the row, and folded into save_supplier as a
-- twelve-argument form (the eleven-argument one stays for anything still on it).
-- ============================================================================

alter table suppliers add column if not exists categories text[] not null default '{}';
alter table suppliers drop constraint if exists suppliers_categories_known;
alter table suppliers add constraint suppliers_categories_known
  check (categories <@ array['promo', 'freebies', 'product']::text[]);

create or replace function save_supplier(
  p_id bigint, p_name text, p_brand text, p_tin text, p_address text, p_contact text,
  p_supplier_name text, p_chat text, p_fb text, p_tier text, p_active boolean,
  p_categories text[]
) returns bigint
language plpgsql security definer as $$
declare v_id bigint; v_cats text[];
begin
  perform require_role('admin', 'warehouse', 'office');
  if length(btrim(coalesce(p_name, ''))) = 0 then
    raise exception 'A supplier needs a name.';
  end if;
  v_cats := coalesce(p_categories, '{}');
  if not (v_cats <@ array['promo', 'freebies', 'product']::text[]) then
    raise exception 'A category must be promo, freebies or product.';
  end if;

  if p_id is null then
    insert into suppliers (name, brand_name, tin, address, contact,
                           supplier_name, chat_link, fb_link, tier, active, categories)
    values (btrim(p_name), nullif(btrim(coalesce(p_brand, '')), ''),
            nullif(btrim(coalesce(p_tin, '')), ''),
            nullif(btrim(coalesce(p_address, '')), ''),
            nullif(btrim(coalesce(p_contact, '')), ''),
            nullif(btrim(coalesce(p_supplier_name, '')), ''),
            nullif(btrim(coalesce(p_chat, '')), ''),
            nullif(btrim(coalesce(p_fb, '')), ''),
            case when p_tier = 'distributor' then 'distributor' else 'main' end,
            coalesce(p_active, true), v_cats)
    returning id into v_id;
  else
    update suppliers
       set name          = btrim(p_name),
           brand_name    = nullif(btrim(coalesce(p_brand, '')), ''),
           tin           = nullif(btrim(coalesce(p_tin, '')), ''),
           address       = nullif(btrim(coalesce(p_address, '')), ''),
           contact       = nullif(btrim(coalesce(p_contact, '')), ''),
           supplier_name = nullif(btrim(coalesce(p_supplier_name, '')), ''),
           chat_link     = nullif(btrim(coalesce(p_chat, '')), ''),
           fb_link       = nullif(btrim(coalesce(p_fb, '')), ''),
           tier          = case when p_tier = 'distributor' then 'distributor' else 'main' end,
           active        = coalesce(p_active, true),
           categories    = v_cats
     where id = p_id returning id into v_id;
    if v_id is null then raise exception 'There is no supplier with that number.'; end if;
  end if;
  return v_id;
end;
$$;

alter function save_supplier(bigint, text, text, text, text, text, text, text, text, text, boolean, text[])
  set search_path = public, extensions;
grant execute on function save_supplier(bigint, text, text, text, text, text, text, text, text, text, boolean, text[])
  to app_client;

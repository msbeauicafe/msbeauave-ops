-- ============================================================================
-- MS BEAU AVE — a supplier's tier and standing
--
-- Suppliers now carry a tier — main or distributor — the way accounts carry
-- theirs, and a standing that is simply whether they are active. Active already
-- exists on the row; this adds the tier and folds both into save_supplier as an
-- eleven-argument form (the nine-argument one stays for anything still on it).
-- ============================================================================

alter table suppliers add column if not exists tier text not null default 'main'
  check (tier in ('main', 'distributor'));

create or replace function save_supplier(
  p_id bigint, p_name text, p_brand text, p_tin text, p_address text, p_contact text,
  p_supplier_name text, p_chat text, p_fb text, p_tier text, p_active boolean
) returns bigint
language plpgsql security definer as $$
declare v_id bigint;
begin
  perform require_role('admin', 'warehouse', 'office');
  if length(btrim(coalesce(p_name, ''))) = 0 then
    raise exception 'A supplier needs a name.';
  end if;

  if p_id is null then
    insert into suppliers (name, brand_name, tin, address, contact,
                           supplier_name, chat_link, fb_link, tier, active)
    values (btrim(p_name), nullif(btrim(coalesce(p_brand, '')), ''),
            nullif(btrim(coalesce(p_tin, '')), ''),
            nullif(btrim(coalesce(p_address, '')), ''),
            nullif(btrim(coalesce(p_contact, '')), ''),
            nullif(btrim(coalesce(p_supplier_name, '')), ''),
            nullif(btrim(coalesce(p_chat, '')), ''),
            nullif(btrim(coalesce(p_fb, '')), ''),
            case when p_tier = 'distributor' then 'distributor' else 'main' end,
            coalesce(p_active, true))
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
           active        = coalesce(p_active, true)
     where id = p_id returning id into v_id;
    if v_id is null then raise exception 'There is no supplier with that number.'; end if;
  end if;
  return v_id;
end;
$$;

alter function save_supplier(bigint, text, text, text, text, text, text, text, text, text, boolean)
  set search_path = public, extensions;
grant execute on function save_supplier(bigint, text, text, text, text, text, text, text, text, text, boolean)
  to app_client;

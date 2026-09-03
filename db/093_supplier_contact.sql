-- ============================================================================
-- MS BEAU AVE — more about a supplier
--
-- A supplier was a company name, a brand, a TIN, an address and a contact
-- number. Add the person behind it and the ways they are reached: a supplier
-- name, a group-chat link (opened straight from the screen), and a Facebook
-- account. All optional.
--
-- save_supplier gains a nine-argument form carrying the three new fields; the
-- six-argument one is left in place for anything still calling it.
-- ============================================================================

alter table suppliers add column if not exists supplier_name text;
alter table suppliers add column if not exists chat_link     text;
alter table suppliers add column if not exists fb_link       text;

create or replace function save_supplier(
  p_id bigint, p_name text, p_brand text, p_tin text, p_address text, p_contact text,
  p_supplier_name text, p_chat text, p_fb text
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
                           supplier_name, chat_link, fb_link)
    values (btrim(p_name), nullif(btrim(coalesce(p_brand, '')), ''),
            nullif(btrim(coalesce(p_tin, '')), ''),
            nullif(btrim(coalesce(p_address, '')), ''),
            nullif(btrim(coalesce(p_contact, '')), ''),
            nullif(btrim(coalesce(p_supplier_name, '')), ''),
            nullif(btrim(coalesce(p_chat, '')), ''),
            nullif(btrim(coalesce(p_fb, '')), ''))
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
           fb_link       = nullif(btrim(coalesce(p_fb, '')), '')
     where id = p_id returning id into v_id;
    if v_id is null then raise exception 'There is no supplier with that number.'; end if;
  end if;
  return v_id;
end;
$$;

alter function save_supplier(bigint, text, text, text, text, text, text, text, text)
  set search_path = public, extensions;
grant execute on function save_supplier(bigint, text, text, text, text, text, text, text, text)
  to app_client;

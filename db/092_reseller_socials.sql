-- ============================================================================
-- MS BEAU AVE — where a reseller is reached
--
-- The same channels the shop's loyalty customers carry, now on the wholesale
-- accounts too: a Facebook name, and the links to find them on Facebook and the
-- marketplaces. Free text, each on its own, none required — a badge sits greyed
-- on the list until an address is put against it.
-- ============================================================================

alter table resellers add column if not exists fb_name     text;
alter table resellers add column if not exists fb_link     text;
alter table resellers add column if not exists shopee_link text;
alter table resellers add column if not exists tiktok_link text;
alter table resellers add column if not exists lazada_link text;

create or replace function set_reseller_socials(
  p_id bigint, p_fb_name text, p_fb_link text,
  p_shopee text, p_tiktok text, p_lazada text
) returns void language plpgsql security definer as $$
begin
  perform require_role('admin');
  update resellers set
    fb_name     = nullif(btrim(coalesce(p_fb_name, '')), ''),
    fb_link     = nullif(btrim(coalesce(p_fb_link, '')), ''),
    shopee_link = nullif(btrim(coalesce(p_shopee, '')), ''),
    tiktok_link = nullif(btrim(coalesce(p_tiktok, '')), ''),
    lazada_link = nullif(btrim(coalesce(p_lazada, '')), '')
  where id = p_id;
  if not found then raise exception 'There is no such account.'; end if;
end;
$$;

alter function set_reseller_socials(bigint, text, text, text, text, text)
  set search_path = public, extensions;

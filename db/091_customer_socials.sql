-- ============================================================================
-- MS BEAU AVE — where a shop customer is reached
--
-- The loyalty account was built around what someone bought and the points it
-- earned. But the shop reaches these customers where they already are — on
-- Facebook, and on the marketplaces — so the account now also holds their
-- Facebook name and the links to find them: Facebook, Shopee, TikTok, Lazada.
-- Free text, each on its own, none required.
-- ============================================================================

alter table customers add column if not exists fb_name     text;
alter table customers add column if not exists fb_link     text;
alter table customers add column if not exists shopee_link text;
alter table customers add column if not exists tiktok_link text;
alter table customers add column if not exists lazada_link text;

-- The new columns land at the end of the select: `create or replace view`
-- cannot slot a column in ahead of an existing one, only append.
create or replace view crm_customers as
select c.id, c.name, c.phone, c.points, customer_tier(c.points) as tier,
       c.joined_at, c.joined_via, c.note, c.active,
       (c.password_hash is not null) as claimed,
       coalesce(h.orders, 0)::int as orders,
       coalesce(h.spent, 0)      as spent,
       h.last_bought,
       case
         when h.last_bought is null then 'never bought'
         when h.last_bought > (now() at time zone 'Asia/Manila')::date - 30 then 'active'
         when h.last_bought > (now() at time zone 'Asia/Manila')::date - 90 then 'slipping'
         else 'lapsed'
       end as standing,
       c.fb_name, c.fb_link, c.shopee_link, c.tiktok_link, c.lazada_link
  from customers c
  left join (
    select customer_id, count(*) as orders, sum(total) as spent,
           max((at at time zone 'Asia/Manila')::date) as last_bought
      from customer_history group by customer_id) h on h.customer_id = c.id
 order by c.name;

drop function if exists customer_detail(bigint);
create or replace function customer_detail(p_id bigint)
returns table (id bigint, name text, phone text, points int, tier text,
               joined_at timestamptz, joined_via text, note text, claimed boolean,
               fb_name text, fb_link text, shopee_link text, tiktok_link text,
               lazada_link text,
               orders int, spent numeric, last_bought date, standing text,
               history jsonb)
language sql security definer stable as $$
  select c.id, c.name, c.phone, c.points, c.tier, c.joined_at, c.joined_via,
         c.note, c.claimed,
         c.fb_name, c.fb_link, c.shopee_link, c.tiktok_link, c.lazada_link,
         c.orders, c.spent, c.last_bought, c.standing,
         (select jsonb_agg(jsonb_build_object(
                   'reference', h.reference, 'how', h.how, 'at', h.at,
                   'total', h.total, 'points', h.points_given) order by h.at desc)
            from customer_history h where h.customer_id = c.id)
    from crm_customers c where c.id = p_id;
$$;

create or replace function set_customer_socials(
  p_id bigint, p_fb_name text, p_fb_link text,
  p_shopee text, p_tiktok text, p_lazada text
) returns void language plpgsql security definer as $$
begin
  perform require_role('admin', 'cashier');
  update customers set
    fb_name     = nullif(btrim(coalesce(p_fb_name, '')), ''),
    fb_link     = nullif(btrim(coalesce(p_fb_link, '')), ''),
    shopee_link = nullif(btrim(coalesce(p_shopee, '')), ''),
    tiktok_link = nullif(btrim(coalesce(p_tiktok, '')), ''),
    lazada_link = nullif(btrim(coalesce(p_lazada, '')), '')
  where id = p_id;
  if not found then raise exception 'That customer is not on the list.'; end if;
end;
$$;

alter function customer_detail(bigint) set search_path = public, extensions;
alter function set_customer_socials(bigint, text, text, text, text, text)
  set search_path = public, extensions;

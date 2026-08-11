-- ============================================================================
-- MS BEAU AVE — what the shop window shows
--
-- Everything else in this database is closed to anyone who has not signed in,
-- and it should stay that way. A storefront still needs to show the catalogue
-- to a stranger, so this file opens exactly one door and names what is behind
-- it: the product, its picture, its price, and whether it can be bought today.
--
-- What is deliberately NOT behind that door: how many units are on the shelf,
-- what they cost us, what resellers pay, and anything at all about batches.
-- A shopper is told "in stock" or "sold out" — never the count, which is the
-- kind of figure a competitor would happily read all day.
-- ============================================================================

create or replace function public_catalog(p_term text default '')
returns table (
  sku      text,
  name     text,
  brand    text,
  category text,
  price    numeric,
  in_stock boolean,
  has_photo boolean
)
language sql security definer stable as $$
  select c.sku, c.name, c.brand, c.category, c.retail_price,
         c.on_shelf > 0, ph.has_photo
    from shop_catalog c
    join product_has_photo ph on ph.sku = c.sku
   where coalesce(btrim(p_term), '') = ''
      or c.name ilike '%' || btrim(p_term) || '%'
      or coalesce(c.brand, '') ilike '%' || btrim(p_term) || '%'
      or coalesce(c.category, '') ilike '%' || btrim(p_term) || '%'
   order by (c.on_shelf > 0) desc, c.name
   limit 200;
$$;

-- The chips along the top of the shop. Derived rather than configured, so a
-- new category appears the moment a product is filed under it.
create or replace function public_categories()
returns table (category text, products bigint)
language sql security definer stable as $$
  select c.category, count(*)
    from shop_catalog c
   where c.category is not null
   group by c.category
   order by c.category;
$$;

grant execute on function public_catalog(text) to app_client;
grant execute on function public_categories() to app_client;

alter function public_catalog(text) set search_path = public, extensions;
alter function public_categories() set search_path = public, extensions;
revoke all on function public_catalog(text) from public;
revoke all on function public_categories() from public;

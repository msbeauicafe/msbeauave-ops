-- The shop window stopped at 200 products, and the shop has 867.
--
-- public_catalog was written when the catalogue was small enough that a limit
-- was a formality. It is not any more: 408 products are on a shelf, and the
-- 200 slots fill with those, so every product with nothing on the shelf fell
-- off the end — 667 of them, invisible to a customer no matter how far she
-- scrolled. It was found the day somebody uploaded a photograph of the 250ml
-- lotion, could not see it in the shop, and reasonably concluded the upload
-- had failed. The upload was fine. The product was simply not on the page.
--
-- Sold-out products are worth showing. The card already greys itself and says
-- "Sold out", and a customer who can see the thing exists asks at the counter
-- for it; one who cannot does not know to.
--
-- The ordering is untouched — on the shelf first, then the deepest discount,
-- then by name. Only the floor under the rest of the catalogue is removed.
-- The shape is unchanged too, so this replaces in place rather than dropping.
create or replace function public_catalog(p_term text default '')
returns table (
  sku      text,
  name     text,
  brand    text,
  category text,
  price    numeric,
  was      numeric,
  percent_off numeric,
  in_stock boolean,
  has_photo boolean
)
language sql security definer stable as $$
  select c.sku, c.name, c.brand, c.category,
         c.price_now,
         case when c.percent_off is not null then c.retail_price end,
         c.percent_off,
         c.on_shelf > 0, ph.has_photo
    from shop_catalog c
    join product_has_photo ph on ph.sku = c.sku
   where coalesce(btrim(p_term), '') = ''
      or c.name ilike '%' || btrim(p_term) || '%'
      or coalesce(c.brand, '') ilike '%' || btrim(p_term) || '%'
      or coalesce(c.category, '') ilike '%' || btrim(p_term) || '%'
   order by (c.on_shelf > 0) desc, c.percent_off desc nulls last, c.name
   -- Room for the whole catalogue several times over. A cap still exists so a
   -- runaway import cannot hand somebody's phone a hundred thousand rows.
   limit 5000;
$$;

alter function public_catalog(text) set search_path = public, extensions;

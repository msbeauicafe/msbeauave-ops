-- MS BEAU AVE — the shop's catalogue carries each product's tax type
--
-- The customer shop's Home is laid out like the Reseller Hub now, with the
-- same Filter by tax type and the VAT / Non-VAT / Exempt tag on each card.
-- That needs the tax type (db/191) in what the shop reads. Same rows, same
-- order, one column more; a function's shape can't be changed in place, so it
-- is dropped and made again with the grants it had.

drop function if exists public_catalog(text);

create function public_catalog(p_term text default '')
returns table (
  sku      text,
  name     text,
  brand    text,
  category text,
  price    numeric,
  was      numeric,
  percent_off numeric,
  in_stock boolean,
  has_photo boolean,
  tax_type text
)
language sql security definer stable as $$
  select c.sku, c.name, c.brand, c.category,
         c.price_now,
         case when c.percent_off is not null then c.retail_price end,
         c.percent_off,
         c.on_shelf > 0, ph.has_photo,
         (select p.tax_type from products p where p.sku = c.sku)
    from shop_catalog c
    join product_has_photo ph on ph.sku = c.sku
   where coalesce(btrim(p_term), '') = ''
      or c.name ilike '%' || btrim(p_term) || '%'
      or coalesce(c.brand, '') ilike '%' || btrim(p_term) || '%'
      or coalesce(c.category, '') ilike '%' || btrim(p_term) || '%'
   order by (c.on_shelf > 0) desc, c.percent_off desc nulls last, c.name
   limit 5000;
$$;

alter function public_catalog(text) set search_path = public, extensions;
revoke all on function public_catalog(text) from public;
grant execute on function public_catalog(text) to app_client;

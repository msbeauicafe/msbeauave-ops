-- Two categories are the back office's, not a shopper's.
--
-- TO BE SET means nobody has filed the product yet — 840 of them on the day the
-- blanks were swept into it — and ADS MATERIAL is posters and stands. Neither
-- is something a customer goes looking for, so neither gets a chip in the
-- shop. Their products are untouched and still show under "All".
create or replace function public_categories()
returns table (category text, products bigint)
language sql security definer stable as $$
  select c.category, count(*)
    from shop_catalog c
   where nullif(btrim(c.category), '') is not null
     and upper(btrim(c.category)) not in ('TO BE SET', 'ADS MATERIAL')
   group by c.category
   order by c.category;
$$;

alter function public_categories() set search_path = public, extensions;

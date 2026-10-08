-- A category with no name is not a category a shopper can pick.
--
-- Some products were saved with a blank category, and public_categories only
-- left out null, so the shop drew a chip for '' — an empty pink bubble beside
-- "All", lit up whenever "All" was, because both mean category ''. Those
-- products are still in the shop under "All"; they just get no chip of their
-- own. Spaces alone count as blank too.
create or replace function public_categories()
returns table (category text, products bigint)
language sql security definer stable as $$
  select c.category, count(*)
    from shop_catalog c
   where nullif(btrim(c.category), '') is not null
   group by c.category
   order by c.category;
$$;

alter function public_categories() set search_path = public, extensions;

-- ============================================================================
-- MS BEAU AVE — what a supplier brings, read rather than ticked
--
-- A supplier's categories were three tick boxes on her record. The products
-- already carry a category, and every product carries a brand, so the same
-- fact was stored twice and the two could disagree — which they did, quietly:
-- a product was moved to PROMO and the Brand list went on saying its supplier
-- brought only Product, because nobody thought to open her record and tick a
-- second box.
--
-- Now the products are the fact and this is a way of reading them. A supplier
-- with no products yet shows nothing, which is honest: nobody has brought
-- anything through her.
-- ============================================================================

create or replace function supplier_categories(p_brand text)
returns text[] language sql stable as $$
  select coalesce(array_agg(distinct lower(p.category) order by lower(p.category)), '{}')
    from products p
   where coalesce(btrim(p.brand), '') <> ''
     and lower(btrim(p.brand)) = lower(btrim(coalesce(p_brand, '')))
     and lower(coalesce(p.category, '')) in ('promo', 'freebies', 'product');
$$;

alter function supplier_categories(text) set search_path = public, extensions;
grant execute on function supplier_categories(text) to app_client;

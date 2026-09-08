-- ============================================================================
-- MS BEAU AVE — a product's prices, in the order the shop put them
--
-- Two things were wrong and they are the same thing.
--
-- Changing a row's price name on the product form left the old name behind: the
-- form only ever added, so a kit moved from RD to BUSINESS LEADER came out
-- priced at both, at the same figure, and the list showed it twice. Saving a
-- form should say what a product is priced at, not what it has ever been
-- priced at.
--
-- And the order the tiers read in came from the price list's own sort, so a
-- name put in the first box appeared in the seventh column. The shop decides
-- what its Tier 1 is by which box it types it in; that is a fact about this
-- product, and there was nowhere to keep it.
--
-- So a product's prices are written as a set, in order, in one call. What is
-- not in the set is not a price any more.
-- ============================================================================

alter table product_prices add column if not exists position int;

-- What is already filed keeps reading the way it reads today: the price list's
-- own order, until somebody opens the product and decides otherwise.
update product_prices pp
   set position = c.sort
  from price_codes c
 where c.code = pp.code and pp.position is null;

create or replace function set_product_prices(p_sku text, p_rows jsonb)
returns void language plpgsql security definer as $$
declare v_codes text[];
begin
  perform require_role('admin', 'office', 'hr');
  if not exists (select 1 from products where sku = p_sku) then
    raise exception 'No such product.';
  end if;

  v_codes := coalesce((
    select array_agg(r->>'code')
      from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
     where nullif(btrim(coalesce(r->>'code', '')), '') is not null), '{}');

  -- Gone from the form is gone from the product. This is the half that was
  -- missing, and the reason a renamed tier came back as two.
  delete from product_prices where sku = p_sku and not (code = any (v_codes));

  insert into product_prices (sku, code, price, position)
  select p_sku, r->>'code', (r->>'price')::numeric,
         coalesce((r->>'position')::int, 0)
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
   where nullif(btrim(coalesce(r->>'code', '')), '') is not null
  on conflict (sku, code) do update
     set price = excluded.price, position = excluded.position, set_at = now();
end;
$$;

alter function set_product_prices(text, jsonb) set search_path = public, extensions;
grant execute on function set_product_prices(text, jsonb) to app_client;

-- MS BEAU AVE — a product's tax type: VAT, Non-VAT or Exempt
--
-- Picked on Product list (a dropdown per row, never typed), and read by the
-- reseller's Reseller Hub, whose cards carry the tag and whose Filter by tax
-- type narrows to it. Unset until somebody picks one: a product nobody has
-- said is VAT is not shown as VAT.

alter table products add column if not exists tax_type text;
alter table products drop constraint if exists products_tax_type_check;
alter table products add constraint products_tax_type_check
  check (tax_type is null or tax_type in ('VAT', 'Non-VAT', 'Exempt'));

-- The reseller's catalogue, as db/140 left it, with the tax type at the end.
create or replace view b2b_catalog as
select p.sku, p.name, p.brand, p.category, p.wholesale_price, p.srp,
       coalesce(sum(s.on_hand - s.committed), 0)::int as available,
       p.unit_type,
       (select coalesce(jsonb_object_agg(c.code, pp.price + c.adjust), '{}'::jsonb)
          from price_codes c
          join product_prices pp
            on pp.sku = p.sku
           and pp.code = coalesce(c.base_code, c.code)
         where c.active
           and (c.base_code is null or c.adjust <> 0)) as prices,
       p.tax_type
  from products p
  left join batches b
    on b.sku = p.sku
   and b.expiry > (current_date + make_interval(months => p.reseller_floor_months))::date
  left join stock s on s.batch_id = b.id and s.pool = 'shop'
 where p.active
 group by p.sku, p.name, p.brand, p.category, p.wholesale_price, p.srp, p.unit_type, p.tax_type;

grant select on b2b_catalog to app_client;

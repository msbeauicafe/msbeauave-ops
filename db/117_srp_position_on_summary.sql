-- ============================================================================
-- MS BEAU AVE — carrying SRP's box through to the form
--
-- The column was added to products and the form was taught to read it, and SRP
-- still went back to the top. The form does not read products: it reads the row
-- the product list handed it, and that comes from stock_summary, which had no
-- such column. So the position was written on save, kept in the table, and
-- silently read as "never set" on the way back.
--
-- Appended at the end rather than beside srp, because create-or-replace refuses
-- to move a view's columns about, and the order of them is nobody's business.
-- ============================================================================

create or replace view stock_summary as
 SELECT p.sku,
    p.name,
    p.brand,
    p.category,
    p.unit_cost,
    p.wholesale_price,
    p.srp,
    p.retail_price,
    p.shelf_life_months,
    p.reseller_floor_months,
    p.shelf_min,
    p.abc_class,
    p.active,
    COALESCE(p.alloc_b2b, 0.70) AS alloc_b2b,
    COALESCE(p.alloc_shop, 0.20) AS alloc_shop,
    COALESCE(p.alloc_reserve, 0.10) AS alloc_reserve,
    COALESCE(sum(s.on_hand - s.committed) FILTER (WHERE s.pool = 'b2b'::text), 0::bigint)::integer AS free_b2b,
    COALESCE(sum(s.on_hand - s.committed) FILTER (WHERE s.pool = 'shop'::text), 0::bigint)::integer AS free_shop,
    COALESCE(sum(s.on_hand - s.committed) FILTER (WHERE s.pool = 'reserve'::text), 0::bigint)::integer AS free_reserve,
    COALESCE(sum(s.committed) FILTER (WHERE s.pool = 'b2b'::text), 0::bigint)::integer AS committed_b2b,
    COALESCE(sum(s.on_hand), 0::bigint)::integer AS total_on_hand,
    (COALESCE(sum(s.on_hand), 0::bigint)::numeric * p.unit_cost)::numeric(12,2) AS value_at_cost,
    p.unit_type,
    p.srp_position
   FROM products p
     LEFT JOIN batches b ON b.sku = p.sku AND b.expiry > CURRENT_DATE
     LEFT JOIN stock s ON s.batch_id = b.id
  GROUP BY p.sku;

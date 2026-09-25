-- Product list's Quantity is asked, deliberately, to go back to counting the
-- free-to-sell split rather than the physical count alone (117 moved it the
-- other way, after a delivery with some units already committed read as
-- short). The owner wants it to move with reservations this time — this is
-- what makes that possible, without touching total_on_hand itself, which
-- Purchase order's own product picker still reads as the plain physical count
-- it has always shown.
--
-- Appended at the end rather than beside committed_b2b, for the same reason
-- 117 appended srp_position: create-or-replace refuses to reorder a view's
-- columns, only to add one.

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
    p.srp_position,
    COALESCE(sum(s.committed) FILTER (WHERE s.pool = 'shop'::text), 0::bigint)::integer AS committed_shop
   FROM products p
     LEFT JOIN batches b ON b.sku = p.sku AND b.expiry > CURRENT_DATE
     LEFT JOIN stock s ON s.batch_id = b.id
  GROUP BY p.sku;

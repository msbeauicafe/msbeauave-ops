-- ============================================================================
-- MS BEAU AVE — putting the real catalogue in
--
-- The shop was built against invented products so there was something to test
-- against. Going live means two separate jobs, and they are separate on
-- purpose: erase the practice trading, then load the real product list.
--
-- Doing them in one action would be tidier to call and much worse to live
-- with. Erasing is irreversible and the catalogue is not; a mistake in the
-- product list can be fixed by loading a corrected one, while a mistake in
-- the erase cannot be fixed at all. So they are two decisions, taken twice.
--
-- The rule that keeps this safe is at the bottom of replace_catalogue: a
-- product with no shop price is not on sale. A price list is typed by a person
-- and a person will leave a row blank, and the cost of that must be a product
-- missing from the shelf — visible, and fixed in a minute — rather than a
-- product on the shelf at nothing, which is money gone before anybody notices.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Loading a price list
--
-- The whole catalogue arrives at once, because that is how the brand issues
-- one. Anything already here and not on the new list has stopped being
-- stocked: if it never traded it is deleted outright, and if it has any
-- history at all it is only hidden, because a product that appears in last
-- month's sales has to keep existing for last month's sales to still add up.
-- ---------------------------------------------------------------------------
create or replace function replace_catalogue(p_items jsonb)
returns jsonb language plpgsql security definer as $$
declare
  item      jsonb;
  v_sku     text;
  v_name    text;
  v_srp     numeric(12,2);
  v_retail  numeric(12,2);
  v_seen    text[] := array[]::text[];
  v_added   int := 0;
  v_updated int := 0;
  v_hidden  text[] := array[]::text[];
  v_removed text[] := array[]::text[];
  r         record;
  n         int := 0;
begin
  perform require_role('admin');

  if jsonb_typeof(p_items) <> 'array' then
    raise exception 'The price list has to be a list of products.';
  end if;
  if jsonb_array_length(p_items) = 0 then
    raise exception 'That price list is empty. Nothing has been changed.';
  end if;

  -- Everything is checked before anything is written. Half a catalogue is
  -- worse than none: you cannot tell by looking which half arrived.
  for item in select * from jsonb_array_elements(p_items) loop
    n := n + 1;
    v_sku  := upper(btrim(coalesce(item->>'sku', '')));
    v_name := btrim(coalesce(item->>'name', ''));

    if v_sku = '' then
      raise exception 'Line % has no product code.', n;
    end if;
    if v_name = '' then
      raise exception 'Line % (%) has no product name.', n, v_sku;
    end if;
    if v_sku = any (v_seen) then
      raise exception 'The code % is on the list twice.', v_sku;
    end if;

    v_srp    := coalesce((item->>'srp')::numeric, 0);
    v_retail := coalesce((item->>'retail_price')::numeric, 0);

    if coalesce((item->>'unit_cost')::numeric, 0) < 0
       or coalesce((item->>'wholesale_price')::numeric, 0) < 0
       or v_srp < 0 or v_retail < 0 then
      raise exception 'A price cannot be negative (% ).', v_name;
    end if;
    -- The same floor the product editor holds: we may not undercut the people
    -- who buy from us.
    if v_srp > 0 and v_retail > 0 and v_retail < v_srp then
      raise exception 'Our price for % is %, below the % resellers sell at.',
        v_name, v_retail, v_srp;
    end if;

    v_seen := v_seen || v_sku;
  end loop;

  -- Write.
  for item in select * from jsonb_array_elements(p_items) loop
    v_sku    := upper(btrim(item->>'sku'));
    v_retail := coalesce((item->>'retail_price')::numeric, 0);

    if exists (select 1 from products where sku = v_sku) then
      -- A field left out of the list keeps whatever it already had, so a list
      -- carrying only prices does not quietly wipe the shelf settings.
      update products p set
        name            = btrim(item->>'name'),
        brand           = coalesce(nullif(btrim(coalesce(item->>'brand', '')), ''), p.brand),
        category        = coalesce(nullif(btrim(coalesce(item->>'category', '')), ''), p.category),
        unit_cost       = coalesce((item->>'unit_cost')::numeric, p.unit_cost),
        wholesale_price = coalesce((item->>'wholesale_price')::numeric, p.wholesale_price),
        srp             = coalesce((item->>'srp')::numeric, p.srp),
        retail_price    = coalesce((item->>'retail_price')::numeric, p.retail_price),
        shelf_life_months = coalesce((item->>'shelf_life_months')::int, p.shelf_life_months),
        shelf_min       = coalesce((item->>'shelf_min')::int, p.shelf_min),
        active          = (coalesce((item->>'retail_price')::numeric, p.retail_price) > 0)
      where p.sku = v_sku;
      v_updated := v_updated + 1;
    else
      insert into products (sku, name, brand, category, unit_cost, wholesale_price,
                            srp, retail_price, shelf_life_months, shelf_min, active)
      values (v_sku, btrim(item->>'name'),
              nullif(btrim(coalesce(item->>'brand', '')), ''),
              nullif(btrim(coalesce(item->>'category', '')), ''),
              coalesce((item->>'unit_cost')::numeric, 0),
              coalesce((item->>'wholesale_price')::numeric, 0),
              coalesce((item->>'srp')::numeric, 0),
              v_retail,
              coalesce((item->>'shelf_life_months')::int, 24),
              coalesce((item->>'shelf_min')::int, 0),
              v_retail > 0);
      v_added := v_added + 1;
    end if;
  end loop;

  -- What is no longer stocked.
  for r in select sku, name from products where sku <> all (v_seen) order by name loop
    if exists (select 1 from batches       where sku = r.sku)
    or exists (select 1 from order_lines   where sku = r.sku)
    or exists (select 1 from returns       where sku = r.sku)
    or exists (select 1 from shrinkage     where sku = r.sku)
    or exists (select 1 from stock_counts  where sku = r.sku)
    or exists (select 1 from restock_tasks where sku = r.sku)
    or exists (select 1 from reorder_points where sku = r.sku)
    or exists (select 1 from promos        where sku = r.sku) then
      update products set active = false where sku = r.sku;
      v_hidden := v_hidden || r.name;
    else
      delete from products where sku = r.sku;   -- takes its photograph with it
      v_removed := v_removed || r.name;
    end if;
  end loop;

  return jsonb_build_object(
    'added',    v_added,
    'updated',  v_updated,
    'on_sale',  (select count(*) from products where active),
    'unpriced', (select count(*) from products where retail_price = 0),
    'hidden',   to_jsonb(v_hidden),
    'removed',  to_jsonb(v_removed));
end;
$$;

-- ---------------------------------------------------------------------------
-- Erasing the practice trading
--
-- Everything that was invented to have something to look at: the deliveries,
-- the stock, the sales, the reseller orders and their invoices. What survives
-- is what a real person made — the sign-ins, the staff, the customers who
-- registered, the noticeboard — and the catalogue, which is replaced by the
-- function above rather than by this one.
--
-- The confirmation word is not ceremony. This is the one call in the system
-- with no way back, and it should not be reachable by a mistyped URL or a
-- double-tapped button.
-- ---------------------------------------------------------------------------
create or replace function start_fresh(
  p_confirm text, p_include_resellers boolean default true)
returns jsonb language plpgsql security definer as $$
declare
  v_sales    int;
  v_orders   int;
  v_batches  int;
  v_units    int;
  v_sellers  int := 0;
  v_shells   int := 0;
begin
  perform require_role('admin');
  if upper(btrim(coalesce(p_confirm, ''))) <> 'ERASE' then
    raise exception 'To erase the practice data, type ERASE to confirm.';
  end if;

  select count(*) into v_sales   from sales;
  select count(*) into v_orders  from orders;
  select count(*) into v_batches from batches;
  select coalesce(sum(on_hand), 0) into v_units from stock;

  -- The movement journal refuses to be rewritten, which is exactly what it is
  -- for. Erasing the practice run is the one time that has to be set aside,
  -- and only for the length of this transaction.
  alter table movements disable trigger movements_immutable;

  delete from sale_customers;
  delete from returns;
  delete from payments;
  delete from invoices;
  delete from pickups;
  delete from sales;
  delete from order_lines;
  delete from orders;
  delete from shrinkage;
  delete from movements;
  delete from stock;
  delete from expenses;
  delete from promos;
  delete from batches;
  delete from restock_tasks;
  delete from stock_counts;
  delete from reorder_points;
  delete from cash_counts;

  alter table movements enable trigger movements_immutable;

  if p_include_resellers then
    -- Their logins go with them: a reseller sign-in with no reseller behind it
    -- is not a thing the schema allows to exist.
    delete from reseller_events    where reseller_id in (select id from resellers);
    delete from reseller_documents where reseller_id in (select id from resellers);
    delete from app_users where role = 'reseller';
    delete from resellers;
    get diagnostics v_sellers = row_count;
  end if;

  -- Receipts start at one again. Numbering that carries on from the practice
  -- run would put the first real sale at receipt fifty-something, and every
  -- book that gets checked afterwards would have a gap nobody can explain.
  -- A hidden product with nothing left against it is not a product, it is a
  -- leftover. This matters because the two jobs can be done in either order:
  -- load the real list first and the practice products are hidden rather than
  -- deleted, because at that moment they still have deliveries against them.
  -- Once those are gone there is nothing to preserve, so they go too.
  delete from products p
   where not p.active
     and not exists (select 1 from batches       where sku = p.sku)
     and not exists (select 1 from order_lines   where sku = p.sku)
     and not exists (select 1 from returns       where sku = p.sku)
     and not exists (select 1 from shrinkage     where sku = p.sku)
     and not exists (select 1 from stock_counts  where sku = p.sku)
     and not exists (select 1 from restock_tasks where sku = p.sku)
     and not exists (select 1 from reorder_points where sku = p.sku)
     and not exists (select 1 from promos        where sku = p.sku);
  get diagnostics v_shells = row_count;

  alter sequence receipt_counter restart with 1;

  return jsonb_build_object(
    'products_erased',  v_shells,
    'sales_erased',     v_sales,
    'orders_erased',    v_orders,
    'batches_erased',   v_batches,
    'units_erased',     v_units,
    'resellers_erased', v_sellers);
end;
$$;

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------
alter function replace_catalogue(jsonb) set search_path = public, extensions;
alter function start_fresh(text, boolean) set search_path = public, extensions;
revoke all on function replace_catalogue(jsonb) from public;
revoke all on function start_fresh(text, boolean) from public;
grant execute on function replace_catalogue(jsonb) to app_client;
grant execute on function start_fresh(text, boolean) to app_client;
-- No table grants: both run as the owner, so the application never needs the
-- right to delete a product or a sale in its own name.

-- ============================================================================
-- MS BEAU AVE — removing a product
--
-- A code typed twice, a line added to see what it looked like, a product that
-- never came in — those should be able to go. What must never go is a product
-- the books rest on: one that has been delivered, ordered, sold or promised is
-- the record of that trade, so removal refuses it rather than quietly taking
-- the history with it. Hiding such a product is what the Hide button is for.
-- ============================================================================

create or replace function remove_product(p_sku text) returns void
language plpgsql security definer as $$
declare v products%rowtype;
begin
  perform require_role('admin');

  select * into v from products where sku = p_sku;
  if not found then raise exception 'There is no product with that code.'; end if;

  if exists (select 1 from batches where sku = p_sku) then
    raise exception 'REMOVE_BLOCKED: % has stock or deliveries on record and cannot be removed. Hide it instead.', v.name;
  end if;
  if exists (select 1 from purchase_order_lines where sku = p_sku) then
    raise exception 'REMOVE_BLOCKED: % is on a purchase order and cannot be removed. Hide it instead.', v.name;
  end if;

  delete from products where sku = p_sku;
end;
$$;

alter function remove_product(text) set search_path = public, extensions;
grant execute on function remove_product(text) to app_client;

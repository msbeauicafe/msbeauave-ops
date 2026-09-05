-- ============================================================================
-- MS BEAU AVE — removing a supplier
--
-- A supplier typed to hold a spot, a duplicate, one that never came to
-- anything — those should be able to go, the way a placeholder account can.
-- What must never go is one the books rest on: a supplier with a purchase
-- order or a receiving form against it is the record of what was bought and
-- what arrived, so removal refuses it rather than quietly taking that history.
-- ============================================================================

create or replace function remove_supplier(p_id bigint) returns void
language plpgsql security definer as $$
declare v suppliers%rowtype;
begin
  perform require_role('admin');

  select * into v from suppliers where id = p_id;
  if not found then raise exception 'There is no such supplier.'; end if;

  if exists (select 1 from purchase_orders where supplier_id = p_id)
     or exists (select 1 from receiving_forms where supplier_id = p_id) then
    raise exception 'REMOVE_BLOCKED: % has purchase orders or deliveries on record and cannot be removed.', v.name;
  end if;

  delete from suppliers where id = p_id;
end;
$$;

alter function remove_supplier(bigint) set search_path = public, extensions;
grant execute on function remove_supplier(bigint) to app_client;

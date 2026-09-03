-- ============================================================================
-- MS BEAU AVE — removing an account
--
-- The list fills with placeholders: a name typed to hold a spot, an account
-- opened at the counter that never came to anything, a duplicate. Those should
-- be able to go. What must never go is a customer's trading history — an
-- account that has placed an order, been invoiced, been receipted or holds
-- credit is a record the books rest on, so removal refuses it rather than
-- quietly taking the ledger with it.
--
-- Everything else about an account is its own metadata — the documents and
-- photos filed against it, its application and any invite, its portal login,
-- the event log of tier changes — and that goes with the account. The files,
-- photos and any half-typed order draft fall away on their own (their foreign
-- keys cascade); the rest is cleared here, in front of the delete.
-- ============================================================================

create or replace function remove_reseller(p_id bigint) returns void
language plpgsql security definer as $$
declare v resellers%rowtype;
begin
  perform require_role('admin');

  select * into v from resellers where id = p_id;
  if not found then raise exception 'There is no such account.'; end if;

  if exists (select 1 from orders            where reseller_id = p_id)
     or exists (select 1 from invoices        where reseller_id = p_id)
     or exists (select 1 from reseller_receipts where reseller_id = p_id)
     or exists (select 1 from reseller_credits  where reseller_id = p_id) then
    raise exception 'REMOVE_BLOCKED: % has orders or invoices on record and cannot be removed.', v.name;
  end if;

  delete from reseller_events       where reseller_id = p_id;
  delete from reseller_documents    where reseller_id = p_id;
  delete from reseller_applications where reseller_id = p_id;
  delete from reseller_invites      where reseller_id = p_id;
  delete from app_users             where reseller_id = p_id;

  delete from resellers where id = p_id;
end;
$$;

alter function remove_reseller(bigint) set search_path = public, extensions;

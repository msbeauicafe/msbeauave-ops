-- ============================================================================
-- MS BEAU AVE — a new account is a reseller from the first minute
--
-- Approval was a gate in front of wholesale prices and ordering. Those gates
-- are gone — an order is never refused — so a new account no longer waits in a
-- pending state to be approved. create_reseller opens it active and verified:
-- whoever is entered is already a reseller, ready to be ordered for, with their
-- profile and papers filled in on the account screen that opens next.
-- ============================================================================

create or replace function create_reseller(
  p_name text, p_contact text, p_email text,
  p_tier int, p_limit numeric, p_days int
) returns bigint
language plpgsql security definer as $$
declare v_id bigint;
begin
  perform require_role('admin');
  if coalesce(trim(p_name), '') = '' then
    raise exception 'the business needs a name';
  end if;
  insert into resellers (name, contact, email, tier, credit_limit, terms_days,
                         status, docs_verified)
  values (p_name, p_contact, p_email, coalesce(p_tier, 1),
          coalesce(p_limit, 0), coalesce(p_days, 0), 'active', true)
  returning id into v_id;
  return v_id;
end;
$$;
alter function create_reseller(text, text, text, int, numeric, int)
  set search_path = public, extensions;

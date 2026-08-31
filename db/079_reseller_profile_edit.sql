-- ============================================================================
-- MS BEAU AVE — an account's own details can be edited, on the record
--
-- The terms, the tax block, the picture and the drop-ship name were all
-- editable; the account's own identifying details — its name and how to reach
-- it — were set once when it was created and never again. A name typed wrong,
-- or a number that changed, had no way back.
--
-- This adds that one edit, and like every other change to an account it is
-- written into reseller_events with the actor who made it (the events table
-- already stamps `actor` by itself), so the history says who renamed the
-- account and what it was before.
-- ============================================================================

create or replace function edit_reseller(
  p_id bigint, p_name text, p_contact text, p_email text
) returns void
language plpgsql security definer as $$
declare v_old resellers%rowtype;
begin
  perform require_role('admin');
  select * into v_old from resellers where id = p_id;
  if not found then raise exception 'There is no such account.'; end if;
  if length(btrim(coalesce(p_name, ''))) = 0 then
    raise exception 'An account needs a name.';
  end if;

  update resellers set
    name    = btrim(p_name),
    contact = nullif(btrim(coalesce(p_contact, '')), ''),
    email   = nullif(btrim(coalesce(p_email,   '')), '')
  where id = p_id;

  -- Only write history if something actually changed.
  if v_old.name is distinct from btrim(p_name)
     or v_old.contact is distinct from nullif(btrim(coalesce(p_contact, '')), '')
     or v_old.email   is distinct from nullif(btrim(coalesce(p_email,   '')), '') then
    insert into reseller_events (reseller_id, kind, detail)
    values (p_id, 'details_changed', jsonb_build_object(
      'from', jsonb_build_object('name', v_old.name, 'contact', v_old.contact, 'email', v_old.email),
      'to',   jsonb_build_object('name', btrim(p_name),
                                 'contact', nullif(btrim(coalesce(p_contact, '')), ''),
                                 'email',   nullif(btrim(coalesce(p_email,   '')), ''))));
  end if;
end;
$$;
alter function edit_reseller(bigint, text, text, text) set search_path = public, extensions;
revoke all on function edit_reseller(bigint, text, text, text) from public;
grant execute on function edit_reseller(bigint, text, text, text) to app_client;

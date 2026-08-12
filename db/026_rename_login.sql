-- ============================================================================
-- MS BEAU AVE — renaming a sign-in
--
-- A sign-in could be created, switched off, given a new password, tied to a
-- shop and removed, but never renamed. So an account made in a hurry, or one
-- named after a station rather than a person, was stuck that way — and the
-- only way out was to delete it and make another, which throws away the link
-- to the staff record and, once it has traded, the receipts pointing at it.
--
-- That is a bad trade for a spelling. The password is untouched here: renaming
-- somebody is not the same as letting them back in, and the two should not be
-- one button.
-- ============================================================================

create or replace function rename_login(
  p_user bigint, p_username text, p_display text default null
) returns void language plpgsql security definer as $$
declare v_name text; v_was text;
begin
  perform require_role('admin');

  select username into v_was from app_users where id = p_user;
  if not found then
    raise exception 'There is no such sign-in.';
  end if;

  v_name := btrim(coalesce(p_username, ''));
  if v_name = '' then
    raise exception 'A sign-in needs a username.';
  end if;
  -- The username is typed at the start of every shift, often on a phone by
  -- somebody in a hurry. Spaces in it are a support call waiting to happen.
  if v_name ~ '\s' then
    raise exception 'A username cannot have spaces in it. Try %.',
      lower(replace(v_name, ' ', '.'));
  end if;
  if exists (select 1 from app_users
              where lower(username) = lower(v_name) and id <> p_user) then
    raise exception 'There is already a sign-in called %.', v_name;
  end if;

  update app_users
     set username = v_name,
         display_name = coalesce(nullif(btrim(coalesce(p_display, '')), ''), v_name)
   where id = p_user;
end;
$$;

alter function rename_login(bigint, text, text) set search_path = public, extensions;
revoke all on function rename_login(bigint, text, text) from public;
grant execute on function rename_login(bigint, text, text) to app_client;

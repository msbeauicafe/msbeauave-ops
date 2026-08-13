-- ============================================================================
-- MS BEAU AVE — a username may be a name with a space in it
--
-- Renaming a sign-in refused any username containing a space, on the reasoning
-- that it is typed at the start of every shift and a space is a support call
-- waiting to happen. That is a fair worry and it was the wrong call to make on
-- the owner's behalf: people know their own name, and "sonny lorica" is what
-- this person answers to. Signing in already matches without regard to case,
-- so the only thing a space costs is a tap.
--
-- What is still refused is a username that is only spaces, or one whose spaces
-- would make two accounts look identical — doubled or trailing spaces are
-- invisible on a screen, and an invisible difference between two sign-ins is
-- exactly the kind of thing nobody can debug at seven in the morning.
-- ============================================================================

create or replace function rename_login(
  p_user bigint, p_username text, p_display text default null
) returns void language plpgsql security definer as $$
declare v_name text;
begin
  perform require_role('admin');

  if not exists (select 1 from app_users where id = p_user) then
    raise exception 'There is no such sign-in.';
  end if;

  -- Spaces are allowed inside, but tidied: trimmed at the ends and never
  -- doubled, so what is stored is what a person would type.
  v_name := regexp_replace(btrim(coalesce(p_username, '')), '\s+', ' ', 'g');
  if v_name = '' then
    raise exception 'A sign-in needs a username.';
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

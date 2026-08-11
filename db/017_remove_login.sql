-- ============================================================================
-- MS BEAU AVE — removing a sign-in
--
-- Switching a sign-in off already existed and is the right answer most of the
-- time: somebody on leave, somebody suspended, somebody whose laptop went
-- missing. It ends their session immediately and keeps the row, so the name
-- still means something when you read back through what happened.
--
-- Removing is for the other case — an account created by mistake, a duplicate,
-- a test login — where keeping it is just clutter in a list people read every
-- day.
--
-- Deleting the row is safe here because the audit journal records who did what
-- by name, as text, not by a link to this table. Remove a sign-in and
-- everything it ever did is still attributed to it. The one caveat is that a
-- future sign-in taking the same username would share that history's name,
-- which is a reason to not recycle usernames rather than a reason to keep dead
-- rows forever.
--
-- Three things it refuses, because each of them is a locked door:
--   * the sign-in you are currently using
--   * the last admin left standing
--   * nothing else — but a person on the team keeps their place, and only
--     loses the link to the login that has gone
-- ============================================================================

create or replace function remove_login(p_id bigint)
returns text language plpgsql security definer as $$
declare
  v_user   app_users%rowtype;
  v_admins int;
begin
  perform require_role('admin');

  select * into v_user from app_users where id = p_id;
  if not found then
    raise exception 'There is no sign-in with that number.';
  end if;

  if lower(v_user.username) = lower(current_actor()) then
    raise exception 'That is the sign-in you are using. Ask another admin to remove it.';
  end if;

  if v_user.role = 'admin' and v_user.active then
    select count(*) into v_admins from app_users where role = 'admin' and active;
    if v_admins <= 1 then
      raise exception 'That is the last admin. Give somebody else full access first.';
    end if;
  end if;

  -- Somebody on the team who used this login is still on the team. They lose
  -- the link and nothing else: their hours, their position and their history
  -- are about the person, not about the account they signed in with.
  update employees set user_id = null where user_id = p_id;

  delete from app_users where id = p_id;
  return v_user.username;
end;
$$;

alter function remove_login(bigint) set search_path = public, extensions;
revoke all on function remove_login(bigint) from public;
grant execute on function remove_login(bigint) to app_client;

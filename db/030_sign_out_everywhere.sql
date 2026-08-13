-- ============================================================================
-- MS BEAU AVE — signing a device out from somewhere else
--
-- The clock screen had a Sign out button, which was the wrong place for it. A
-- tablet on a counter is handled by everybody who walks past, and the one
-- control on it that mattered was the one that broke it: pressed by accident,
-- the shop cannot clock anybody in until somebody with a password comes to fix
-- it. Pressed on purpose by whoever wanted the shop's device to themselves, the
-- same. So the button is gone from the door, and the power moves to the owner.
--
-- Sessions here are signed cookies, not rows, so there is nothing to delete —
-- which is the point of them; they survive a serverless container being
-- recycled. What can be done instead is to move a line: every session issued to
-- a sign-in before this moment stops counting. The cookie still verifies, it is
-- simply too old to be believed.
--
-- That makes "sign out everywhere" honest rather than approximate. It ends the
-- tablet's session, and every other session that sign-in has open, on every
-- device, at once — which is what you want the day a phone goes missing.
-- ============================================================================

alter table app_users add column if not exists sessions_from timestamptz not null default now();
comment on column app_users.sessions_from is
  'Sessions issued before this are refused. Signing out everywhere moves it to now.';

create or replace function sign_out_everywhere(p_user bigint) returns text
language plpgsql security definer as $$
declare v_name text;
begin
  perform require_role('admin');

  select display_name into v_name from app_users where id = p_user;
  if not found then
    raise exception 'There is no such sign-in.';
  end if;

  update app_users set sessions_from = now() where id = p_user;
  return v_name;
end;
$$;

alter function sign_out_everywhere(bigint) set search_path = public, extensions;
revoke all on function sign_out_everywhere(bigint) from public;
grant execute on function sign_out_everywhere(bigint) to app_client;

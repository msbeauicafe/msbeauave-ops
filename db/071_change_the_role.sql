-- ============================================================================
-- MS BEAU AVE — moving somebody between roles
--
-- A role was decided once, when the sign-in was made, and never again. So the
-- day two people moved onto the order desk, the only way to do it was somebody
-- with a database console — which is not a way to run a company, and is a
-- worse answer every time somebody is promoted, covers a desk for a week, or
-- leaves the till for the stockroom.
--
-- Two refusals are the whole of the safety here.
--
-- The last owner. Demoting the only admin locks everybody out of the thing
-- that grants admin, and there is no way back in from inside the app. So it is
-- refused while nobody else holds it — give somebody else the keys first.
--
-- A reseller's portal sign-in. That one is bound to their account, and the
-- binding is made when it is created. Moving a portal sign-in to staff would
-- leave a sign-in pointing at a company it can no longer read; moving a member
-- of staff into the portal would leave one pointing at nothing at all. Neither
-- is a role change — it is a different sign-in, and it is made as one.
--
-- Ending their sessions is not a separate act. A session cookie carries the
-- role it was issued with, so a role changed without one is a role that does
-- not change for another twelve hours — on the screen of the one person who
-- has just been told it did.
-- ============================================================================

create or replace function set_login_role(p_user bigint, p_role text) returns text
language plpgsql security definer as $$
declare v_was text; v_name text;
begin
  perform require_role('admin');

  select role, display_name into v_was, v_name from app_users where id = p_user;
  if not found then
    raise exception 'There is no such sign-in.';
  end if;

  if p_role not in ('admin','warehouse','cashier','supervisor','office',
                    'timekeeper','reseller','employee','observer','orderdesk') then
    raise exception '% is not something a sign-in can be.', p_role;
  end if;

  if p_role = v_was then
    return v_name;
  end if;

  if p_role = 'reseller' or v_was = 'reseller' then
    raise exception
      'A portal sign-in belongs to the reseller it was made for. Remove this one and make a new one rather than moving it in or out of the portal.';
  end if;

  if v_was = 'admin'
     and not exists (select 1 from app_users
                      where role = 'admin' and active and id <> p_user) then
    raise exception
      'That is the last owner sign-in, and nobody else could put it back. Give somebody else admin first.';
  end if;

  update app_users
     set role = p_role,
         sessions_from = now()
   where id = p_user;

  return v_name;
end;
$$;

alter function set_login_role(bigint, text) set search_path = public, extensions;
revoke all on function set_login_role(bigint, text) from public;
grant execute on function set_login_role(bigint, text) to app_client;

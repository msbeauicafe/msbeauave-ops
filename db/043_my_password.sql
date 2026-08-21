-- ============================================================================
-- MS BEAU AVE — changing your own password
--
-- Everybody was handed a password on a printed sheet. A password somebody else
-- chose, wrote down and carried through a building is not a secret, and until
-- now the only way to replace it was to ask an owner to do it — which means
-- telling an owner the new one, or having them pick it, which is the same
-- printed sheet again.
--
-- Two functions rather than one, because scrypt cannot be checked in SQL: the
-- API reads the stored hash, compares it to what was typed, and only then
-- writes. Both halves run in the same transaction, so a password cannot change
-- between the check and the write.
--
-- Neither function takes an id. That is the whole boundary — there is no
-- number to change into somebody else's, so an employee cannot aim this at an
-- owner however the request is shaped. It is also why neither calls
-- require_role for a list of roles: every role that can sign in may change its
-- own password, and "its own" is enforced by there being no other option.
--
-- Except one. A door tablet's timekeeper sign-in is a shared device standing
-- in a corridor, and whoever is in front of it is not the tablet. Locking a
-- shop's clock out of its own screen would stop a whole shift clocking on, so
-- that role is refused here as well as being left off the route.
-- ============================================================================

create or replace function my_password_hash() returns text
language plpgsql stable security definer as $$
declare v_hash text;
begin
  if current_setting('app.role', true) = 'timekeeper' then
    raise exception 'A shared device cannot change its own password.';
  end if;
  select u.password_hash into v_hash
    from app_users u
   where lower(u.username) = lower(current_actor()) and u.active;
  if not found then
    raise exception 'That sign-in no longer exists.';
  end if;
  return v_hash;
end;
$$;

create or replace function change_my_password(p_hash text) returns void
language plpgsql security definer as $$
declare n int;
begin
  if current_setting('app.role', true) = 'timekeeper' then
    raise exception 'A shared device cannot change its own password.';
  end if;
  if coalesce(p_hash, '') = '' then
    raise exception 'A password is needed.';
  end if;
  update app_users u set password_hash = p_hash
   where lower(u.username) = lower(current_actor()) and u.active;
  get diagnostics n = row_count;
  if n = 0 then
    raise exception 'That sign-in no longer exists.';
  end if;
end;
$$;

grant execute on function my_password_hash() to app_client;
grant execute on function change_my_password(text) to app_client;
alter function my_password_hash() set search_path = public, extensions;
alter function change_my_password(text) set search_path = public, extensions;

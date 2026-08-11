-- ============================================================================
-- MS BEAU AVE — creating a sign-in, with its mistakes named
--
-- create_login inserted straight into the table and let the constraints do the
-- talking. They do talk, but they say things like
--
--   new row for relation "app_users" violates check constraint
--   "reseller_login_needs_reseller"
--
-- which is a sentence for whoever wrote the schema, not for whoever is
-- standing at the counter trying to give the new girl a login. Each way of
-- getting this wrong now says what went wrong and what to do instead.
-- ============================================================================

create or replace function create_login(
  p_username text, p_display text, p_hash text, p_role text, p_reseller bigint default null
) returns bigint
language plpgsql security definer as $$
declare v_id bigint; v_name text;
begin
  perform require_role('admin');

  if length(btrim(coalesce(p_username, ''))) = 0 then
    raise exception 'A sign-in needs a username.';
  end if;
  if p_role not in ('admin', 'warehouse', 'cashier', 'reseller') then
    raise exception '% is not something a sign-in can be.', p_role;
  end if;

  if exists (select 1 from app_users where lower(username) = lower(btrim(p_username))) then
    raise exception 'There is already a sign-in called %.', btrim(p_username);
  end if;

  -- A reseller portal account is a door into one company's own orders. Without
  -- naming the company there is no door for it to open.
  if p_role = 'reseller' then
    if p_reseller is null then
      raise exception
        'A reseller sign-in has to belong to a reseller. Add the company under Resellers first.';
    end if;
    select name into v_name from resellers where id = p_reseller;
    if not found then
      raise exception 'There is no reseller with that number.';
    end if;
  elsif p_reseller is not null then
    raise exception 'Only a reseller sign-in belongs to a reseller.';
  end if;

  insert into app_users (username, display_name, password_hash, role, reseller_id)
  values (btrim(p_username), coalesce(nullif(btrim(coalesce(p_display, '')), ''), btrim(p_username)),
          p_hash, p_role, p_reseller)
  returning id into v_id;
  return v_id;
end;
$$;

alter function create_login(text, text, text, text, bigint)
  set search_path = public, extensions;
revoke all on function create_login(text, text, text, text, bigint) from public;
grant execute on function create_login(text, text, text, text, bigint) to app_client;

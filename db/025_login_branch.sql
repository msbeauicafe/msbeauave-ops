-- ============================================================================
-- MS BEAU AVE — a sign-in that belongs to one shop
--
-- A cashier works at a shop, not at a company. Until now every sign-in could
-- see and act on every branch, and which shop a sale belonged to was decided
-- by a dropdown — which means it was decided by whoever last touched the
-- dropdown. On a busy Saturday that is a coin toss, and the shop that loses it
-- gets a day's takings it never took and a shelf that disagrees with the room.
--
-- Tying a sign-in to a branch makes that impossible rather than unlikely. The
-- rule is enforced where it cannot be argued with: a tied session's requests
-- land at its own shop whether or not the browser says so, and a tied session
-- asking for a different shop is refused rather than quietly redirected —
-- because silently doing something other than what was asked for is how the
-- takings end up somewhere nobody looks.
--
-- Leaving a sign-in untied is still right for an owner, and for anyone who
-- genuinely covers both shops. Untied means "asks each time", not "any shop by
-- accident".
-- ============================================================================

-- The shop this session belongs to, or null for someone who covers them all.
create or replace function my_branch() returns bigint
language sql stable as $$
  select nullif(current_setting('app.branch_id', true), '')::bigint;
$$;

-- Which shop a request acts on. This is the only place that decides, so that
-- there is one answer and not one per function.
create or replace function branch_or_default(p_wanted bigint) returns bigint
language plpgsql stable as $$
declare v_mine bigint := my_branch(); v_name text;
begin
  if v_mine is null then
    -- Covers every shop: take what was asked for, else the first one open.
    return coalesce(p_wanted, (select id from branches where active order by id limit 1));
  end if;
  if p_wanted is null or p_wanted = v_mine then
    return v_mine;
  end if;
  select name into v_name from branches where id = p_wanted;
  raise exception 'This sign-in works at % and cannot act on %.',
    (select name from branches where id = v_mine), coalesce(v_name, 'another branch')
    using errcode = 'P0010';
end;
$$;

-- Falling back to the session's own shop means a request that names no branch
-- lands where the person is standing, rather than at whichever branch happens
-- to sort first.
create or replace function default_branch() returns bigint
language sql stable as $$
  select coalesce(my_branch(), (select id from branches where active order by id limit 1));
$$;

-- The reading counterpart. Writing has one answer and refuses anything else;
-- reading can legitimately mean "all of them", which is what an owner looking
-- at the whole business wants. A tied session never gets that answer.
create or replace function branch_visible(p_row bigint, p_wanted bigint) returns boolean
language sql stable as $$
  select case
    when my_branch() is not null then p_row = my_branch()
    when p_wanted is not null then p_row = p_wanted
    else true
  end;
$$;

create or replace function set_login_branch(p_user bigint, p_branch bigint default null)
returns void language plpgsql security definer as $$
declare v_role text; v_name text; v_branch text;
begin
  perform require_role('admin');

  select role, display_name into v_role, v_name from app_users where id = p_user;
  if not found then
    raise exception 'There is no such sign-in.';
  end if;
  -- A reseller does not work a shop floor; their branch is their own business.
  if v_role = 'reseller' then
    raise exception 'A reseller sign-in does not belong to one of your shops.';
  end if;

  if p_branch is not null then
    select name into v_branch from branches where id = p_branch and active;
    if not found then
      raise exception 'That branch is not open.';
    end if;
  end if;

  update app_users set branch_id = p_branch where id = p_user;
end;
$$;

alter function my_branch() set search_path = public, extensions;
alter function branch_or_default(bigint) set search_path = public, extensions;
alter function branch_visible(bigint, bigint) set search_path = public, extensions;
alter function default_branch() set search_path = public, extensions;
alter function set_login_branch(bigint, bigint) set search_path = public, extensions;
revoke all on function set_login_branch(bigint, bigint) from public;
grant execute on function set_login_branch(bigint, bigint) to app_client;
grant execute on function my_branch() to app_client;
grant execute on function branch_or_default(bigint) to app_client;
grant execute on function branch_visible(bigint, bigint) to app_client;

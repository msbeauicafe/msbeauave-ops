-- ============================================================================
-- MS BEAU AVE — what a tier means
--
-- Tiers already did something. Tier 1 pays before anything is dispatched;
-- tiers 2 and 3 carry a credit limit that an order is checked against, and
-- days on the invoice. What tiers did not have was a meaning: the limit and
-- the days were typed in per account, so tier 2 could be thirty thousand at
-- fifteen days on one account and five thousand at forty-five on the next,
-- and nothing in the system would notice or object.
--
-- That is fine with three resellers and impossible with thirty. Terms set one
-- account at a time drift, and drift in credit is not a tidiness problem — it
-- is stock leaving the building against a number nobody chose.
--
-- So the ladder becomes a thing that exists. Three rungs, each saying what it
-- is worth. Promoting an account is naming a rung, not retyping two numbers.
--
-- An account can still be given terms of its own, because real trading
-- relationships have exceptions. What changes is that an exception now says
-- it is one: `terms_bespoke` marks the accounts that were deliberately set
-- apart, so the ones that merely drifted stop hiding among them. Editing a
-- rung carries every account still standing on it, and leaves the exceptions
-- exactly where their owner put them.
-- ============================================================================

create table if not exists reseller_tiers (
  tier          int primary key check (tier in (1, 2, 3)),
  name          text not null,
  credit_limit  numeric(12,2) not null default 0 check (credit_limit >= 0),
  terms_days    int not null default 0 check (terms_days >= 0),
  -- Tier 1 is the floor, and it means one thing: nothing ships until the
  -- invoice is paid. Giving it a limit or days would put this table into
  -- disagreement with check_can_ship and raise_invoice, which both read the
  -- tier directly and would go on ignoring whatever was typed here.
  constraint tier_one_is_cash
    check (tier <> 1 or (credit_limit = 0 and terms_days = 0))
);

comment on table reseller_tiers is
  'What each tier is worth. Promoting an account applies these; set_terms overrides them for one account.';

insert into reseller_tiers (tier, name, credit_limit, terms_days) values
  (1, 'Cash on collection', 0,     0),
  (2, 'Standard',           30000, 15),
  (3, 'Preferred',          80000, 30)
on conflict (tier) do nothing;

-- Marks the accounts whose terms were chosen for them rather than inherited.
-- Everything already on file predates the ladder, so nothing starts bespoke:
-- an account that happens to differ is drift, and should be visible as drift.
alter table resellers add column if not exists terms_bespoke boolean not null default false;
comment on column resellers.terms_bespoke is
  'True when this account was deliberately given terms of its own. Editing its tier no longer moves it.';

-- ---------------------------------------------------------------------------
-- Promoting an account: name the rung, take what it is worth.
-- ---------------------------------------------------------------------------
create or replace function set_tier(p_id bigint, p_tier int) returns void
language plpgsql security definer as $$
declare t reseller_tiers%rowtype; v_from int;
begin
  perform require_role('admin');

  select * into t from reseller_tiers where tier = p_tier;
  if not found then
    raise exception 'No such tier: %. The ladder has 1, 2 and 3.', p_tier;
  end if;

  select tier into v_from from resellers where id = p_id;
  if not found then
    raise exception 'No such reseller.';
  end if;

  insert into reseller_events (reseller_id, kind, detail)
  values (p_id, 'terms_changed',
          jsonb_build_object('from_tier', v_from, 'to_tier', p_tier,
                             'limit', t.credit_limit, 'terms_days', t.terms_days,
                             'from_ladder', true, 'by', current_actor()));

  update resellers
     set tier = p_tier, credit_limit = t.credit_limit,
         terms_days = t.terms_days, terms_bespoke = false
   where id = p_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Terms for one account, chosen rather than inherited.
--
-- Re-emitted rather than replaced: the body is the original, plus the one line
-- that records whether what was asked for is what the rung already says. An
-- exception that matches the ladder is not an exception, and marking it as one
-- would freeze the account out of every future change to its own tier.
-- ---------------------------------------------------------------------------
create or replace function set_terms(
  p_id bigint, p_tier int, p_limit numeric, p_days int
) returns void
language plpgsql security definer as $$
declare v_ladder boolean;
begin
  perform require_role('admin');

  select t.credit_limit = p_limit and t.terms_days = p_days
    into v_ladder from reseller_tiers t where t.tier = p_tier;

  insert into reseller_events (reseller_id, kind, detail)
  select id, 'terms_changed',
         jsonb_build_object('from_tier', tier, 'to_tier', p_tier,
                            'limit', p_limit, 'terms_days', p_days,
                            'from_ladder', coalesce(v_ladder, false))
    from resellers where id = p_id;

  update resellers
     set tier = p_tier, credit_limit = p_limit, terms_days = p_days,
         terms_bespoke = not coalesce(v_ladder, false)
   where id = p_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Editing a rung. Everyone standing on it moves with it; the exceptions stay.
-- ---------------------------------------------------------------------------
create or replace function set_tier_ladder(
  p_tier int, p_limit numeric, p_days int
) returns int
language plpgsql security definer as $$
declare v_moved int;
begin
  perform require_role('admin');

  update reseller_tiers
     set credit_limit = p_limit, terms_days = p_days
   where tier = p_tier;
  if not found then
    raise exception 'No such tier: %. The ladder has 1, 2 and 3.', p_tier;
  end if;

  update resellers
     set credit_limit = p_limit, terms_days = p_days
   where tier = p_tier and not terms_bespoke;
  get diagnostics v_moved = row_count;

  insert into reseller_events (reseller_id, kind, detail)
  select id, 'terms_changed',
         jsonb_build_object('from_tier', tier, 'to_tier', tier,
                            'limit', p_limit, 'terms_days', p_days,
                            'from_ladder', true, 'ladder_edited', true,
                            'by', current_actor())
    from resellers where tier = p_tier and not terms_bespoke;

  return v_moved;
end;
$$;

-- ---------------------------------------------------------------------------
-- The accounts that do not match their rung, and whether that was on purpose.
-- ---------------------------------------------------------------------------
create or replace view resellers_off_ladder as
select r.id, r.name, r.tier, t.name as tier_name,
       r.credit_limit, t.credit_limit as tier_credit_limit,
       r.terms_days,   t.terms_days   as tier_terms_days,
       r.terms_bespoke
  from resellers r
  join reseller_tiers t on t.tier = r.tier
 where r.credit_limit <> t.credit_limit or r.terms_days <> t.terms_days
 order by r.terms_bespoke, r.name;

alter table reseller_tiers enable row level security;
drop policy if exists staff_read_tiers on reseller_tiers;
create policy staff_read_tiers on reseller_tiers for select
  using (current_role_name() in ('admin', 'supervisor', 'office'));

grant select on reseller_tiers to app_client;
grant select on resellers_off_ladder to app_client;

alter function set_tier(bigint, int) set search_path = public, extensions;
alter function set_terms(bigint, int, numeric, int) set search_path = public, extensions;
alter function set_tier_ladder(int, numeric, int) set search_path = public, extensions;
revoke all on function set_tier(bigint, int) from public;
revoke all on function set_tier_ladder(int, numeric, int) from public;
grant execute on function set_tier(bigint, int) to app_client;
grant execute on function set_tier_ladder(int, numeric, int) to app_client;

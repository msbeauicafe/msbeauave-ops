-- ============================================================================
-- MS BEAU AVE — a shop that wants to buy from us
--
-- Until now a reseller account began with somebody here typing it in, and the
-- password was chosen for them and read out. That is fine for nine shops and
-- wrong for ninety: the person who ends up knowing the password is whoever
-- was on the phone, the account is never really theirs, and there is nowhere
-- for a shop that finds us on a Sunday to leave their details.
--
-- So it becomes three steps, and the middle one is a person here saying yes.
--
--   apply    — anybody may leave their details. This grants nothing at all.
--   approve  — an owner turns an application into a real account, and gets a
--              one-time link to hand over.
--   claim    — the shop opens that link once and chooses their own username
--              and password. Nobody here ever knows it.
--
-- The step that matters is the middle one. Wholesale prices are the whole
-- reason a reseller account exists, so an account cannot be self-serve all the
-- way through — open registration would hand our cost structure to anybody who
-- filled in a form. Applying is open; being approved is not.
-- ============================================================================

create table reseller_applications (
  id             bigint generated always as identity primary key,
  business_name  text not null check (length(btrim(business_name)) > 0),
  contact_name   text not null check (length(btrim(contact_name)) > 0),
  phone          text,
  email          text,
  address        text,
  note           text,
  status         text not null default 'pending'
                 check (status in ('pending','approved','declined')),
  reseller_id    bigint references resellers (id),
  decided_by     text,
  decided_at     timestamptz,
  decided_note   text,
  created_at     timestamptz not null default now(),

  -- An approved application has an account behind it, and a pending one has
  -- not. Without this the two can drift apart silently.
  constraint approved_has_an_account
    check ((status = 'approved') = (reseller_id is not null)),
  constraint decided_says_who
    check ((status = 'pending') = (decided_by is null))
);
create index reseller_applications_waiting on reseller_applications (created_at)
  where status = 'pending';
create trigger reseller_applications_audit
  after insert or update or delete on reseller_applications
  for each row execute function write_audit();

-- ---------------------------------------------------------------------------
-- The one-time link
--
-- Held as a hash, not as the token itself. A backup of this table, or a glance
-- over somebody's shoulder at a database, must not be enough to take over an
-- account that has not been claimed yet — the same reason a password is not
-- kept in the clear, and for a token the window is smaller but the value is
-- the same: it makes a sign-in.
-- ---------------------------------------------------------------------------
create table reseller_invites (
  id          bigint generated always as identity primary key,
  reseller_id bigint not null references resellers (id),
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  created_by  text not null default current_actor(),
  created_at  timestamptz not null default now(),
  claimed_at  timestamptz,
  claimed_as  text
);
create index reseller_invites_live on reseller_invites (reseller_id)
  where claimed_at is null;

-- ---------------------------------------------------------------------------
-- Applying. The only thing in this file anybody may do without signing in.
-- ---------------------------------------------------------------------------
create or replace function apply_as_reseller(
  p_business text, p_contact text, p_phone text default null,
  p_email text default null, p_address text default null, p_note text default null)
returns bigint
language plpgsql security definer as $$
declare v_id bigint;
begin
  if length(btrim(coalesce(p_business, ''))) = 0 then
    raise exception 'Please give the name of the business.';
  end if;
  if length(btrim(coalesce(p_contact, ''))) = 0 then
    raise exception 'Please give a contact name.';
  end if;
  if length(btrim(coalesce(p_phone, ''))) = 0
     and length(btrim(coalesce(p_email, ''))) = 0 then
    raise exception 'Please leave a phone number or an email address.';
  end if;

  -- The same business applying twice in a week is somebody who did not hear
  -- back, not a second shop. Answered as though it went through, because a
  -- form that says "you already applied" tells a stranger who our resellers
  -- are.
  select id into v_id from reseller_applications
   where lower(btrim(business_name)) = lower(btrim(p_business))
     and status = 'pending'
     and created_at > now() - interval '7 days'
   limit 1;
  if found then return v_id; end if;

  insert into reseller_applications
    (business_name, contact_name, phone, email, address, note)
  values (btrim(p_business), btrim(p_contact),
          nullif(btrim(coalesce(p_phone, '')), ''),
          nullif(btrim(coalesce(p_email, '')), ''),
          nullif(btrim(coalesce(p_address, '')), ''),
          nullif(btrim(coalesce(p_note, '')), ''))
  returning id into v_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Deciding. An owner's job, and the step that keeps wholesale prices ours.
-- ---------------------------------------------------------------------------
create or replace function approve_reseller_application(
  p_id bigint, p_token_hash text, p_tier int default 1,
  p_limit numeric default 0, p_days int default 0, p_days_valid int default 14)
returns bigint
language plpgsql security definer as $$
declare v_app reseller_applications; v_reseller bigint;
begin
  perform require_role('admin');
  select * into v_app from reseller_applications where id = p_id;
  if not found then raise exception 'No such application.'; end if;
  if v_app.status <> 'pending' then
    raise exception 'That application was already %.', v_app.status;
  end if;

  insert into resellers (name, contact, email, tier, credit_limit, terms_days, status)
  values (v_app.business_name, v_app.contact_name, v_app.email,
          coalesce(p_tier, 1), coalesce(p_limit, 0), coalesce(p_days, 0), 'pending')
  returning id into v_reseller;

  insert into reseller_invites (reseller_id, token_hash, expires_at)
  values (v_reseller, p_token_hash,
          now() + make_interval(days => greatest(coalesce(p_days_valid, 14), 1)));

  update reseller_applications
     set status = 'approved', reseller_id = v_reseller,
         decided_by = current_actor(), decided_at = now()
   where id = p_id;

  -- The account is real but has nobody in it yet, and stays 'pending' until
  -- the shop claims the link. An owner looking at Resellers should be able to
  -- see which accounts are still waiting to be picked up.
  return v_reseller;
end;
$$;

create or replace function decline_reseller_application(p_id bigint, p_why text default null)
returns void
language plpgsql security definer as $$
declare v_status text;
begin
  perform require_role('admin');
  select status into v_status from reseller_applications where id = p_id;
  if not found then raise exception 'No such application.'; end if;
  if v_status <> 'pending' then
    raise exception 'That application was already %.', v_status;
  end if;
  update reseller_applications
     set status = 'declined', decided_by = current_actor(), decided_at = now(),
         decided_note = nullif(btrim(coalesce(p_why, '')), '')
   where id = p_id;
end;
$$;

-- Issue another link for an account whose first one expired or went astray.
-- Any earlier unclaimed link for that account stops working, so a token read
-- off somebody's shoulder last month is not still good.
create or replace function reissue_reseller_invite(
  p_reseller bigint, p_token_hash text, p_days_valid int default 14)
returns void
language plpgsql security definer as $$
begin
  perform require_role('admin');
  if not exists (select 1 from resellers where id = p_reseller) then
    raise exception 'No such reseller.';
  end if;
  if exists (select 1 from app_users where reseller_id = p_reseller and active) then
    raise exception 'That reseller already has a sign-in.';
  end if;
  delete from reseller_invites where reseller_id = p_reseller and claimed_at is null;
  insert into reseller_invites (reseller_id, token_hash, expires_at)
  values (p_reseller, p_token_hash,
          now() + make_interval(days => greatest(coalesce(p_days_valid, 14), 1)));
end;
$$;

-- ---------------------------------------------------------------------------
-- Claiming
--
-- Takes the hash of the token rather than the token, so the secret never
-- travels into the database or its logs. Everything is checked here in one
-- statement — that the link exists, has not been used, has not expired, and
-- that the account has nobody in it — because these are the checks that stand
-- between a stranger and a wholesale price list.
-- ---------------------------------------------------------------------------
create or replace function reseller_invite_for(p_token_hash text)
returns table (reseller_id bigint, business text, expires_at timestamptz)
language sql stable security definer as $$
  select i.reseller_id, r.name, i.expires_at
    from reseller_invites i
    join resellers r on r.id = i.reseller_id
   where i.token_hash = p_token_hash
     and i.claimed_at is null
     and i.expires_at > now()
     and not exists (select 1 from app_users u
                      where u.reseller_id = i.reseller_id and u.active);
$$;

create or replace function claim_reseller_invite(
  p_token_hash text, p_username text, p_password_hash text)
returns bigint
language plpgsql security definer as $$
declare v_invite reseller_invites; v_user bigint;
begin
  select * into v_invite from reseller_invites
   where token_hash = p_token_hash and claimed_at is null and expires_at > now()
   for update;
  if not found then
    raise exception 'That link is not valid any more. Ask us for a new one.';
  end if;
  if exists (select 1 from app_users
              where reseller_id = v_invite.reseller_id and active) then
    raise exception 'That account already has a sign-in.';
  end if;

  if length(btrim(coalesce(p_username, ''))) < 3 then
    raise exception 'Choose a username of at least three characters.';
  end if;
  if exists (select 1 from app_users where lower(username) = lower(btrim(p_username))) then
    raise exception 'That username is taken. Try another.';
  end if;

  insert into app_users (username, display_name, password_hash, role, reseller_id)
  values (btrim(p_username),
          (select name from resellers where id = v_invite.reseller_id),
          p_password_hash, 'reseller', v_invite.reseller_id)
  returning id into v_user;

  update reseller_invites
     set claimed_at = now(), claimed_as = btrim(p_username)
   where id = v_invite.id;

  -- Claimed is the moment the account becomes somebody's. Until now it existed
  -- but nobody could open it.
  update resellers set status = 'active'
   where id = v_invite.reseller_id and status = 'pending';
  return v_user;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reading, for an owner
-- ---------------------------------------------------------------------------
create or replace view reseller_signups as
select a.id, a.business_name, a.contact_name, a.phone, a.email, a.address,
       a.note, a.status, a.reseller_id, a.decided_by, a.decided_at,
       a.decided_note, a.created_at,
       (select i.expires_at from reseller_invites i
         where i.reseller_id = a.reseller_id and i.claimed_at is null
         order by i.created_at desc limit 1) as invite_expires,
       (select i.claimed_at from reseller_invites i
         where i.reseller_id = a.reseller_id and i.claimed_at is not null
         order by i.claimed_at desc limit 1) as claimed_at
  from reseller_applications a
 order by (a.status = 'pending') desc, a.created_at desc;

-- ---------------------------------------------------------------------------
-- Access
--
-- No policy names anybody but an owner. Applying and claiming both happen
-- through the functions above, which are the only way in and check everything
-- themselves — a form on the open internet must not be able to read this
-- table, only to add one row to it.
-- ---------------------------------------------------------------------------
alter table reseller_applications enable row level security;
alter table reseller_invites enable row level security;

drop policy if exists admin_reads_signups on reseller_applications;
create policy admin_reads_signups on reseller_applications for select
  using (current_role_name() = 'admin');
drop policy if exists admin_reads_invites on reseller_invites;
create policy admin_reads_invites on reseller_invites for select
  using (current_role_name() = 'admin');

grant select on reseller_applications, reseller_invites, reseller_signups to app_client;
grant execute on function apply_as_reseller(text, text, text, text, text, text) to app_client;
grant execute on function approve_reseller_application(bigint, text, int, numeric, int, int) to app_client;
grant execute on function decline_reseller_application(bigint, text) to app_client;
grant execute on function reissue_reseller_invite(bigint, text, int) to app_client;
grant execute on function reseller_invite_for(text) to app_client;
grant execute on function claim_reseller_invite(text, text, text) to app_client;

alter function apply_as_reseller(text, text, text, text, text, text) set search_path = public, extensions;
alter function approve_reseller_application(bigint, text, int, numeric, int, int) set search_path = public, extensions;
alter function decline_reseller_application(bigint, text) set search_path = public, extensions;
alter function reissue_reseller_invite(bigint, text, int) set search_path = public, extensions;
alter function reseller_invite_for(text) set search_path = public, extensions;
alter function claim_reseller_invite(text, text, text) set search_path = public, extensions;

-- ============================================================================
-- MS BEAU AVE — the people who buy
--
-- Shop customers, kept deliberately apart from app_users. A staff sign-in
-- carries a role and reaches the whole engine; a customer sign-in reaches a
-- name, a points balance and eventually their own orders, and nothing else.
-- Sharing one table between the two would put a shopper one bad policy away
-- from the stock ledger, which is not a mistake worth risking to save a join.
--
-- The phone number is the identity because that is what a shop already asks
-- for at the counter — an email address is a second thing to mistype.
-- ============================================================================

create table customers (
  id            bigint generated always as identity primary key,
  name          text not null check (length(btrim(name)) > 0),
  phone         text not null,
  password_hash text not null,
  points        int not null default 0 check (points >= 0),
  joined_at     timestamptz not null default now(),
  active        boolean not null default true
);

-- Numbers get typed with spaces, dashes, a leading zero, or +63 — and they are
-- all the same person. The last ten digits are what actually identify a
-- Philippine mobile, so that is the key: 0917 555 0148, +63 917 555 0148 and
-- 917-555-0148 all reduce to 9175550148.
create or replace function phone_key(p_phone text) returns text
language sql immutable as $$
  select right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 10);
$$;

create unique index customers_phone on customers (phone_key(phone));

-- ---------------------------------------------------------------------------
-- Standing, from the points balance rather than a column somebody has to
-- remember to update.
-- ---------------------------------------------------------------------------
create or replace function customer_tier(p_points int) returns text
language sql immutable as $$
  select case when p_points >= 2000 then 'Gold'
              when p_points >= 500  then 'Silver'
              else 'Bronze' end;
$$;

create or replace view customer_card as
select c.id, c.name, c.phone, c.points, c.joined_at,
       customer_tier(c.points) as tier,
       case customer_tier(c.points)
         when 'Gold' then 0
         when 'Silver' then 2000 - c.points
         else 500 - c.points
       end as points_to_next
  from customers c
 where c.active;

-- ---------------------------------------------------------------------------
-- Joining and signing in
--
-- The digest is computed by the application, as it is for staff — the database
-- never sees a plaintext password. These run as definer so that a shopper, who
-- holds no database role at all, can still be looked up.
-- ---------------------------------------------------------------------------
create or replace function join_shop(p_name text, p_phone text, p_hash text)
returns bigint language plpgsql security definer as $$
declare new_id bigint;
begin
  if length(phone_key(p_phone)) < 7 then
    raise exception 'That does not look like a phone number.';
  end if;
  if exists (select 1 from customers where phone_key(phone) = phone_key(p_phone)) then
    raise exception 'That number is already registered. Sign in instead.';
  end if;

  insert into customers (name, phone, password_hash)
  values (btrim(p_name), btrim(p_phone), p_hash)
  returning id into new_id;
  return new_id;
end;
$$;

-- Returns the row the application needs to check the password against. It is
-- security definer, so it is written to answer about exactly one number.
create or replace function shop_login(p_phone text)
returns table (id bigint, name text, password_hash text, points int, tier text)
language sql security definer stable as $$
  select c.id, c.name, c.password_hash, c.points, customer_tier(c.points)
    from customers c
   where c.active
     and phone_key(c.phone) = phone_key(p_phone);
$$;

create or replace function shop_customer(p_id bigint)
returns table (id bigint, name text, phone text, points int, tier text, points_to_next int,
               joined_at timestamptz)
language sql security definer stable as $$
  select c.id, c.name, c.phone, c.points, c.tier, c.points_to_next, c.joined_at
    from customer_card c where c.id = p_id;
$$;

-- ---------------------------------------------------------------------------
-- Access
--
-- The table itself is closed. Everything above is a function that answers one
-- narrow question, which is the whole of the public surface.
-- ---------------------------------------------------------------------------
alter table customers enable row level security;
create policy admin_reads_customers on customers for select
  using (current_role_name() = 'admin');

grant select on customers, customer_card to app_client;
grant execute on function join_shop(text, text, text) to app_client;
grant execute on function shop_login(text) to app_client;
grant execute on function shop_customer(bigint) to app_client;
grant execute on function customer_tier(int) to app_client;
grant execute on function phone_key(text) to app_client;

alter function join_shop(text, text, text) set search_path = public, extensions;
alter function shop_login(text) set search_path = public, extensions;
alter function shop_customer(bigint) set search_path = public, extensions;
alter function customer_tier(int) set search_path = public, extensions;
alter function phone_key(text) set search_path = public, extensions;
revoke all on function join_shop(text, text, text) from public;
revoke all on function shop_login(text) from public;
revoke all on function shop_customer(bigint) from public;
revoke all on function customer_tier(int) from public;
revoke all on function phone_key(text) from public;

-- ============================================================================
-- MS BEAU AVE — the customers
--
-- Until now a customer could only exist by signing up in the app, and points
-- could only be earned by reserving in it. That is backwards for a shop where
-- most people walk in: the counter meets them first.
--
-- So two things change. The counter can register somebody in ten seconds with
-- a name and a number, and a walk-in sale can be put against them so the
-- points land. The account it creates has no password until they claim it in
-- the app with the same number — nobody is asked to invent one at the till
-- while a queue forms behind them.
-- ============================================================================

-- A customer registered at the counter has no password yet. Null means "not
-- claimed", which is a different thing from a password that happens to be
-- wrong, and shop_login below is careful about the difference.
alter table customers alter column password_hash drop not null;
alter table customers add column joined_via text not null default 'app'
  check (joined_via in ('app', 'counter'));
alter table customers add column note text;
alter table customers add column last_seen date;

-- ---------------------------------------------------------------------------
-- Registering at the counter
-- ---------------------------------------------------------------------------
create or replace function register_customer(
  p_name text, p_phone text, p_note text default null) returns bigint
language plpgsql security definer as $$
declare existing bigint; new_id bigint;
begin
  perform require_role('admin', 'cashier');
  if length(phone_key(p_phone)) < 7 then
    raise exception 'That does not look like a phone number.';
  end if;

  select id into existing from customers where phone_key(phone) = phone_key(p_phone);
  if existing is not null then
    raise exception 'That number is already on the list.';
  end if;

  insert into customers (name, phone, password_hash, joined_via, note)
  values (btrim(p_name), btrim(p_phone), null, 'counter',
          nullif(btrim(coalesce(p_note, '')), ''))
  returning id into new_id;
  return new_id;
end;
$$;

-- Joining in the app now also claims a counter-registered account, so somebody
-- the shop signed up does not end up with a second, empty one — and their
-- points are waiting for them when they do.
create or replace function join_shop(p_name text, p_phone text, p_hash text)
returns bigint language plpgsql security definer as $$
declare existing customers%rowtype;
declare new_id bigint;
begin
  if length(phone_key(p_phone)) < 7 then
    raise exception 'That does not look like a phone number.';
  end if;

  select * into existing from customers where phone_key(phone) = phone_key(p_phone);
  if found then
    if existing.password_hash is not null then
      raise exception 'That number is already registered. Sign in instead.';
    end if;
    -- Unclaimed: this is the same person coming to collect what is theirs.
    update customers
       set password_hash = p_hash, name = coalesce(nullif(btrim(p_name), ''), name)
     where id = existing.id;
    return existing.id;
  end if;

  insert into customers (name, phone, password_hash, joined_via)
  values (btrim(p_name), btrim(p_phone), p_hash, 'app')
  returning id into new_id;
  return new_id;
end;
$$;

-- An unclaimed account cannot be signed in to at all: there is no password to
-- be wrong, and returning the row would let a stranger in with any guess.
create or replace function shop_login(p_phone text)
returns table (id bigint, name text, password_hash text, points int, tier text)
language sql security definer stable as $$
  select c.id, c.name, c.password_hash, c.points, customer_tier(c.points)
    from customers c
   where c.active
     and c.password_hash is not null
     and phone_key(c.phone) = phone_key(p_phone);
$$;

-- ---------------------------------------------------------------------------
-- Putting a walk-in sale against a customer
--
-- Done after the sale rather than during it. If naming the customer fails, the
-- sale still stands — the goods have left the shelf and the money is in the
-- drawer, and refusing that because a phone number was mistyped would be
-- absurd. The points can always be added afterwards.
-- ---------------------------------------------------------------------------
create table sale_customers (
  sale_id      bigint primary key references sales (id),
  customer_id  bigint not null references customers (id),
  points_given int not null default 0 check (points_given >= 0),
  put_by       text not null default current_actor(),
  put_at       timestamptz not null default now()
);
create index sale_customers_by_customer on sale_customers (customer_id);

create or replace function attribute_sale(p_receipt text, p_customer bigint)
returns int language plpgsql security definer as $$
declare v_sale bigint; v_total numeric(12,2); v_points int;
begin
  perform require_role('admin', 'cashier');

  select id, total into v_sale, v_total from sales
   where upper(receipt_no) = upper(btrim(p_receipt));
  if not found then raise exception 'No sale with the receipt %.', p_receipt; end if;
  if exists (select 1 from sale_customers where sale_id = v_sale) then
    raise exception 'That receipt is already against a customer.';
  end if;
  if not exists (select 1 from customers where id = p_customer and active) then
    raise exception 'That customer is not on the list.';
  end if;

  v_points := floor(v_total / 20)::int;
  insert into sale_customers (sale_id, customer_id, points_given)
  values (v_sale, p_customer, v_points);
  update customers
     set points = points + v_points,
         last_seen = (now() at time zone 'Asia/Manila')::date
   where id = p_customer;
  return v_points;
end;
$$;

-- ---------------------------------------------------------------------------
-- Who they are, and what they are worth
--
-- Spend counts both ways a customer can buy: a reservation they collected, and
-- a walk-in sale put against them. Counting only one would make the app look
-- like the whole business.
-- ---------------------------------------------------------------------------
create or replace view customer_history as
select c.id as customer_id, s.receipt_no as reference, 'counter' as how,
       s.at, s.total, sc.points_given
  from sale_customers sc
  join sales s on s.id = sc.sale_id
  join customers c on c.id = sc.customer_id
union all
select p.customer_id, p.code, 'reserved', p.collected_at, o.total, p.points_given
  from pickups p
  join orders o on o.id = p.order_id
 where p.status = 'collected';

create or replace view crm_customers as
select c.id, c.name, c.phone, c.points, customer_tier(c.points) as tier,
       c.joined_at, c.joined_via, c.note, c.active,
       (c.password_hash is not null) as claimed,
       coalesce(h.orders, 0)::int as orders,
       coalesce(h.spent, 0)      as spent,
       h.last_bought,
       case
         when h.last_bought is null then 'never bought'
         when h.last_bought > (now() at time zone 'Asia/Manila')::date - 30 then 'active'
         when h.last_bought > (now() at time zone 'Asia/Manila')::date - 90 then 'slipping'
         else 'lapsed'
       end as standing
  from customers c
  left join (
    select customer_id, count(*) as orders, sum(total) as spent,
           max((at at time zone 'Asia/Manila')::date) as last_bought
      from customer_history group by customer_id) h on h.customer_id = c.id
 order by c.name;

create or replace function customer_detail(p_id bigint)
returns table (id bigint, name text, phone text, points int, tier text,
               joined_at timestamptz, joined_via text, note text, claimed boolean,
               orders int, spent numeric, last_bought date, standing text,
               history jsonb)
language sql security definer stable as $$
  select c.id, c.name, c.phone, c.points, c.tier, c.joined_at, c.joined_via,
         c.note, c.claimed, c.orders, c.spent, c.last_bought, c.standing,
         (select jsonb_agg(jsonb_build_object(
                   'reference', h.reference, 'how', h.how, 'at', h.at,
                   'total', h.total, 'points', h.points_given) order by h.at desc)
            from customer_history h where h.customer_id = c.id)
    from crm_customers c where c.id = p_id;
$$;

create or replace function set_customer_note(p_id bigint, p_note text)
returns void language plpgsql security definer as $$
begin
  perform require_role('admin', 'cashier');
  update customers set note = nullif(btrim(coalesce(p_note, '')), '') where id = p_id;
  if not found then raise exception 'That customer is not on the list.'; end if;
end;
$$;

-- The counter's lookup: enough to find somebody mid-queue, and nothing else.
create or replace function find_customer(p_term text)
returns table (id bigint, name text, phone text, points int, tier text)
language sql security definer stable as $$
  select c.id, c.name, c.phone, c.points, customer_tier(c.points)
    from customers c
   where c.active
     and (c.name ilike '%' || btrim(p_term) || '%'
          or phone_key(c.phone) like '%' || phone_key(p_term) || '%')
   order by c.name
   limit 20;
$$;

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------
alter table sale_customers enable row level security;
create policy staff_read_sale_customers on sale_customers for select
  using (current_role_name() in ('admin', 'cashier'));

grant select on sale_customers, crm_customers, customer_history to app_client;
grant execute on function register_customer(text, text, text) to app_client;
grant execute on function attribute_sale(text, bigint) to app_client;
grant execute on function customer_detail(bigint) to app_client;
grant execute on function set_customer_note(bigint, text) to app_client;
grant execute on function find_customer(text) to app_client;

alter function register_customer(text, text, text) set search_path = public, extensions;
alter function attribute_sale(text, bigint) set search_path = public, extensions;
alter function customer_detail(bigint) set search_path = public, extensions;
alter function set_customer_note(bigint, text) set search_path = public, extensions;
alter function find_customer(text) set search_path = public, extensions;
alter function join_shop(text, text, text) set search_path = public, extensions;
alter function shop_login(text) set search_path = public, extensions;
revoke all on function register_customer(text, text, text) from public;
revoke all on function attribute_sale(text, bigint) from public;
revoke all on function customer_detail(bigint) from public;
revoke all on function set_customer_note(bigint, text) from public;
revoke all on function find_customer(text) from public;

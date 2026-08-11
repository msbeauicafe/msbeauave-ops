-- ============================================================================
-- MS BEAU AVE — reserve and collect
--
-- What the app's basket turns into. A customer reserves; the stock is held out
-- of the shop pool immediately, so the counter cannot sell the same jar to
-- somebody standing in front of them; they collect and pay at the counter.
--
-- There is no online payment here. A shop that takes money in an app and then
-- cannot honour the order has a worse problem than one that says "pay when you
-- collect", and this way the cash still goes through the till where the close
-- of day can see it.
-- ============================================================================

create sequence pickup_counter start 1001;

create table pickups (
  id           bigint generated always as identity primary key,
  order_id     bigint not null unique references orders (id),
  customer_id  bigint not null references customers (id),
  code         text not null unique,
  status       text not null default 'reserved'
               check (status in ('reserved', 'collected', 'cancelled')),
  reserved_at  timestamptz not null default now(),
  hold_until   timestamptz not null,
  collected_at timestamptz,
  cancelled_at timestamptz,
  points_given int not null default 0 check (points_given >= 0),

  -- The three timestamps and the status have to agree, or "what did we hold
  -- last week" and "what did we sell last week" stop being answerable.
  constraint collected_has_a_time check ((status = 'collected') = (collected_at is not null)),
  constraint cancelled_has_a_time check ((status = 'cancelled') = (cancelled_at is not null))
);
-- Named for the index it is, not the view below: Postgres keeps both in one
-- namespace and will not have two relations called the same thing.
create index pickups_open on pickups (status, hold_until) where status = 'reserved';
create trigger pickups_audit after insert or update or delete on pickups
  for each row execute function write_audit();

-- ---------------------------------------------------------------------------
-- Reserving
--
-- This reuses place_order rather than re-implementing the hold. That function
-- is the only place that knows how to take shop stock in expiry order, under
-- the right locks, without overselling — and a second copy of that logic is a
-- second thing to get wrong. It insists on a counter role, so the role is
-- raised for the length of the call and no longer: set_config with is_local
-- true dies with the statement, and a reservation genuinely is a counter
-- action taken on the customer's behalf.
-- ---------------------------------------------------------------------------
create or replace function reserve_for_pickup(p_customer bigint, p_lines jsonb)
returns table (pickup_id bigint, code text, total numeric, hold_until timestamptz)
language plpgsql security definer as $$
declare
  v_name  text;
  v_order bigint;
  v_code  text;
  v_hold  timestamptz;
  v_total numeric(12,2);
begin
  select name into v_name from customers where id = p_customer and active;
  if not found then
    raise exception 'Please sign in again before reserving.';
  end if;
  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    raise exception 'Your basket is empty.';
  end if;

  perform expire_pickups();

  perform set_config('app.role', 'cashier', true);
  perform set_config('app.actor', 'shop app (' || v_name || ')', true);
  v_order := place_order('shop', p_lines);

  -- Held until the end of tomorrow, Manila time: long enough to come after
  -- work, short enough that a forgotten basket is not stock nobody can sell.
  v_hold := ((date_trunc('day', now() at time zone 'Asia/Manila') + interval '2 days')
             at time zone 'Asia/Manila') - interval '1 second';
  v_code := 'MB-' || nextval('pickup_counter')::text;

  select o.total into v_total from orders o where o.id = v_order;

  insert into pickups (order_id, customer_id, code, hold_until)
  values (v_order, p_customer, v_code, v_hold)
  returning pickups.id, pickups.code, v_total, pickups.hold_until
    into pickup_id, code, total, hold_until;
  return next;
end;
$$;

-- ---------------------------------------------------------------------------
-- Letting go of a hold
--
-- Cancelling releases the stock through cancel_order, which is what put the
-- commitment there in the first place.
-- ---------------------------------------------------------------------------
create or replace function cancel_pickup(p_pickup bigint, p_customer bigint default null)
returns void language plpgsql security definer as $$
declare p pickups%rowtype;
begin
  select * into p from pickups where id = p_pickup for update;
  if not found then raise exception 'That reservation no longer exists.'; end if;

  -- A customer may only drop their own; staff may drop any.
  if p_customer is not null and p.customer_id <> p_customer then
    raise exception 'That is not your reservation.';
  end if;
  if p.status <> 'reserved' then
    raise exception 'That reservation is already %.', p.status;
  end if;

  perform set_config('app.role', 'cashier', true);
  perform cancel_order(p.order_id);
  update pickups set status = 'cancelled', cancelled_at = now() where id = p.id;
end;
$$;

-- A hold that has run out is stock nobody can sell, so it is released rather
-- than left to age. Called whenever the shop or the counter looks at pickups,
-- which is often enough without a scheduler to keep running.
create or replace function expire_pickups() returns int
language plpgsql security definer as $$
declare p record; n int := 0;
begin
  for p in select id from pickups
            where status = 'reserved' and hold_until < now() for update
  loop
    perform cancel_pickup(p.id);
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- ---------------------------------------------------------------------------
-- Collecting
--
-- The counter's move: hands over the goods, takes the money. It goes through
-- fulfil_order and writes a sale, so a collected reservation reaches the day's
-- takings and the close of day exactly like a walk-in sale — which it is.
-- ---------------------------------------------------------------------------
create or replace function collect_pickup(p_code text, p_method text default 'cash')
returns jsonb language plpgsql security definer as $$
declare
  p        pickups%rowtype;
  v_total  numeric(12,2);
  v_receipt text;
  v_points int;
  v_sku    text;
  v_left   int;
  v_min    int;
begin
  perform require_role('admin', 'cashier');
  if p_method not in ('cash', 'gcash', 'card') then
    raise exception 'Payment has to be cash, GCash or card.';
  end if;

  select * into p from pickups where upper(code) = upper(btrim(p_code)) for update;
  if not found then raise exception 'No reservation with the code %.', p_code; end if;
  if p.status <> 'reserved' then
    raise exception 'That reservation is already %.', p.status;
  end if;

  perform fulfil_order(p.order_id);
  select total into v_total from orders where id = p.order_id;

  v_receipt := 'OR-' || to_char(now() at time zone 'Asia/Manila', 'YYYYMMDD')
               || '-' || lpad(nextval('receipt_counter')::text, 5, '0');
  insert into sales (order_id, receipt_no, method, total, tendered, change_due)
  values (p.order_id, v_receipt, p_method, v_total, v_total, 0);

  -- One point per twenty pesos, rounded down. Deliberately dull: a scheme
  -- nobody can explain at the counter is one nobody trusts.
  v_points := floor(v_total / 20)::int;
  update customers set points = points + v_points where id = p.customer_id;
  update pickups set status = 'collected', collected_at = now(), points_given = v_points
   where id = p.id;

  -- Same shelf check a walk-in sale does, for the same reason.
  for v_sku in select distinct ol.sku from order_lines ol where ol.order_id = p.order_id loop
    select coalesce(sum(s.on_hand - s.committed), 0)::int, max(pr.shelf_min)
      into v_left, v_min
      from products pr
      left join batches b on b.sku = pr.sku and b.expiry > current_date
      left join stock s on s.batch_id = b.id and s.pool = 'shop'
     where pr.sku = v_sku group by pr.sku;
    if v_left <= coalesce(v_min, 0) then
      perform raise_restock(v_sku, format('shelf down to %s after pickup %s', v_left, p.code));
    end if;
  end loop;

  return jsonb_build_object(
    'code', p.code, 'receipt_no', v_receipt, 'total', v_total,
    'method', p_method, 'points', v_points);
end;
$$;

-- ---------------------------------------------------------------------------
-- Reading
-- ---------------------------------------------------------------------------
create or replace function my_pickups(p_customer bigint)
returns table (
  id bigint, code text, status text, total numeric,
  reserved_at timestamptz, hold_until timestamptz, collected_at timestamptz,
  points_given int, lines jsonb
)
language sql security definer stable as $$
  select p.id, p.code, p.status, o.total,
         p.reserved_at, p.hold_until, p.collected_at, p.points_given,
         (select jsonb_agg(jsonb_build_object(
                   'sku', ol.sku, 'name', pr.name, 'qty', ol.qty, 'unit_price', ol.unit_price)
                   order by pr.name)
            from order_lines ol join products pr on pr.sku = ol.sku
           where ol.order_id = p.order_id)
    from pickups p join orders o on o.id = p.order_id
   where p.customer_id = p_customer
   order by p.reserved_at desc
   limit 50;
$$;

-- What the counter needs: who is coming in, for what, and by when.
create or replace view pickups_waiting as
select p.id, p.code, p.status, p.reserved_at, p.hold_until, o.total,
       c.name as customer, c.phone,
       (select string_agg(pr.name || ' ×' || ol.qty, ', ' order by pr.name)
          from order_lines ol join products pr on pr.sku = ol.sku
         where ol.order_id = p.order_id) as items
  from pickups p
  join orders o on o.id = p.order_id
  join customers c on c.id = p.customer_id
 where p.status = 'reserved'
 order by p.hold_until;

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------
alter table pickups enable row level security;
create policy staff_read_pickups on pickups for select
  using (current_role_name() in ('admin', 'warehouse', 'cashier'));

grant select on pickups, pickups_waiting to app_client;
grant usage on sequence pickup_counter to app_client;
grant execute on function reserve_for_pickup(bigint, jsonb) to app_client;
grant execute on function cancel_pickup(bigint, bigint) to app_client;
grant execute on function collect_pickup(text, text) to app_client;
grant execute on function expire_pickups() to app_client;
grant execute on function my_pickups(bigint) to app_client;

alter function reserve_for_pickup(bigint, jsonb) set search_path = public, extensions;
alter function cancel_pickup(bigint, bigint) set search_path = public, extensions;
alter function collect_pickup(text, text) set search_path = public, extensions;
alter function expire_pickups() set search_path = public, extensions;
alter function my_pickups(bigint) set search_path = public, extensions;
revoke all on function reserve_for_pickup(bigint, jsonb) from public;
revoke all on function cancel_pickup(bigint, bigint) from public;
revoke all on function collect_pickup(text, text) from public;
revoke all on function expire_pickups() from public;
revoke all on function my_pickups(bigint) from public;

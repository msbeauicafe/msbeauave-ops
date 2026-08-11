-- ============================================================================
-- MS BEAU AVE — promotions
--
-- A promotion here changes what a customer is charged, not merely what they
-- are shown. A banner advertising 20% off that the till knows nothing about is
-- an argument at the counter, so the discount lives in one function that both
-- the shop window and the order path ask.
--
-- The floor is the reseller's price. The whole point of MAP discipline is that
-- our own counter never undercuts the people who buy from us wholesale — and a
-- sale is exactly when someone would forget that. A promotion that would break
-- it is refused when it is created, with the arithmetic spelled out.
-- ============================================================================

create table promos (
  id          bigint generated always as identity primary key,
  sku         text not null references products (sku),
  headline    text not null check (length(btrim(headline)) > 0),
  kind        text not null default 'flash' check (kind in ('flash', 'instore')),
  percent_off numeric(4,1) not null check (percent_off > 0 and percent_off <= 90),
  starts_on   date not null default current_date,
  ends_on     date not null,
  batch_id    bigint references batches (id),
  ended_early boolean not null default false,
  created_by  text not null default current_actor(),
  created_at  timestamptz not null default now(),

  constraint runs_forwards check (ends_on >= starts_on)
);
create index promos_running on promos (sku, starts_on, ends_on) where not ended_early;
create trigger promos_audit after insert or update or delete on promos
  for each row execute function write_audit();

-- ---------------------------------------------------------------------------
-- What is running today
--
-- One product, one promotion. If two overlap, the deepest discount wins rather
-- than whichever happened to be created last — a customer should never be able
-- to tell that two campaigns collided.
-- ---------------------------------------------------------------------------
create or replace view live_promos as
select distinct on (p.sku)
       p.id, p.sku, p.headline, p.kind, p.percent_off, p.starts_on, p.ends_on, p.batch_id,
       pr.name as product, pr.brand, pr.retail_price as was, pr.srp,
       greatest(round(pr.retail_price * (1 - p.percent_off / 100), 2), pr.srp) as now_price,
       b.batch_no, b.expiry
  from promos p
  join products pr on pr.sku = p.sku and pr.active
  left join batches b on b.id = p.batch_id
 where not p.ended_early
   and current_date between p.starts_on and p.ends_on
 order by p.sku, p.percent_off desc, p.id desc;

-- The price anything should actually be sold at, today. Shop channel only:
-- a promotion is a retail gesture and must never quietly move a wholesale
-- price, which is contracted.
create or replace function effective_price(p_sku text, p_channel text default 'shop')
returns numeric language sql stable as $$
  select case
    when p_channel = 'b2b' then (select wholesale_price from products where sku = p_sku)
    else coalesce(
      (select now_price from live_promos where sku = p_sku),
      (select retail_price from products where sku = p_sku))
  end;
$$;

-- ---------------------------------------------------------------------------
-- Starting and stopping one
-- ---------------------------------------------------------------------------
create or replace function start_promo(
  p_sku text, p_headline text, p_percent numeric, p_ends date,
  p_kind text default 'flash', p_starts date default current_date,
  p_batch bigint default null) returns bigint
language plpgsql security definer as $$
declare
  v_retail numeric(12,2);
  v_srp    numeric(12,2);
  v_after  numeric(12,2);
  new_id   bigint;
begin
  perform require_role('admin');

  select retail_price, srp into v_retail, v_srp from products where sku = p_sku and active;
  if not found then
    raise exception 'There is no active product with the code %.', p_sku;
  end if;

  v_after := round(v_retail * (1 - p_percent / 100), 2);
  if v_srp > 0 and v_after < v_srp then
    -- Spelled out in full rather than with % escapes: a message about
    -- percentages is exactly where a format string goes wrong quietly.
    raise exception
      'Taking % percent off % brings it to %, below the % resellers sell at. The most you can take off is % percent.',
      p_percent, p_sku, v_after, v_srp, floor((1 - v_srp / v_retail) * 100)
      using errcode = 'P0007';
  end if;

  if p_batch is not null
     and not exists (select 1 from batches where id = p_batch and sku = p_sku) then
    raise exception 'That batch is not a batch of %.', p_sku;
  end if;

  -- coalesce rather than relying on the parameter default: a caller passing an
  -- explicit null means "today", not "violate the not-null constraint".
  insert into promos (sku, headline, kind, percent_off, starts_on, ends_on, batch_id)
  values (p_sku, btrim(p_headline), p_kind, p_percent,
          coalesce(p_starts, current_date), p_ends, p_batch)
  returning id into new_id;
  return new_id;
end;
$$;

create or replace function end_promo(p_id bigint) returns void
language plpgsql security definer as $$
begin
  perform require_role('admin');
  update promos set ended_early = true where id = p_id and not ended_early;
  if not found then
    raise exception 'That promotion has already ended.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- A batch running out of life is the honest reason for most sales, so make
-- that easy to see when deciding what to put on promotion.
-- ---------------------------------------------------------------------------
create or replace view promo_candidates as
select b.id as batch_id, b.sku, pr.name as product, b.batch_no, b.expiry,
       (b.expiry - current_date) as days_left,
       coalesce(sum(s.on_hand - s.committed), 0)::int as units,
       pr.retail_price, pr.srp,
       floor((1 - pr.srp / nullif(pr.retail_price, 0)) * 100)::int as max_percent,
       exists (select 1 from live_promos lp where lp.sku = b.sku) as already_on_promo
  from batches b
  join products pr on pr.sku = b.sku and pr.active
  left join stock s on s.batch_id = b.id and s.pool in ('shop', 'reserve')
 where b.expiry > current_date and b.expiry < current_date + 180
 group by b.id, b.sku, pr.name, b.batch_no, b.expiry, pr.retail_price, pr.srp
having coalesce(sum(s.on_hand - s.committed), 0) > 0
 order by b.expiry;

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------
alter table promos enable row level security;
create policy staff_read_promos on promos for select
  using (current_role_name() in ('admin', 'warehouse', 'cashier'));

grant select on promos, live_promos, promo_candidates to app_client;
grant execute on function start_promo(text, text, numeric, date, text, date, bigint) to app_client;
grant execute on function end_promo(bigint) to app_client;
grant execute on function effective_price(text, text) to app_client;

alter function start_promo(text, text, numeric, date, text, date, bigint) set search_path = public, extensions;
alter function end_promo(bigint) set search_path = public, extensions;
alter function effective_price(text, text) set search_path = public, extensions;
revoke all on function start_promo(text, text, numeric, date, text, date, bigint) from public;
revoke all on function end_promo(bigint) from public;
revoke all on function effective_price(text, text) from public;

-- ---------------------------------------------------------------------------
-- Making the discount real
--
-- place_order is where a price becomes money owed, for the till and for an app
-- reservation alike. It now asks effective_price instead of reading the
-- product's retail price directly, so a promotion is charged rather than merely
-- advertised. With nothing on promotion the answer is identical, which is why
-- this is a one-line change and not a new order path.
-- ---------------------------------------------------------------------------
create or replace function place_order(
  p_channel   text,
  p_lines     jsonb,
  p_reseller  bigint default null
) returns bigint
language plpgsql security definer as $$
declare
  v_pool     text;
  v_order    bigint;
  line       record;
  row_       record;
  v_wanted   int;
  v_take     int;
  v_price    numeric(12,2);
  v_subtotal numeric(12,2) := 0;
  v_cutoff   date;
begin
  if p_channel = 'b2b' then
    perform require_role('admin','reseller');
    if current_role_name() = 'reseller'
       and p_reseller is distinct from current_reseller() then
      raise exception 'FORBIDDEN: an account may only order for itself'
        using errcode = '42501';
    end if;
    v_pool := 'b2b';
    perform check_can_order(p_reseller, (
      select coalesce(sum((l ->> 'qty')::int
             * (select wholesale_price from products where sku = l ->> 'sku')), 0)
        from jsonb_array_elements(p_lines) l));
  elsif p_channel = 'shop' then
    perform require_role('admin','cashier');
    v_pool := 'shop';
  else
    raise exception 'unknown channel %', p_channel;
  end if;

  insert into orders (channel, reseller_id) values (p_channel, p_reseller)
  returning id into v_order;

  -- Ordering the lines by product gives every concurrent order the same lock
  -- order, so two multi-line orders cannot deadlock against each other.
  for line in
    select l ->> 'sku' as sku, (l ->> 'qty')::int as qty
      from jsonb_array_elements(p_lines) l
     order by l ->> 'sku'
  loop
    if line.qty is null or line.qty <= 0 then
      raise exception 'quantity must be more than zero for %', line.sku;
    end if;

    -- The only change a promotion makes to this function: the price comes from
    -- effective_price rather than straight off the product, so a discount is
    -- charged and not merely advertised. With nothing running the answer is
    -- identical, and wholesale is never touched.
    if not exists (select 1 from products where sku = line.sku and active) then
      raise exception 'no active product with code %', line.sku;
    end if;
    v_price := effective_price(line.sku, p_channel);

    v_cutoff := earliest_usable_expiry(v_pool, line.sku);
    v_wanted := line.qty;

    for row_ in
      select s.id, s.on_hand, s.committed, s.batch_id
        from stock s
        join batches b on b.id = s.batch_id
       where s.pool = v_pool and b.sku = line.sku and b.expiry > v_cutoff
       order by b.expiry, b.id
         for update of s
    loop
      exit when v_wanted <= 0;
      v_take := least(row_.on_hand - row_.committed, v_wanted);
      if v_take > 0 then
        update stock set committed = committed + v_take where id = row_.id;
        insert into order_lines (order_id, sku, batch_id, qty, unit_price)
        values (v_order, line.sku, row_.batch_id, v_take, v_price);
        v_wanted := v_wanted - v_take;
      end if;
    end loop;

    if v_wanted > 0 then
      raise exception 'NOT_ENOUGH_STOCK: % is short % unit(s)', line.sku, v_wanted
        using errcode = 'P0002';
    end if;

    v_subtotal := v_subtotal + v_price * line.qty;
  end loop;

  update orders set subtotal = v_subtotal, total = v_subtotal where id = v_order;

  if p_channel = 'b2b' then
    perform raise_invoice(v_order);
  end if;
  return v_order;
end;
$$;

alter function place_order(text, jsonb, bigint) set search_path = public, extensions;
revoke all on function place_order(text, jsonb, bigint) from public;
grant execute on function place_order(text, jsonb, bigint) to app_client;

-- ---------------------------------------------------------------------------
-- Showing it
--
-- Both catalogues gain the promotion alongside the ordinary price, so a screen
-- can strike one through and show the other. retail_price keeps its name and
-- meaning — the price when nothing is running — and price_now is what will be
-- charged today, so nothing that already reads these breaks.
-- ---------------------------------------------------------------------------
-- The new columns go on the end, not in the middle: `create or replace view`
-- may append to a view's shape but never reorder it, and dropping this one
-- would take everything that reads it with it.
create or replace view shop_catalog as
select p.sku, p.name, p.brand, p.category, p.retail_price,
       coalesce(sum(s.on_hand - s.committed), 0)::int as on_shelf,
       coalesce(lp.now_price, p.retail_price) as price_now,
       lp.percent_off, lp.headline as promo_headline
  from products p
  left join batches b on b.sku = p.sku and b.expiry > current_date
  left join stock s on s.batch_id = b.id and s.pool = 'shop'
  left join live_promos lp on lp.sku = p.sku
 where p.active
 group by p.sku, p.name, p.brand, p.category, p.retail_price,
          lp.now_price, lp.percent_off, lp.headline;

-- Its shape changes, and a function's return type cannot be replaced in
-- place, so this one is dropped and rebuilt. The grant goes back on below.
drop function if exists public_catalog(text);

create or replace function public_catalog(p_term text default '')
returns table (
  sku      text,
  name     text,
  brand    text,
  category text,
  price    numeric,
  was      numeric,
  percent_off numeric,
  in_stock boolean,
  has_photo boolean
)
language sql security definer stable as $$
  select c.sku, c.name, c.brand, c.category,
         c.price_now,
         case when c.percent_off is not null then c.retail_price end,
         c.percent_off,
         c.on_shelf > 0, ph.has_photo
    from shop_catalog c
    join product_has_photo ph on ph.sku = c.sku
   where coalesce(btrim(p_term), '') = ''
      or c.name ilike '%' || btrim(p_term) || '%'
      or coalesce(c.brand, '') ilike '%' || btrim(p_term) || '%'
      or coalesce(c.category, '') ilike '%' || btrim(p_term) || '%'
   order by (c.on_shelf > 0) desc, c.percent_off desc nulls last, c.name
   limit 200;
$$;

-- What the shop front puts in its banner and its "live" row.
create or replace function public_promos()
returns table (sku text, headline text, kind text, percent_off numeric,
               product text, was numeric, price numeric, ends_on date, has_photo boolean)
language sql security definer stable as $$
  select lp.sku, lp.headline, lp.kind, lp.percent_off,
         lp.product, lp.was, lp.now_price, lp.ends_on, ph.has_photo
    from live_promos lp
    join product_has_photo ph on ph.sku = lp.sku
    join shop_catalog c on c.sku = lp.sku
   where c.on_shelf > 0
   order by lp.percent_off desc
   limit 12;
$$;

grant execute on function public_catalog(text) to app_client;
grant execute on function public_promos() to app_client;
alter function public_catalog(text) set search_path = public, extensions;
alter function public_promos() set search_path = public, extensions;
revoke all on function public_catalog(text) from public;
revoke all on function public_promos() from public;

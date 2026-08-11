-- ============================================================================
-- MS BEAU AVE — the money
--
-- What came in, what it cost to sell, what went out, and what is left. Four
-- questions a shop lives or dies by, and until now the system could answer
-- only the first.
--
-- Two things were missing. Nothing recorded what a sale cost us at the moment
-- it happened — only what the product costs today — so last month's margin
-- moved every time a supplier price changed. And nothing recorded money going
-- out at all, which makes "profit" a word for revenue.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- The cost of what was sold, fixed at the time it was sold
--
-- Nullable, because the lines already in the table were written before this
-- existed. The views below fall back to the product's cost for those and say
-- so, rather than quietly reporting a margin that was never true.
-- ---------------------------------------------------------------------------
alter table order_lines add column unit_cost numeric(12,2);

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
  v_cost     numeric(12,2);
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
    -- The cost as it stands today, kept with the line. Margin on a sale from
    -- March must not move because a supplier raised a price in June.
    select unit_cost into v_cost from products where sku = line.sku;

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
        insert into order_lines (order_id, sku, batch_id, qty, unit_price, unit_cost)
        values (v_order, line.sku, row_.batch_id, v_take, v_price, v_cost);
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


-- ---------------------------------------------------------------------------
-- Money going out
--
-- Deliberately plain: a date, a kind, an amount, and what it was for. A shop
-- that has to pick from thirty account codes stops recording the small ones,
-- and the small ones are most of them.
--
-- Nothing is ever deleted. A mistake is voided with a reason, because a books
-- entry that can vanish is a books entry nobody can rely on.
-- ---------------------------------------------------------------------------
create table expenses (
  id          bigint generated always as identity primary key,
  spent_on    date not null default (now() at time zone 'Asia/Manila')::date,
  kind        text not null check (kind in
                ('stock', 'rent', 'wages', 'utilities', 'supplies',
                 'transport', 'marketing', 'fees', 'other')),
  description text not null check (length(btrim(description)) > 0),
  amount      numeric(12,2) not null check (amount > 0),
  method      text not null default 'cash' check (method in ('cash', 'gcash', 'card', 'bank')),
  paid_by     text not null default current_actor(),
  voided      boolean not null default false,
  void_reason text,
  recorded_at timestamptz not null default now(),

  constraint voided_says_why check (voided = (void_reason is not null))
);
create index expenses_by_day on expenses (spent_on) where not voided;
create trigger expenses_audit after insert or update or delete on expenses
  for each row execute function write_audit();

create or replace function record_expense(
  p_kind text, p_description text, p_amount numeric,
  p_on date default null, p_method text default 'cash') returns bigint
language plpgsql security definer as $fn$
declare new_id bigint;
begin
  perform require_role('admin');
  insert into expenses (kind, description, amount, spent_on, method)
  values (p_kind, btrim(p_description), p_amount,
          coalesce(p_on, (now() at time zone 'Asia/Manila')::date), p_method)
  returning id into new_id;
  return new_id;
end;
$fn$;

create or replace function void_expense(p_id bigint, p_reason text) returns void
language plpgsql security definer as $fn$
begin
  perform require_role('admin');
  if length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'Say why it is being voided.';
  end if;
  update expenses set voided = true, void_reason = btrim(p_reason)
   where id = p_id and not voided;
  if not found then raise exception 'That entry is already voided, or does not exist.'; end if;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- What each sale actually made
--
-- Cost falls back to the product's current cost only for lines written before
-- unit_cost existed. `costed` says which it is, so a margin figure can never
-- quietly mix the two without the screen being able to tell you.
-- ---------------------------------------------------------------------------
create or replace view sale_margins as
select s.id as sale_id, s.receipt_no, s.method, s.at,
       (s.at at time zone 'Asia/Manila')::date as business_date,
       s.total as revenue,
       sum(ol.qty * coalesce(ol.unit_cost, p.unit_cost)) as cost,
       s.total - sum(ol.qty * coalesce(ol.unit_cost, p.unit_cost)) as margin,
       bool_and(ol.unit_cost is not null) as costed
  from sales s
  join order_lines ol on ol.order_id = s.order_id
  join products p on p.sku = ol.sku
 group by s.id, s.receipt_no, s.method, s.at, s.total;

-- The same for wholesale, recognised when the goods actually left.
create or replace view wholesale_margins as
select o.id as order_id, i.id as invoice_id, i.issued_on, i.amount as revenue,
       sum(ol.qty * coalesce(ol.unit_cost, p.unit_cost)) as cost,
       i.amount - sum(ol.qty * coalesce(ol.unit_cost, p.unit_cost)) as margin,
       i.status, i.paid
  from orders o
  join invoices i on i.order_id = o.id
  join order_lines ol on ol.order_id = o.id
  join products p on p.sku = ol.sku
 where o.channel = 'b2b' and o.status = 'fulfilled' and i.status <> 'void'
 group by o.id, i.id, i.issued_on, i.amount, i.status, i.paid;

-- ---------------------------------------------------------------------------
-- The whole picture for a period
--
-- Counter takings and wholesale are kept apart all the way through, because
-- they behave differently: one is money in the drawer today, the other is an
-- invoice that may be paid in thirty days. Adding them into a single "revenue"
-- number is how a shop with healthy sales runs out of cash.
-- ---------------------------------------------------------------------------
create or replace function finance_summary(p_from date, p_to date)
returns jsonb language sql security definer stable as $fn$
  with counter as (
    select coalesce(sum(revenue), 0) as revenue,
           coalesce(sum(cost), 0)    as cost,
           count(*)                  as sales,
           bool_and(costed)          as fully_costed
      from sale_margins where business_date between p_from and p_to),
  by_method as (
    select jsonb_object_agg(method, total) as split
      from (select method, sum(revenue) as total from sale_margins
             where business_date between p_from and p_to group by method) m),
  wholesale as (
    select coalesce(sum(revenue), 0) as invoiced,
           coalesce(sum(cost), 0)    as cost,
           count(*)                  as orders
      from wholesale_margins where issued_on between p_from and p_to),
  collected as (
    select coalesce(sum(amount), 0) as received
      from payments where paid_on between p_from and p_to),
  owed as (
    select coalesce(sum(amount - paid), 0) as outstanding
      from invoices where status = 'open'),
  spent as (
    select coalesce(jsonb_object_agg(kind, by_kind), '{}'::jsonb) as split
      from (select kind, sum(amount) as by_kind from expenses
             where not voided and spent_on between p_from and p_to
             group by kind) e),
  spent_total as (
    select coalesce(sum(amount), 0) as total from expenses
     where not voided and spent_on between p_from and p_to),
  stock_at_cost as (
    select coalesce(sum(st.on_hand * p.unit_cost), 0) as value
      from stock st join batches b on b.id = st.batch_id
      join products p on p.sku = b.sku)
  select jsonb_build_object(
    'from', p_from, 'to', p_to,
    'counter', jsonb_build_object(
      'revenue', c.revenue, 'cost', c.cost, 'margin', c.revenue - c.cost,
      'sales', c.sales, 'by_method', coalesce(bm.split, '{}'::jsonb),
      'fully_costed', coalesce(c.fully_costed, true)),
    'wholesale', jsonb_build_object(
      'invoiced', w.invoiced, 'cost', w.cost, 'margin', w.invoiced - w.cost,
      'orders', w.orders, 'received', col.received, 'outstanding', ow.outstanding),
    'expenses', jsonb_build_object('total', st.total, 'by_kind', sp.split),
    'gross_margin', (c.revenue - c.cost) + (w.invoiced - w.cost),
    'net', (c.revenue - c.cost) + (w.invoiced - w.cost) - st.total,
    'stock_at_cost', sac.value)
    from counter c, by_method bm, wholesale w, collected col, owed ow,
         spent sp, spent_total st, stock_at_cost sac;
$fn$;

create or replace view expenses_recent as
select id, spent_on, kind, description, amount, method, paid_by, voided, void_reason
  from expenses order by spent_on desc, id desc limit 200;

-- ---------------------------------------------------------------------------
-- Access — the books are the owner's, and nobody else's
-- ---------------------------------------------------------------------------
alter table expenses enable row level security;
create policy admin_reads_expenses on expenses for select
  using (current_role_name() = 'admin');

grant select on expenses, expenses_recent, sale_margins, wholesale_margins to app_client;
grant execute on function record_expense(text, text, numeric, date, text) to app_client;
grant execute on function void_expense(bigint, text) to app_client;
grant execute on function finance_summary(date, date) to app_client;

alter function record_expense(text, text, numeric, date, text) set search_path = public, extensions;
alter function void_expense(bigint, text) set search_path = public, extensions;
alter function finance_summary(date, date) set search_path = public, extensions;
revoke all on function record_expense(text, text, numeric, date, text) from public;
revoke all on function void_expense(bigint, text) from public;
revoke all on function finance_summary(date, date) from public;

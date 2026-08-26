-- ============================================================================
-- MS BEAU AVE — PCODE: the price a line was sold at
--
-- The paper invoice has a PCODE column against every line, and it has never
-- meant the product's code. It is the price the line was given: RD, PD+5,
-- STOCKIST, VIP. Two lines on one invoice can carry different codes, because
-- one customer can be given one deal on a set and another on a sunscreen.
-- The app was printing the SKU there, which is the one thing that column has
-- never been for.
--
-- Seventeen codes, and they are not seventeen prices. Nine are their own
-- thing and carry a price list; the other eight are one of those nine plus or
-- minus a number of pesos per unit. So a product needs nine prices, not
-- seventeen, and RD+5 cannot drift away from RD by accident — it is defined
-- as RD, adjusted.
--
-- What the adjustment does to the price is a signed peso figure and nothing
-- cleverer. The sign is the one written in the name and means what it says:
-- RD+5 charges five pesos more than RD, PD-15 charges fifteen less than PD.
-- That was asked rather than assumed — the other reading, where a plus means
-- a bigger discount, is just as sayable and would have put a wrong figure on
-- every document quoting one of these codes.
--
-- Zero still means unset rather than "no change", in price_for and on the
-- order screen alike. A code that charges exactly its base is a code that
-- silently does nothing, which is worse than one that refuses, because
-- nobody finds out.
--
-- A code on a line is optional. Until the price lists are loaded the app
-- prices the way it always has, and an order placed today still works. But a
-- code that IS named must have a price behind it — a line that quietly falls
-- back to the wholesale price while printing STOCKIST is worse than a refusal.
-- ============================================================================

create table if not exists price_codes (
  code      text primary key,
  -- Null for the nine that stand on their own. The other eight name one.
  base_code text references price_codes (code),
  -- Pesos per unit, added to the base. Negative takes off.
  adjust    numeric(12,2) not null default 0,
  sort      int  not null default 0,
  active    boolean not null default true,
  -- A code that stands on its own has nothing to adjust.
  constraint a_base_adjusts_nothing check (base_code is not null or adjust = 0),
  -- One level only. RD+5 is RD adjusted; there is no RD+5+5.
  constraint one_level_only check (base_code is null or base_code <> code)
);

-- Lets the price list below refuse a code that is itself an adjustment, in
-- the schema rather than in a function somebody can forget to call.
alter table price_codes drop column if exists is_base;
alter table price_codes add column is_base boolean
  generated always as (base_code is null) stored;
alter table price_codes drop constraint if exists price_codes_code_is_base_key;
alter table price_codes add constraint price_codes_code_is_base_key
  unique (code, is_base);

insert into price_codes (code, base_code, adjust, sort) values
  ('RD',       null,   0,  10),
  ('RD+5',     'RD',   5,  11),
  ('RD+8',     'RD',   8,  12),
  ('RD+10',    'RD',  10,  13),
  ('SUB RD',   null,   0,  20),
  ('PD',       null,   0,  30),
  ('PD+5',     'PD',   5,  31),
  ('PD+10',    'PD',  10,  32),
  ('PD-5',     'PD',  -5,  33),
  ('PD-10',    'PD', -10,  34),
  ('PD-15',    'PD', -15,  35),
  ('CD',       null,   0,  40),
  ('DD',       null,   0,  50),
  ('VIP',      null,   0,  60),
  ('RS',       null,   0,  70),
  ('STOCKIST', null,   0,  80),
  ('EXEC',     null,   0,  90)
on conflict (code) do nothing;

-- Set on a database seeded before the owner settled the direction.
update price_codes set adjust = v.adj
  from (values ('RD+5',5),('RD+8',8),('RD+10',10),('PD+5',5),('PD+10',10),
               ('PD-5',-5),('PD-10',-10),('PD-15',-15)) v(code, adj)
 where price_codes.code = v.code and price_codes.adjust = 0;

-- The price list: one peso figure per product per base code.
create table if not exists product_prices (
  sku     text not null references products (sku) on delete cascade,
  code    text not null,
  is_base boolean not null default true check (is_base),
  price   numeric(12,2) not null check (price >= 0),
  set_at  timestamptz not null default now(),
  primary key (sku, code),
  foreign key (code, is_base) references price_codes (code, is_base)
);
create index if not exists product_prices_by_code on product_prices (code);

-- What a unit of this is called on the paper: PCS, SET, BOX. The column beside
-- PCODE on the invoice, blank until now for the same reason.
alter table products add column if not exists unit_type text not null default 'PCS';

-- The code a line was actually sold at. Null for every line placed before
-- today, which is honest: nobody recorded one.
alter table order_lines add column if not exists price_code text
  references price_codes (code);

-- ---------------------------------------------------------------------------
-- The price a code gives a product, or null if it has not been set
-- ---------------------------------------------------------------------------
create or replace function price_for(p_sku text, p_code text)
returns numeric language sql stable as $$
  select pp.price + c.adjust
    from price_codes c
    join product_prices pp
      on pp.sku = p_sku
     and pp.code = coalesce(c.base_code, c.code)
   where c.code = p_code and c.active
     -- An adjustment still at zero has not been set. RD+5 would charge the
     -- RD price exactly, which is a code that silently does nothing —
     -- worse than a code that refuses, because nobody finds out.
     and (c.base_code is null or c.adjust <> 0);
$$;

comment on function price_for(text, text) is
  'The unit price a code gives a product: the base code''s listed price plus
   the code''s peso adjustment. Null when that base has no price on file, which
   the caller must treat as a refusal rather than as zero.';

grant select on price_codes, product_prices to app_client;
grant execute on function price_for(text, text) to app_client;

alter table price_codes    enable row level security;
alter table product_prices enable row level security;

-- A price list is not a secret from the people who quote from it, and it is
-- not writable by them either: setting a price goes through set_price below,
-- which asks for an owner.
drop policy if exists everyone_reads_price_codes on price_codes;
create policy everyone_reads_price_codes on price_codes for select using (true);
drop policy if exists staff_read_product_prices on product_prices;
create policy staff_read_product_prices on product_prices for select
  using (current_role_name() in ('admin','warehouse','cashier','supervisor','office'));

create or replace function set_price(p_sku text, p_code text, p_price numeric)
returns void language plpgsql security definer as $$
begin
  perform require_role('admin');
  if not exists (select 1 from price_codes where code = p_code and base_code is null) then
    raise exception '% is not a code that carries a price list. Price the base it comes from.', p_code;
  end if;
  insert into product_prices (sku, code, price)
  values (p_sku, p_code, p_price)
  on conflict (sku, code) do update set price = excluded.price, set_at = now();
end;
$$;

create or replace function set_code_adjustment(p_code text, p_adjust numeric)
returns void language plpgsql security definer as $$
begin
  perform require_role('admin');
  update price_codes set adjust = p_adjust
   where code = p_code and base_code is not null;
  if not found then
    raise exception '% is not a code that adjusts another one.', p_code;
  end if;
end;
$$;

grant execute on function set_price(text, text, numeric) to app_client;
grant execute on function set_code_adjustment(text, numeric) to app_client;

-- ---------------------------------------------------------------------------
-- Placing an order — a line may now name the price it was given
--
-- Unchanged from 023 but for the price: a line with no code prices the way it
-- always has, so an order placed today, before any price list exists, still
-- works. A line that names one is priced by it or refused.
-- ---------------------------------------------------------------------------
create or replace function place_order(
  p_channel text, p_lines jsonb, p_reseller bigint default null,
  p_branch bigint default null
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
  v_branch   bigint;
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
      select coalesce(sum((l ->> 'qty')::int * coalesce(
               price_for(l ->> 'sku', nullif(btrim(coalesce(l ->> 'code', '')), '')),
               (select wholesale_price from products where sku = l ->> 'sku'))), 0)
        from jsonb_array_elements(p_lines) l));
  elsif p_channel = 'shop' then
    perform require_role('admin','cashier');
    v_pool := 'shop';
  else
    raise exception 'unknown channel %', p_channel;
  end if;

  v_branch := branch_or_default(p_branch);
  if not exists (select 1 from branches where id = v_branch and active) then
    raise exception 'That branch is not open.';
  end if;

  insert into orders (channel, reseller_id, branch_id)
  values (p_channel, p_reseller, v_branch)
  returning id into v_order;

  for line in
    select l ->> 'sku' as sku, (l ->> 'qty')::int as qty,
           nullif(btrim(coalesce(l ->> 'code', '')), '') as code
      from jsonb_array_elements(p_lines) l
     order by l ->> 'sku'
  loop
    if line.qty is null or line.qty <= 0 then
      raise exception 'quantity must be more than zero for %', line.sku;
    end if;

    if not exists (select 1 from products where sku = line.sku and active) then
      raise exception 'no active product with code %', line.sku;
    end if;
    -- A named code decides the price. If that code has no price on file
    -- for this product the order stops here: a line that silently falls back
    -- to the wholesale price while printing STOCKIST on the invoice is a
    -- wrong figure on a document somebody pays against.
    if line.code is null then
      v_price := effective_price(line.sku, p_channel);
    else
      v_price := price_for(line.sku, line.code);
      if v_price is null then
        raise exception 'PRICE_NOT_SET: % has no price under %.', line.sku, line.code;
      end if;
    end if;
    select unit_cost into v_cost from products where sku = line.sku;

    v_cutoff := earliest_usable_expiry(v_pool, line.sku);
    v_wanted := line.qty;

    -- Oldest first, and only from the shelves of the shop being served.
    for row_ in
      select s.id, s.on_hand, s.committed, s.batch_id
        from stock s
        join batches b on b.id = s.batch_id
       where s.pool = v_pool and s.branch_id = v_branch
         and b.sku = line.sku and b.expiry > v_cutoff
       order by b.expiry, b.id
         for update of s
    loop
      exit when v_wanted <= 0;
      v_take := least(row_.on_hand - row_.committed, v_wanted);
      if v_take > 0 then
        update stock set committed = committed + v_take where id = row_.id;
        insert into order_lines (order_id, sku, batch_id, qty, unit_price,
                                 unit_cost, price_code)
        values (v_order, line.sku, row_.batch_id, v_take, v_price, v_cost,
                line.code);
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
-- The catalogue carries what a unit is called, so the order screen can offer
-- it and the documents can print it.
-- ---------------------------------------------------------------------------
-- Added at the end rather than beside the prices, where it would read
-- better: create-or-replace can only append a column, and dropping the view
-- to reorder would take its grants with it — which is a portal that answers
-- resellers with an error, for the sake of column order nobody sees.
create or replace view b2b_catalog as
select p.sku, p.name, p.brand, p.category, p.wholesale_price, p.srp,
       coalesce(sum(s.on_hand - s.committed), 0)::int as available,
       p.unit_type
  from products p
  left join batches b
    on b.sku = p.sku
   and b.expiry > (current_date + make_interval(months => p.reseller_floor_months))::date
  left join stock s on s.batch_id = b.id and s.pool = 'b2b'
 where p.active
 group by p.sku, p.name, p.brand, p.category, p.wholesale_price, p.srp, p.unit_type;

grant select on b2b_catalog to app_client;

-- These run as their owner, so the schemas they resolve names in are pinned
-- here rather than taken from whoever called them.
alter function set_price(text, text, numeric)  set search_path = public, extensions;
alter function set_code_adjustment(text, numeric) set search_path = public, extensions;
alter function place_order(text, jsonb, bigint, bigint)
  set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- A first guess at what a unit is called, from the product's own name
--
-- Everything defaults to PCS, which is right for most of the catalogue and
-- plainly wrong for a maintenance set. Read off the name rather than left for
-- somebody to set nine hundred times by hand — and it is only a guess, which
-- is why it moves nothing that has already been set to something else.
-- ---------------------------------------------------------------------------
update products set unit_type = 'SET'
 where name ~* '(^|[^a-z])(sets?|kits?)([^a-z]|$)' and unit_type = 'PCS';
update products set unit_type = 'BOX'
 where name ~* '(^|[^a-z])box([^a-z]|$)' and unit_type = 'PCS';

-- ---------------------------------------------------------------------------
-- Where the price lists came from
--
-- The prices are data and live in the database rather than here, but the
-- account of where they came from belongs with the schema, because whoever
-- loads the next price list will meet the same three questions.
--
-- Source: "MS BEAU PRICE LIST (PRODUCT LIST).xlsx", sheet NEW DEPOT PRICE,
-- dated 18 Jul 2026 — chosen by the owner over the SKU-keyed sheet, which is
-- eight months older and disagrees with it on about one price in five.
--
-- That sheet has no SKU column, so each row was keyed through the exact
-- product name in MS BEAU PRODUCT SKU, where 848 names each name exactly one
-- SKU. 713 products came through and carry 3,317 prices.
--
-- Three things were deliberately not loaded rather than guessed:
--   * 44 products the depot sheet prices twice, differently, one row dated
--     and one not. There is no rule that says which is current.
--   * 274 depot rows whose name matches no SKU.
--   * SUB RD, VIP, STOCKIST and EXEC, which no sheet in the workbook prices.
--     VIP appears on two sheets that disagree with each other and neither
--     carries a SKU.
--
--   RD <- REGIONAL      PD <- PROVINCIAL (the workbook's own glossary says
--   DD <- DISTRICT DD   so)              CD <- CITY DISTRI   RS <- Reseller
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- What this product costs under every code it is priced under
--
-- Whether a code has a price is a fact about the product, not about the code:
-- RD prices six hundred products and not the other three hundred. The prices
-- come with it because the person taking the order has to quote a total into
-- a chat before placing it, and a basket showing the old wholesale price
-- while the invoice charges the coded one is a number given to a customer
-- that the company then does not honour.
--
-- Adjusted codes are resolved here, so the screen never does the arithmetic.
--
-- Appended, again, because create-or-replace can only add a column at the end.
-- ---------------------------------------------------------------------------
create or replace view b2b_catalog as
select p.sku, p.name, p.brand, p.category, p.wholesale_price, p.srp,
       coalesce(sum(s.on_hand - s.committed), 0)::int as available,
       p.unit_type,
       (select coalesce(jsonb_object_agg(c.code, pp.price + c.adjust), '{}'::jsonb)
          from price_codes c
          join product_prices pp
            on pp.sku = p.sku
           and pp.code = coalesce(c.base_code, c.code)
         where c.active
           and (c.base_code is null or c.adjust <> 0)) as prices
  from products p
  left join batches b
    on b.sku = p.sku
   and b.expiry > (current_date + make_interval(months => p.reseller_floor_months))::date
  left join stock s on s.batch_id = b.id and s.pool = 'b2b'
 where p.active
 group by p.sku, p.name, p.brand, p.category, p.wholesale_price, p.srp, p.unit_type;

grant select on b2b_catalog to app_client;

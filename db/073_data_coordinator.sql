-- ============================================================================
-- MS BEAU AVE — the data coordinator
--
-- New products arrive and stock has to be entered: a delivery received, a
-- count corrected, a product that did not exist yesterday added to the
-- catalogue. Until now the only sign-in that could add a product was the
-- owner's, so keeping the catalogue current meant handing over pricing, the
-- company's money and every staff record along with it — the same missing
-- smaller key the order desk had.
--
-- This is that key for the stockroom's paperwork. A data coordinator does the
-- warehouse's stock work — receive, count, transfer, write off what expired,
-- raise a purchase order, set a reorder point, add a supplier — and one thing
-- the warehouse could not: add and edit a product in the catalogue. What it
-- never touches is a SELLING PRICE. A new product is added with none, and
-- stays off the shelf until the owner prices it on Pricelists; the per-code
-- dealer prices are set by set_price, which stays the owner's alone.
--
-- Two other things it is not. It is not the till, and it is not customer-order
-- fulfilment: dispatching, cancelling and marking an order delivered move
-- stock too, but they move money and a reseller's order with it, so they stay
-- with the warehouse and the order desk. So the stock functions are named
-- one by one below rather than inherited wholesale — a warehouse function
-- written next year is the warehouse's until somebody adds it here on purpose.
-- ============================================================================

alter table app_users drop constraint if exists app_users_role_check;
alter table app_users add constraint app_users_role_check
  check (role in ('admin','warehouse','cashier','supervisor','office',
                  'timekeeper','reseller','employee','observer','orderdesk','datacoord'));

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
  if p_role not in ('admin','warehouse','cashier','supervisor','office',
                    'timekeeper','reseller','employee','observer','orderdesk','datacoord') then
    raise exception '% is not something a sign-in can be.', p_role;
  end if;

  if exists (select 1 from app_users where lower(username) = lower(btrim(p_username))) then
    raise exception 'There is already a sign-in called %.', btrim(p_username);
  end if;

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

-- The role change picker learns the new name too.
create or replace function set_login_role(p_user bigint, p_role text) returns text
language plpgsql security definer as $$
declare v_was text; v_name text;
begin
  perform require_role('admin');

  select role, display_name into v_was, v_name from app_users where id = p_user;
  if not found then
    raise exception 'There is no such sign-in.';
  end if;

  if p_role not in ('admin','warehouse','cashier','supervisor','office',
                    'timekeeper','reseller','employee','observer','orderdesk','datacoord') then
    raise exception '% is not something a sign-in can be.', p_role;
  end if;

  if p_role = v_was then
    return v_name;
  end if;

  if p_role = 'reseller' or v_was = 'reseller' then
    raise exception
      'A portal sign-in belongs to the reseller it was made for. Remove this one and make a new one rather than moving it in or out of the portal.';
  end if;

  if v_was = 'admin'
     and not exists (select 1 from app_users
                      where role = 'admin' and active and id <> p_user) then
    raise exception
      'That is the last owner sign-in, and nobody else could put it back. Give somebody else admin first.';
  end if;

  update app_users set role = p_role, sessions_from = now() where id = p_user;
  return v_name;
end;
$$;

alter function set_login_role(bigint, text) set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- What a data coordinator may read
--
-- Exactly what the warehouse reads, and no more: wherever a table grants the
-- warehouse a SELECT, the data coordinator gets one too. Done by walking the
-- warehouse's own read policies rather than by listing tables here, so the two
-- cannot drift apart — a table the warehouse is later allowed to read, the
-- data coordinator is allowed to read on the same day. What the warehouse
-- cannot read (the company's money, anybody's pay) it still cannot, and
-- neither can this.
-- ---------------------------------------------------------------------------
do $reads$
declare t text;
begin
  for t in
    select distinct tablename from pg_policies
     where schemaname = 'public' and cmd = 'SELECT' and qual like '%warehouse%'
  loop
    execute format('drop policy if exists %I on %I', 'datacoord_reads_' || t, t);
    execute format(
      $f$create policy %I on %I for select using (current_role_name() = 'datacoord')$f$,
      'datacoord_reads_' || t, t);
  end loop;
end
$reads$;

-- ---------------------------------------------------------------------------
-- Adding and editing a product — the one thing beyond the warehouse
--
-- The product routes write the table directly rather than through a function,
-- so the permission is a policy on the table. A selling price is not part of
-- what these policies allow to matter: the route drops the three price columns
-- for a data coordinator before it writes, so a new product lands priced at
-- nothing and the owner prices it. product_prices — the real dealer prices —
-- has no datacoord policy at all, so set_price stays the owner's.
-- ---------------------------------------------------------------------------
drop policy if exists datacoord_adds_products on products;
create policy datacoord_adds_products on products for insert
  with check (current_role_name() = 'datacoord');
drop policy if exists datacoord_edits_products on products;
create policy datacoord_edits_products on products for update
  using (current_role_name() = 'datacoord')
  with check (current_role_name() = 'datacoord');

-- ---------------------------------------------------------------------------
-- The stock work — named, not inherited
--
-- Every function is already the warehouse's; this adds the data coordinator
-- beside it. Order fulfilment (fulfil_order, start_picking, mark_delivered,
-- cancel_order) and the pool-move (move_stock, which is the owner's even for
-- the warehouse) are deliberately absent from the list.
-- ---------------------------------------------------------------------------
do $stock$
declare
  fn text; def text; done int := 0;
  wanted text[] := array[
    'receive_stock', 'receive_delivery', 'receive_po_line', 'record_receiving_form',
    'record_stock_count', 'raise_purchase_order', 'cancel_purchase_order',
    'set_reorder_point', 'recalc_demand', 'transfer_stock', 'save_supplier',
    'write_off_expired'
  ];
begin
  for fn, def in
    select p.proname, pg_get_functiondef(p.oid)
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prokind = 'f' and p.proname = any (wanted)
  loop
    if def like '%''datacoord''%' then continue; end if;
    -- Beside 'warehouse' inside require_role, so a guard that reads
    -- ('admin','warehouse','office') keeps its shape.
    execute regexp_replace(def, '(require_role\([^)]*)''warehouse''',
                           '\1''warehouse'',''datacoord''', 'g');
    done := done + 1;
  end loop;
  raise notice 'data coordinator: widened % stock function(s)', done;
end
$stock$;

-- ---------------------------------------------------------------------------
-- The ordinary half — a data coordinator works here too
--
-- Same lesson the order desk taught: the menu lists My record, My leave and
-- the noticeboard, and every screen behind them was written for 'employee'.
-- So wherever a function admits an employee, it admits a data coordinator.
-- ---------------------------------------------------------------------------
do $staff$
declare fn text; def text; done int := 0;
begin
  for fn, def in
    select p.proname, pg_get_functiondef(p.oid)
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prokind = 'f'
       and pg_get_functiondef(p.oid) ~ 'require_role\([^)]*''employee'''
  loop
    if def like '%''datacoord''%' then continue; end if;
    execute regexp_replace(def, '(require_role\([^)]*)''employee''',
                           '\1''employee'',''datacoord''', 'g');
    done := done + 1;
  end loop;
  raise notice 'data coordinator: % function(s) that admit an employee now admit it too', done;
end
$staff$;

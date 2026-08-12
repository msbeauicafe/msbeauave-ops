-- ============================================================================
-- MS BEAU AVE — the supervisor
--
-- A shop cannot be run a day without somebody who is neither the owner nor on
-- one job. The person who opens up covers the till at lunch, signs for the
-- delivery at two, writes off the tester somebody dropped, and counts the
-- shelf before locking the door. Until now the only account that could do all
-- of that was admin — which also changes prices, reads the whole company's
-- money, and deletes people. Handing that to whoever opens up is how a shop
-- ends up with one password everybody knows.
--
-- So: a supervisor is a cashier and a stockroom person, on one floor. Not a
-- little bit of an owner.
--
-- The way that is enforced matters. There are eighty-odd role checks across
-- the engine, and adding 'supervisor' to each by hand would mean eighty
-- chances to add it to the wrong one — and the one that goes wrong is silent,
-- because a permission that is too wide never raises an error. Instead the
-- check itself understands the role: wherever a cashier or a stockroom person
-- is allowed, a supervisor is too. Wherever only the owner is allowed, they
-- are not, and there is no list to keep in step.
-- ============================================================================

alter table app_users drop constraint if exists app_users_role_check;
alter table app_users add constraint app_users_role_check
  check (role in ('admin','warehouse','cashier','supervisor','reseller'));

-- One place decides what a supervisor is. Note what is deliberately absent:
-- 'admin' is never satisfied by inheritance, so pricing, the catalogue, the
-- company's finances, staff records, sign-ins, promos, branches and reseller
-- credit stay exactly where they were.
create or replace function require_role(variadic allowed text[]) returns void
language plpgsql stable as $$
declare v_role text := current_role_name();
begin
  if v_role = any (allowed) then
    return;
  end if;
  if v_role = 'supervisor'
     and ('cashier' = any (allowed) or 'warehouse' = any (allowed)) then
    return;
  end if;
  raise exception 'FORBIDDEN: % may not do that', v_role using errcode = '42501';
end;
$$;

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
  if p_role not in ('admin', 'warehouse', 'cashier', 'supervisor', 'reseller') then
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

-- Row-level policies name their roles literally, so inheritance in require_role
-- does not reach them. Every table below is already readable by a cashier or a
-- stockroom person, and a supervisor is both, so the grant is additive: a new
-- permissive policy rather than an edit to an existing one. Nothing a
-- supervisor could not already have been shown by standing next to somebody.
--
-- This list is the one place that has to be kept in step by hand, so there is
-- a test that fails if a table becomes readable by the shop floor without a
-- supervisor policy to match.
drop policy if exists supervisor_reads_batches on batches;
create policy supervisor_reads_batches on batches for select
  using (current_role_name() = 'supervisor');
drop policy if exists supervisor_reads_branches on branches;
create policy supervisor_reads_branches on branches for select
  using (current_role_name() = 'supervisor');
drop policy if exists supervisor_reads_employee_photos on employee_photos;
create policy supervisor_reads_employee_photos on employee_photos for select
  using (current_role_name() = 'supervisor');
drop policy if exists supervisor_reads_employees on employees;
create policy supervisor_reads_employees on employees for select
  using (current_role_name() = 'supervisor');
drop policy if exists supervisor_reads_movements on movements;
create policy supervisor_reads_movements on movements for select
  using (current_role_name() = 'supervisor');
drop policy if exists supervisor_reads_orders on orders;
create policy supervisor_reads_orders on orders for select
  using (current_role_name() = 'supervisor');
drop policy if exists supervisor_reads_pickups on pickups;
create policy supervisor_reads_pickups on pickups for select
  using (current_role_name() = 'supervisor');
drop policy if exists supervisor_reads_posts on posts;
create policy supervisor_reads_posts on posts for select
  using (current_role_name() = 'supervisor');
drop policy if exists supervisor_reads_products on products;
create policy supervisor_reads_products on products for select
  using (current_role_name() = 'supervisor');
drop policy if exists supervisor_reads_promos on promos;
create policy supervisor_reads_promos on promos for select
  using (current_role_name() = 'supervisor');
drop policy if exists supervisor_reads_receipt_reversals on receipt_reversals;
create policy supervisor_reads_receipt_reversals on receipt_reversals for select
  using (current_role_name() = 'supervisor');
drop policy if exists supervisor_reads_reorder_points on reorder_points;
create policy supervisor_reads_reorder_points on reorder_points for select
  using (current_role_name() = 'supervisor');
drop policy if exists supervisor_reads_restock_tasks on restock_tasks;
create policy supervisor_reads_restock_tasks on restock_tasks for select
  using (current_role_name() = 'supervisor');
drop policy if exists supervisor_reads_returns on returns;
create policy supervisor_reads_returns on returns for select
  using (current_role_name() = 'supervisor');
drop policy if exists supervisor_reads_sale_customers on sale_customers;
create policy supervisor_reads_sale_customers on sale_customers for select
  using (current_role_name() = 'supervisor');
drop policy if exists supervisor_reads_sales on sales;
create policy supervisor_reads_sales on sales for select
  using (current_role_name() = 'supervisor');
drop policy if exists supervisor_reads_shifts on shifts;
create policy supervisor_reads_shifts on shifts for select
  using (current_role_name() = 'supervisor');
drop policy if exists supervisor_reads_shrinkage on shrinkage;
create policy supervisor_reads_shrinkage on shrinkage for select
  using (current_role_name() = 'supervisor');
drop policy if exists supervisor_reads_stock on stock;
create policy supervisor_reads_stock on stock for select
  using (current_role_name() = 'supervisor');
drop policy if exists supervisor_reads_stock_counts on stock_counts;
create policy supervisor_reads_stock_counts on stock_counts for select
  using (current_role_name() = 'supervisor');
drop policy if exists supervisor_reads_tasks on tasks;
create policy supervisor_reads_tasks on tasks for select
  using (current_role_name() = 'supervisor');

alter function require_role(text[]) set search_path = public, extensions;
alter function create_login(text, text, text, text, bigint)
  set search_path = public, extensions;

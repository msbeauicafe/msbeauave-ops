-- ============================================================================
-- MS BEAU AVE — the office
--
-- Office staff are not on the shop floor and not over it. They cover the till
-- when it is busy and the stockroom when a delivery lands, and they need to see
-- both to be any use — but the day's takings are not theirs to read, and a
-- shop's money is a different question from a shop's work.
--
-- So an office sign-in is exactly what a cashier and a stockroom person can do
-- between them, and nothing more. That is the supervisor's reach minus one
-- screen: the supervisor answers for the shop and sees what it took; the office
-- helps run it and does not.
--
-- The mechanism is the one already in require_role. Rather than eighty edits,
-- the check knows that an office sign-in satisfies a cashier or stockroom
-- requirement — and never an owner's.
-- ============================================================================

alter table app_users drop constraint if exists app_users_role_check;
alter table app_users add constraint app_users_role_check
  check (role in ('admin','warehouse','cashier','supervisor','office','timekeeper','reseller'));

-- One place decides what these two roles are. 'admin' is never satisfied by
-- inheritance, so pricing, the catalogue, the company's finances, staff
-- records, sign-ins, promos, branches and reseller credit stay where they were.
create or replace function require_role(variadic allowed text[]) returns void
language plpgsql stable as $$
declare v_role text := current_role_name();
begin
  if v_role = any (allowed) then
    return;
  end if;
  if v_role in ('supervisor', 'office')
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
  if p_role not in ('admin','warehouse','cashier','supervisor','office','timekeeper','reseller') then
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

-- Row-level policies name their roles literally, so the inheritance above does
-- not reach them. Same tables as the supervisor: everything the shop floor can
-- already read, and nothing else. A test fails if this list falls behind.
drop policy if exists office_reads_batches on batches;
create policy office_reads_batches on batches for select
  using (current_role_name() = 'office');
drop policy if exists office_reads_branches on branches;
create policy office_reads_branches on branches for select
  using (current_role_name() = 'office');
drop policy if exists office_reads_employee_photos on employee_photos;
create policy office_reads_employee_photos on employee_photos for select
  using (current_role_name() = 'office');
drop policy if exists office_reads_employees on employees;
create policy office_reads_employees on employees for select
  using (current_role_name() = 'office');
drop policy if exists office_reads_movements on movements;
create policy office_reads_movements on movements for select
  using (current_role_name() = 'office');
drop policy if exists office_reads_orders on orders;
create policy office_reads_orders on orders for select
  using (current_role_name() = 'office');
drop policy if exists office_reads_pickups on pickups;
create policy office_reads_pickups on pickups for select
  using (current_role_name() = 'office');
drop policy if exists office_reads_posts on posts;
create policy office_reads_posts on posts for select
  using (current_role_name() = 'office');
drop policy if exists office_reads_products on products;
create policy office_reads_products on products for select
  using (current_role_name() = 'office');
drop policy if exists office_reads_promos on promos;
create policy office_reads_promos on promos for select
  using (current_role_name() = 'office');
drop policy if exists office_reads_receipt_reversals on receipt_reversals;
create policy office_reads_receipt_reversals on receipt_reversals for select
  using (current_role_name() = 'office');
drop policy if exists office_reads_reorder_points on reorder_points;
create policy office_reads_reorder_points on reorder_points for select
  using (current_role_name() = 'office');
drop policy if exists office_reads_restock_tasks on restock_tasks;
create policy office_reads_restock_tasks on restock_tasks for select
  using (current_role_name() = 'office');
drop policy if exists office_reads_returns on returns;
create policy office_reads_returns on returns for select
  using (current_role_name() = 'office');
drop policy if exists office_reads_sale_customers on sale_customers;
create policy office_reads_sale_customers on sale_customers for select
  using (current_role_name() = 'office');
drop policy if exists office_reads_sales on sales;
create policy office_reads_sales on sales for select
  using (current_role_name() = 'office');
drop policy if exists office_reads_shifts on shifts;
create policy office_reads_shifts on shifts for select
  using (current_role_name() = 'office');
drop policy if exists office_reads_shrinkage on shrinkage;
create policy office_reads_shrinkage on shrinkage for select
  using (current_role_name() = 'office');
drop policy if exists office_reads_stock on stock;
create policy office_reads_stock on stock for select
  using (current_role_name() = 'office');
drop policy if exists office_reads_stock_counts on stock_counts;
create policy office_reads_stock_counts on stock_counts for select
  using (current_role_name() = 'office');
drop policy if exists office_reads_tasks on tasks;
create policy office_reads_tasks on tasks for select
  using (current_role_name() = 'office');

alter function require_role(text[]) set search_path = public, extensions;
alter function create_login(text, text, text, text, bigint)
  set search_path = public, extensions;

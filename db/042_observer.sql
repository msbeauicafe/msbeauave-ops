-- ============================================================================
-- MS BEAU AVE — somebody who may look and not touch
--
-- Fifteen managers and coordinators need to see how the company is running
-- without being able to change any of it. Until now the only way to show
-- somebody the stock, the orders and the team was to make them an owner, which
-- also let them re-price the catalogue and erase a person's year.
--
-- So: a role that can read and cannot write, by construction rather than by
-- politeness. It gets select policies and nothing else, and require_role —
-- which every function that changes anything asks first — never accepts it.
-- There is no list of forbidden actions to keep up to date; a function added
-- next year refuses an observer without anybody remembering to make it.
--
-- Two things stay out. The company's money, because Finance is the owner's
-- book and not a management report. And anybody's pay: employment_details has
-- no policy here, so a salary is not merely hidden on a screen — it is not
-- readable at all, which is the only version of hidden that survives somebody
-- opening the network tab.
-- ============================================================================
alter table app_users drop constraint if exists app_users_role_check;
alter table app_users add constraint app_users_role_check
  check (role in ('admin','warehouse','cashier','supervisor','office',
                  'timekeeper','reseller','employee','observer'));

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
                    'timekeeper','reseller','employee','observer') then
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

-- ---------------------------------------------------------------------------
-- What an observer may read
--
-- Select only, every one of them. Note what is not on this list:
-- employment_details, which holds pay. A salary an observer cannot select is
-- a salary that is not on the page whatever the page tries to do.
-- ---------------------------------------------------------------------------
drop policy if exists observer_reads_batches on batches;
create policy observer_reads_batches on batches for select
  using (current_role_name() = 'observer');
drop policy if exists observer_reads_branches on branches;
create policy observer_reads_branches on branches for select
  using (current_role_name() = 'observer');
drop policy if exists observer_reads_employee_photos on employee_photos;
create policy observer_reads_employee_photos on employee_photos for select
  using (current_role_name() = 'observer');
drop policy if exists observer_reads_employees on employees;
create policy observer_reads_employees on employees for select
  using (current_role_name() = 'observer');
drop policy if exists observer_reads_movements on movements;
create policy observer_reads_movements on movements for select
  using (current_role_name() = 'observer');
drop policy if exists observer_reads_orders on orders;
create policy observer_reads_orders on orders for select
  using (current_role_name() = 'observer');
drop policy if exists observer_reads_pickups on pickups;
create policy observer_reads_pickups on pickups for select
  using (current_role_name() = 'observer');
drop policy if exists observer_reads_posts on posts;
create policy observer_reads_posts on posts for select
  using (current_role_name() = 'observer');
drop policy if exists observer_reads_products on products;
create policy observer_reads_products on products for select
  using (current_role_name() = 'observer');
drop policy if exists observer_reads_promos on promos;
create policy observer_reads_promos on promos for select
  using (current_role_name() = 'observer');
drop policy if exists observer_reads_receipt_reversals on receipt_reversals;
create policy observer_reads_receipt_reversals on receipt_reversals for select
  using (current_role_name() = 'observer');
drop policy if exists observer_reads_reorder_points on reorder_points;
create policy observer_reads_reorder_points on reorder_points for select
  using (current_role_name() = 'observer');
drop policy if exists observer_reads_restock_tasks on restock_tasks;
create policy observer_reads_restock_tasks on restock_tasks for select
  using (current_role_name() = 'observer');
drop policy if exists observer_reads_returns on returns;
create policy observer_reads_returns on returns for select
  using (current_role_name() = 'observer');
drop policy if exists observer_reads_sale_customers on sale_customers;
create policy observer_reads_sale_customers on sale_customers for select
  using (current_role_name() = 'observer');
drop policy if exists observer_reads_sales on sales;
create policy observer_reads_sales on sales for select
  using (current_role_name() = 'observer');
drop policy if exists observer_reads_shifts on shifts;
create policy observer_reads_shifts on shifts for select
  using (current_role_name() = 'observer');
drop policy if exists observer_reads_shrinkage on shrinkage;
create policy observer_reads_shrinkage on shrinkage for select
  using (current_role_name() = 'observer');
drop policy if exists observer_reads_stock on stock;
create policy observer_reads_stock on stock for select
  using (current_role_name() = 'observer');
drop policy if exists observer_reads_stock_counts on stock_counts;
create policy observer_reads_stock_counts on stock_counts for select
  using (current_role_name() = 'observer');
drop policy if exists observer_reads_tasks on tasks;
create policy observer_reads_tasks on tasks for select
  using (current_role_name() = 'observer');
drop policy if exists observer_reads_customers on customers;
create policy observer_reads_customers on customers for select
  using (current_role_name() = 'observer');
drop policy if exists observer_reads_resellers on resellers;
create policy observer_reads_resellers on resellers for select
  using (current_role_name() = 'observer');
drop policy if exists observer_reads_leave_requests on leave_requests;
create policy observer_reads_leave_requests on leave_requests for select
  using (current_role_name() = 'observer');
drop policy if exists observer_reads_appraisals on appraisals;
create policy observer_reads_appraisals on appraisals for select
  using (current_role_name() = 'observer');
drop policy if exists observer_reads_announcements on announcements;
create policy observer_reads_announcements on announcements for select
  using (current_role_name() = 'observer');
drop policy if exists observer_reads_applications on applications;
create policy observer_reads_applications on applications for select
  using (current_role_name() = 'observer');

-- ---------------------------------------------------------------------------
-- The read-only functions an observer needs
--
-- Widened one at a time and by name. A function that reports hours or who came
-- in is a management report; one that changes a shift is not, and none of those
-- appear here.
-- ---------------------------------------------------------------------------
create or replace function attendance_on(p_day date default null, p_branch bigint default null)
returns table (
  employee_id bigint, name text, "position" text, branch text, branch_id bigint,
  has_photo boolean, first_in timestamptz, last_out timestamptz,
  stretches int, worked interval, still_on boolean)
language plpgsql stable security definer as $$
declare v_day date := coalesce(p_day, (now() at time zone 'Asia/Manila')::date);
begin
  perform require_role('admin','observer');
  return query
  select e.id, e.name, e.position, b.name, e.branch_id,
         (ph.employee_id is not null),
         min(s.started_at),
         case when coalesce(bool_or(s.id is not null and s.ended_at is null), false)
              then null else max(s.ended_at) end,
         count(s.id)::int,
         coalesce(sum(coalesce(s.ended_at, now()) - s.started_at), interval '0'),
         coalesce(bool_or(s.id is not null and s.ended_at is null), false)
    from employees e
    join branches b on b.id = e.branch_id
    left join employee_photos ph on ph.employee_id = e.id
    left join shifts s on s.employee_id = e.id and s.business_date = v_day
   where e.ended_on is null
     and (p_branch is null or e.branch_id = p_branch)
   group by e.id, e.name, e.position, b.name, e.branch_id, ph.employee_id
   order by (min(s.started_at) is null), min(s.started_at), e.name;
end;
$$;

create or replace function attendance_detail(p_day date default null, p_branch bigint default null)
returns table (
  id bigint, employee_id bigint, name text, branch text,
  started_at timestamptz, ended_at timestamptz, worked interval,
  started_by text, ended_by text, note text)
language plpgsql stable security definer as $$
declare v_day date := coalesce(p_day, (now() at time zone 'Asia/Manila')::date);
begin
  perform require_role('admin','observer');
  return query
  select s.id, s.employee_id, e.name, b.name,
         s.started_at, s.ended_at,
         coalesce(s.ended_at, now()) - s.started_at,
         s.started_by, s.ended_by, s.note
    from shifts s
    join employees e on e.id = s.employee_id
    join branches b on b.id = e.branch_id
   where s.business_date = v_day
     and (p_branch is null or e.branch_id = p_branch)
   order by s.started_at;
end;
$$;

create or replace function attendance_summary(
  p_from date, p_to date, p_branch bigint default null)
returns table (
  employee_id bigint, name text, "position" text, branch text,
  days_present int, stretches int, worked interval, last_seen timestamptz)
language plpgsql stable security definer as $$
begin
  perform require_role('admin','observer');
  return query
  select e.id, e.name, e.position, b.name,
         count(distinct s.business_date)::int,
         count(s.id)::int,
         coalesce(sum(coalesce(s.ended_at, now()) - s.started_at), interval '0'),
         max(s.started_at)
    from employees e
    join branches b on b.id = e.branch_id
    left join shifts s on s.employee_id = e.id
         and s.business_date between p_from and p_to
   where e.ended_on is null
     and (p_branch is null or e.branch_id = p_branch)
   group by e.id, e.name, e.position, b.name
   order by count(distinct s.business_date), e.name;
end;
$$;

grant select on team, shifts_recent, crm_customers, hr_people, hr_leave to app_client;

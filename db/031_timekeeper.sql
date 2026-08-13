-- ============================================================================
-- MS BEAU AVE — the timekeeper
--
-- Setting up the door tablet meant signing it in as a person: an owner or a
-- supervisor typed their own username and password into a device that then sat
-- on a counter for the rest of the day. Everything that account could do, that
-- tablet could do — and a tablet does not know when it has been picked up by
-- the wrong hands.
--
-- A timekeeper is not a person. It is the tablet's own sign-in, and it can do
-- exactly two things: see who is on the team, and clock them in and out. It
-- cannot open the till, read a price, touch stock, or see a peso. If the tablet
-- walks out of the shop, what walks with it is a staff list and a clock.
--
-- It is deliberately not covered by the supervisor inheritance in require_role:
-- a timekeeper is not a cashier or a stockroom person with less, it is a
-- different thing entirely, and the only places it is allowed are the handful
-- named for it.
-- ============================================================================

alter table app_users drop constraint if exists app_users_role_check;
alter table app_users add constraint app_users_role_check
  check (role in ('admin','warehouse','cashier','supervisor','timekeeper','reseller'));

-- Reads: the faces on the board, and the shifts behind them. Nothing about
-- stock, money, orders or customers — those tables are simply not listed.
drop policy if exists timekeeper_reads_employees on employees;
create policy timekeeper_reads_employees on employees for select
  using (current_role_name() = 'timekeeper');
drop policy if exists timekeeper_reads_employee_photos on employee_photos;
create policy timekeeper_reads_employee_photos on employee_photos for select
  using (current_role_name() = 'timekeeper');
drop policy if exists timekeeper_reads_branches on branches;
create policy timekeeper_reads_branches on branches for select
  using (current_role_name() = 'timekeeper');
drop policy if exists timekeeper_reads_shifts on shifts;
create policy timekeeper_reads_shifts on shifts for select
  using (current_role_name() = 'timekeeper');

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
  if p_role not in ('admin', 'warehouse', 'cashier', 'supervisor', 'timekeeper', 'reseller') then
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

-- The clock itself has to accept a timekeeper. This is the function exactly as
-- it was, with one role added to the line that guards it — everything else
-- that says 'cashier' or 'warehouse' still refuses.
create or replace function clock_toggle(p_employee bigint)
returns jsonb language plpgsql security definer as $$
declare
  v_name    text;
  v_open    shifts%rowtype;
  v_worked  interval;
begin
  perform require_role('admin', 'cashier', 'warehouse', 'timekeeper');

  select name into v_name from employees where id = p_employee and ended_on is null;
  if not found then
    raise exception 'That person is not on the team.';
  end if;

  select * into v_open from shifts where employee_id = p_employee and ended_at is null;
  if found then
    update shifts set ended_at = now(), ended_by = current_actor()
     where id = v_open.id
     returning now() - started_at into v_worked;
    return jsonb_build_object('action', 'out', 'name', v_name, 'at', now(),
                              'worked_minutes', round(extract(epoch from v_worked) / 60));
  end if;

  insert into shifts (employee_id) values (p_employee);
  return jsonb_build_object('action', 'in', 'name', v_name, 'at', now());
end;
$$;

alter function create_login(text, text, text, text, bigint)
  set search_path = public, extensions;
alter function clock_toggle(bigint) set search_path = public, extensions;

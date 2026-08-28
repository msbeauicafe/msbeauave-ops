-- Somebody who buys to send on to a third party.
--
-- One account works this way — Valerine Rodil, whose order forms have carried
-- a handwritten "DS: JHEM" beside her name for as long as the form has
-- existed. The rest do not, and a Drop ship box on every order would be a
-- field sixty-odd accounts have to ignore and one of them has to remember.
--
-- So it is a switch on the account. Off for everybody by default; on for the
-- account that needs it, and only then does the box appear. If a second
-- account starts working this way it is a switch, not a change to the code —
-- which is the point of it being data rather than a name written into a file.
alter table resellers add column if not exists drop_ship boolean not null default false;

-- Who it usually goes to, so the person taking the order is not typing the
-- same name every time; and who it went to on this order, because a default
-- that cannot be overridden is a default that will eventually be wrong.
alter table resellers add column if not exists drop_ship_to text;
alter table orders    add column if not exists drop_ship text;

create or replace function set_reseller_drop_ship(
  p_id bigint, p_on boolean, p_to text)
returns void language plpgsql security definer as $$
declare v_name text;
begin
  perform require_role('admin');
  select name into v_name from resellers where id = p_id;
  if not found then raise exception 'There is no reseller with that number.'; end if;

  update resellers
     set drop_ship = coalesce(p_on, false),
         -- Turning it off forgets the name rather than leaving it to reappear
         -- on a form months later when somebody turns it back on.
         drop_ship_to = case when coalesce(p_on, false)
                             then nullif(btrim(coalesce(p_to, '')), '') end
   where id = p_id;
end $$;

-- Set on the order rather than passed into the function that places it: there
-- are five of those across five migrations, each a replacement of the last,
-- and a parameter added to the newest would go missing down any path that
-- still reaches an older body.
create or replace function set_order_drop_ship(p_order bigint, p_to text)
returns text language plpgsql security definer as $$
declare v_reseller bigint; v_allowed boolean; v_to text;
begin
  perform require_role('admin', 'office');
  select o.reseller_id into v_reseller from orders o where o.id = p_order;
  if not found then raise exception 'No such order.'; end if;
  if v_reseller is null then
    raise exception 'A counter sale is not shipped on to anybody.';
  end if;

  select drop_ship into v_allowed from resellers where id = v_reseller;
  if not coalesce(v_allowed, false) then
    raise exception 'DROP_SHIP_OFF: that account is not set up to ship on to anybody.';
  end if;

  v_to := nullif(btrim(coalesce(p_to, '')), '');
  update orders set drop_ship = v_to where id = p_order;
  -- What was typed this time is what fills the box next time.
  if v_to is not null then
    update resellers set drop_ship_to = v_to where id = v_reseller;
  end if;
  return v_to;
end $$;

alter function set_reseller_drop_ship(bigint, boolean, text) set search_path = public, extensions;
alter function set_order_drop_ship(bigint, text)             set search_path = public, extensions;
revoke all on function set_reseller_drop_ship(bigint, boolean, text) from public;
revoke all on function set_order_drop_ship(bigint, text)             from public;
grant execute on function set_reseller_drop_ship(bigint, boolean, text) to app_client;
grant execute on function set_order_drop_ship(bigint, text)             to app_client;

-- It has to reach the screens that print it.
create or replace view order_board as
select o.id, o.channel, o.status, o.total, o.placed_at, o.placed_by, o.delivered_at,
       o.reseller_id, r.name as reseller, r.tier,
       i.id as invoice_id, i.status as invoice_status, i.due_on,
       i.status = 'open' and i.due_on < current_date as invoice_overdue,
       case when current_role_name() = 'admin'
            then (i.amount - i.paid - i.discount) end as balance,
       r.tax_type, r.trade_name, r.taxpayer_name, r.tin, r.business_address,
       o.co_no, o.pl_no, i.si_no,
       o.shipping, o.others, o.subtotal,
       o.drop_ship
  from orders o
  left join resellers r on r.id = o.reseller_id
  left join invoices i on i.order_id = o.id
 where current_role_name() in ('admin','warehouse');

grant select on order_board to app_client;

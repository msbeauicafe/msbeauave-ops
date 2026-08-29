-- ============================================================================
-- MS BEAU AVE — the order desk
--
-- Two people take reseller orders all day and do nothing else in here. Until
-- now the only sign-in that could do that work was the owner's, so taking an
-- order meant handing somebody the keys to pricing, the catalogue, the
-- company's money and every staff record — because there was no smaller key.
--
-- This is the smaller key. Inside Customer order an order desk is an owner:
-- place, revise, invoice, renumber, pick, dispatch, cancel, confirm a transfer,
-- issue a receipt. Outside it there is nothing — not the pricelist, not
-- Finance, not HR, not the reseller's own terms and credit limit, which are
-- under Customers and are the owner's to set.
--
-- The office role a few migrations back could be done by inheritance, because
-- an office sign-in is exactly a cashier and a stockroom person put together —
-- a union of things that already existed. This one is not: it is a slice of
-- the owner, and there is no honest way to say "an owner, but only here"
-- except to name the functions where it holds. So they are named, once, in the
-- list below. A function that is not on it refuses an order desk, and a
-- function written next year refuses one without anybody remembering to make
-- it — which is the property worth having.
-- ============================================================================

alter table app_users drop constraint if exists app_users_role_check;
alter table app_users add constraint app_users_role_check
  check (role in ('admin','warehouse','cashier','supervisor','office',
                  'timekeeper','reseller','employee','observer','orderdesk'));

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
                    'timekeeper','reseller','employee','observer','orderdesk') then
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

-- Replacing a function drops the search_path pinned onto it, and a security
-- definer running with the caller's search_path is the caller's function.
alter function create_login(text, text, text, text, bigint)
  set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- What an order desk may read
--
-- Select only, and only what the four panels of Customer order draw: the
-- orders and their lines, the products and batches those lines name, what is
-- on the shelf so a basket cannot promise stock that is not there, the
-- accounts and their invoices, and the price codes a line is charged under.
--
-- Note what is not here. employment_details, which holds pay. expenses and
-- the day's takings, which are the owner's book. reseller_events and
-- reseller_credits — the account's own history, which lives on the half of
-- the screen an order desk does not have.
-- ---------------------------------------------------------------------------
drop policy if exists orderdesk_reads_orders on orders;
create policy orderdesk_reads_orders on orders for select
  using (current_role_name() = 'orderdesk');
drop policy if exists orderdesk_reads_products on products;
create policy orderdesk_reads_products on products for select
  using (current_role_name() = 'orderdesk');
drop policy if exists orderdesk_reads_batches on batches;
create policy orderdesk_reads_batches on batches for select
  using (current_role_name() = 'orderdesk');
drop policy if exists orderdesk_reads_stock on stock;
create policy orderdesk_reads_stock on stock for select
  using (current_role_name() = 'orderdesk');
drop policy if exists orderdesk_reads_resellers on resellers;
create policy orderdesk_reads_resellers on resellers for select
  using (current_role_name() = 'orderdesk');
drop policy if exists orderdesk_reads_invoices on invoices;
create policy orderdesk_reads_invoices on invoices for select
  using (current_role_name() = 'orderdesk');
drop policy if exists orderdesk_reads_receipts on reseller_receipts;
create policy orderdesk_reads_receipts on reseller_receipts for select
  using (current_role_name() = 'orderdesk');
drop policy if exists orderdesk_reads_product_prices on product_prices;
create policy orderdesk_reads_product_prices on product_prices for select
  using (current_role_name() = 'orderdesk');

-- The board every order screen reads. It filters by role inside the view
-- rather than by policy, so an order desk that can select from `orders` still
-- gets nothing until it is named here — and the balance, which is withheld
-- from everybody but the owner, has to come with it: confirming a transfer
-- against an invoice means knowing what is still owed on it.
create or replace view order_board as
select o.id, o.channel, o.status, o.total, o.placed_at, o.placed_by, o.delivered_at,
       o.reseller_id, r.name as reseller, r.tier,
       i.id as invoice_id, i.status as invoice_status, i.due_on,
       i.status = 'open' and i.due_on < current_date as invoice_overdue,
       case when current_role_name() in ('admin','orderdesk')
            then (i.amount - i.paid - i.discount) end as balance,
       r.tax_type, r.trade_name, r.taxpayer_name, r.tin, r.business_address,
       o.co_no, o.pl_no, i.si_no,
       o.shipping, o.others, o.subtotal,
       o.drop_ship
  from orders o
  left join resellers r on r.id = o.reseller_id
  left join invoices i on i.order_id = o.id
 where current_role_name() in ('admin','warehouse','orderdesk');

grant select on order_board to app_client;

-- ---------------------------------------------------------------------------
-- What an order desk may do
--
-- The functions Customer order calls, named here and nowhere else. Each one
-- already asks require_role('admin'); this widens that one call to accept an
-- order desk too, by rewriting the function from its own definition rather
-- than by pasting sixteen bodies into this file. A body pasted here would be
-- frozen at today's version, and the next person to fix a bug in place_order
-- would fix it in one of two places.
-- ---------------------------------------------------------------------------
do $rewrite$
declare
  fn   text;
  def  text;
  done int := 0;
  -- Placing and correcting an order; moving it along; the numbers on the
  -- paper; and the money that comes back against it.
  wanted text[] := array[
    'place_order', 'revise_order', 'revise_invoice',
    'set_order_no', 'set_invoice_no', 'set_line_notes', 'set_order_drop_ship',
    'start_picking', 'fulfil_order', 'mark_delivered', 'cancel_order',
    'confirm_reseller_payment', 'issue_reseller_receipt_now', 'receipt_pending',
    'record_invoice_payments', 'attach_document',
    -- Two of the above are wrappers, and a wrapper that may run is no use if
    -- what it calls refuses. pay_reseller_account applies the money to the
    -- open invoices; issue_reseller_receipt puts the number on it.
    'pay_reseller_account', 'issue_reseller_receipt'
  ];
begin
  for fn, def in
    select p.proname, pg_get_functiondef(p.oid)
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = any (wanted)
  loop
    -- Already widened, or it never asked for an owner in the first place.
    -- The lists are not all the same shape — some read ('admin'), some
    -- ('admin','warehouse'), some ('admin', 'office') — so the order desk is
    -- slipped in beside the owner rather than the whole list being rewritten.
    if def like '%''orderdesk''%' or def !~ 'require_role\(\s*''admin''' then
      continue;
    end if;
    execute regexp_replace(def, 'require_role\(\s*''admin''',
                           'require_role(''admin'', ''orderdesk''', 'g');
    done := done + 1;
  end loop;

  raise notice 'order desk: widened % function(s)', done;
end;
$rewrite$;

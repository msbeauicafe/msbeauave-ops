-- CO26_08_001, SI26_08_001, PL26_08_001.
--
-- Until now a reseller order was known by its database id — "Invoice #123" —
-- which is a number the system made up for itself and never meant to show
-- anybody. It cannot be read out over the phone without ambiguity, it says
-- nothing about when the order was placed, and the customer order, the invoice
-- and the packing list for one order all carried the same one, so "123" on a
-- chat message could mean any of three documents.
--
-- So each document gets its own, in the house shape the purchase orders
-- already use: prefix, two-digit year, month, and a count that restarts every
-- month. The separator is an underscore because that is how it was asked for.
--
-- Three prefixes, one per document, so a number says which piece of paper it
-- came from before anybody looks it up:
--
--     CO26_08_001   the customer order    — what they agreed to buy
--     SI26_08_001   the sales invoice     — what they owe for it
--     PL26_08_001   the packing list      — what the bench picks
alter table orders   add column if not exists co_no text;
alter table orders   add column if not exists pl_no text;
alter table invoices add column if not exists si_no text;

-- The backstop. The advisory locks below are what stop two people raising an
-- order in the same second from both reading 012 and both writing 013; these
-- are what make that a failure rather than a duplicate if it ever slips.
create unique index if not exists orders_co_no_once   on orders   (co_no) where co_no is not null;
create unique index if not exists orders_pl_no_once   on orders   (pl_no) where pl_no is not null;
create unique index if not exists invoices_si_no_once on invoices (si_no) where si_no is not null;

-- The month is Manila's, not the server's. An order placed at nine in the
-- evening on the 31st is that month's order to everybody who will ever look
-- for it, and the server thinking it is already the 1st does not change that.
create or replace function next_doc_no(p_prefix text, p_latest text)
returns text language sql immutable as $$
  select p_prefix || lpad((coalesce(substring(p_latest from '\d+$')::int, 0) + 1)::text, 3, '0');
$$;

create or replace function doc_prefix(p_kind text) returns text
language sql stable as $$
  select p_kind || to_char(now() at time zone 'Asia/Manila', 'YY_MM') || '_';
$$;

create or replace function next_co_no() returns text language plpgsql as $$
declare v_prefix text;
begin
  v_prefix := doc_prefix('CO');
  perform pg_advisory_xact_lock(hashtext(v_prefix));
  return next_doc_no(v_prefix,
    (select max(co_no) from orders where co_no like v_prefix || '%'));
end $$;

create or replace function next_pl_no() returns text language plpgsql as $$
declare v_prefix text;
begin
  v_prefix := doc_prefix('PL');
  perform pg_advisory_xact_lock(hashtext(v_prefix));
  return next_doc_no(v_prefix,
    (select max(pl_no) from orders where pl_no like v_prefix || '%'));
end $$;

create or replace function next_si_no() returns text language plpgsql as $$
declare v_prefix text;
begin
  v_prefix := doc_prefix('SI');
  perform pg_advisory_xact_lock(hashtext(v_prefix));
  return next_doc_no(v_prefix,
    (select max(si_no) from invoices where si_no like v_prefix || '%'));
end $$;

-- Stamped by a trigger rather than by the functions that place orders.
--
-- There are five of those, spread across five migrations, each a `create or
-- replace` of the last — and the next change to pricing will add a sixth. A
-- number added in the newest one would be missing from any path that still
-- reaches an older body, and missing quietly. The trigger sits under all of
-- them and cannot be gone round.
--
-- Only b2b. A counter sale is not a customer order and has no packing list;
-- it has a receipt, which is numbered by its own counter.
create or replace function stamp_order_numbers() returns trigger
language plpgsql as $$
begin
  if new.channel = 'b2b' then
    if new.co_no is null then new.co_no := next_co_no(); end if;
    if new.pl_no is null then new.pl_no := next_pl_no(); end if;
  end if;
  return new;
end $$;

drop trigger if exists orders_numbered on orders;
create trigger orders_numbered before insert on orders
  for each row execute function stamp_order_numbers();

create or replace function stamp_invoice_number() returns trigger
language plpgsql as $$
begin
  if new.si_no is null then new.si_no := next_si_no(); end if;
  return new;
end $$;

drop trigger if exists invoices_numbered on invoices;
create trigger invoices_numbered before insert on invoices
  for each row execute function stamp_invoice_number();

alter function next_doc_no(text, text) set search_path = public, extensions;
alter function doc_prefix(text)        set search_path = public, extensions;
alter function next_co_no()            set search_path = public, extensions;
alter function next_pl_no()            set search_path = public, extensions;
alter function next_si_no()            set search_path = public, extensions;
alter function stamp_order_numbers()   set search_path = public, extensions;
alter function stamp_invoice_number()  set search_path = public, extensions;

-- The board every order screen reads. The numbers have to reach it or they
-- exist only in the table and nobody can quote one.
create or replace view order_board as
select o.id, o.channel, o.status, o.total, o.placed_at, o.placed_by, o.delivered_at,
       o.reseller_id, r.name as reseller, r.tier,
       i.id as invoice_id, i.status as invoice_status, i.due_on,
       i.status = 'open' and i.due_on < current_date as invoice_overdue,
       case when current_role_name() = 'admin'
            then (i.amount - i.paid - i.discount) end as balance,
       r.tax_type, r.trade_name, r.taxpayer_name, r.tin, r.business_address,
       -- Appended rather than put beside the id they replace: a view's columns
       -- cannot be reordered by `create or replace`, only added to the end.
       o.co_no, o.pl_no, i.si_no
  from orders o
  left join resellers r on r.id = o.reseller_id
  left join invoices i on i.order_id = o.id
 where current_role_name() in ('admin','warehouse');

grant select on order_board to app_client;

-- ============================================================================
-- MS BEAU AVE — Billing: the supplier's own invoice, against the order it is for
--
-- A purchase order carries no prices, on purpose — what a case costs is
-- settled between the office and the supplier and lands on the order when
-- goods are received. But the supplier also sends a piece of paper of their
-- own: an invoice, with its own number, its own date, and a total that is
-- theirs to say, not the order's.
--
-- This is that piece of paper, kept: one row per invoice, tied to the order it
-- answers, so "what does JUJU still want from us" is a question this table can
-- answer without anybody digging through a folder. Marking one paid says the
-- invoice is settled — it touches nothing about the order or what has been
-- received against it, because those are different facts and can disagree
-- without either one being wrong.
--
-- Deliberately the simple half of billing: a number, a date, an amount, a due
-- date, paid or not. Not a posting, not a ledger of partial payments — if the
-- shop starts needing those, they are Books' to carry, the way advances and
-- loans grew their own ledger once a single balance stopped being enough.
-- ============================================================================

create table if not exists purchase_order_bills (
  id           bigint generated always as identity primary key,
  po_id        bigint not null references purchase_orders (id) on delete cascade,
  invoice_no   text,
  invoice_date date not null default (now() at time zone 'Asia/Manila')::date,
  amount       numeric(12,2) not null check (amount > 0),
  due_date     date,
  paid_on      date,
  note         text,
  created_at   timestamptz not null default now(),
  created_by   text not null default current_actor()
);
create index if not exists purchase_order_bills_by_po on purchase_order_bills (po_id);

alter table purchase_order_bills enable row level security;
drop policy if exists stock_reads_purchase_order_bills on purchase_order_bills;
create policy stock_reads_purchase_order_bills on purchase_order_bills for select
  using (current_role_name() in ('admin', 'warehouse', 'supervisor', 'office'));
grant select on purchase_order_bills to app_client;

-- One function for both a new bill and an edit of an existing one — the same
-- fields, keyed on an id that is null the first time. The same shape as
-- save_supplier, next to it in the same file this migration follows on from.
create or replace function save_po_bill(
  p_id bigint, p_po bigint, p_invoice_no text, p_invoice_date date,
  p_amount numeric, p_due_date date, p_note text
) returns bigint
language plpgsql security definer as $$
declare v_id bigint;
begin
  perform require_role('admin', 'warehouse', 'office');
  if not exists (select 1 from purchase_orders where id = p_po) then
    raise exception 'There is no purchase order with that number.';
  end if;
  if coalesce(p_amount, 0) <= 0 then
    raise exception 'How much is the invoice for?';
  end if;

  if p_id is null then
    insert into purchase_order_bills (po_id, invoice_no, invoice_date, amount, due_date, note)
    values (p_po, nullif(btrim(coalesce(p_invoice_no, '')), ''),
            coalesce(p_invoice_date, (now() at time zone 'Asia/Manila')::date),
            p_amount, p_due_date, nullif(btrim(coalesce(p_note, '')), ''))
    returning id into v_id;
  else
    update purchase_order_bills
       set po_id        = p_po,
           invoice_no   = nullif(btrim(coalesce(p_invoice_no, '')), ''),
           invoice_date = coalesce(p_invoice_date, invoice_date),
           amount       = p_amount,
           due_date     = p_due_date,
           note         = nullif(btrim(coalesce(p_note, '')), '')
     where id = p_id
    returning id into v_id;
    if v_id is null then raise exception 'There is no bill with that number.'; end if;
  end if;
  return v_id;
end;
$$;
alter function save_po_bill(bigint, bigint, text, date, numeric, date, text)
  set search_path = public, extensions;
grant execute on function save_po_bill(bigint, bigint, text, date, numeric, date, text)
  to app_client;

create or replace function set_po_bill_paid(p_id bigint, p_paid boolean) returns void
language plpgsql security definer as $$
begin
  perform require_role('admin', 'warehouse', 'office');
  update purchase_order_bills
     set paid_on = case when p_paid then (now() at time zone 'Asia/Manila')::date else null end
   where id = p_id;
  if not found then raise exception 'There is no bill with that number.'; end if;
end;
$$;
alter function set_po_bill_paid(bigint, boolean) set search_path = public, extensions;
grant execute on function set_po_bill_paid(bigint, boolean) to app_client;

create or replace function remove_po_bill(p_id bigint) returns void
language plpgsql security definer as $$
begin
  perform require_role('admin', 'warehouse', 'office');
  delete from purchase_order_bills where id = p_id;
  if not found then raise exception 'There is no bill with that number.'; end if;
end;
$$;
alter function remove_po_bill(bigint) set search_path = public, extensions;
grant execute on function remove_po_bill(bigint) to app_client;

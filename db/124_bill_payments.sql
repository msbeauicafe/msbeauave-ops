-- ============================================================================
-- MS BEAU AVE — Billing grows a ledger: part-payments, and what is still owed
--
-- A bill was paid or it wasn't — one date, one flag. That held until a bill
-- for eight thousand got four thousand off it this week and the rest next
-- week, the same shape advances and loans outgrew once a single balance
-- stopped being enough for them. Same fix: a payment is its own row, not an
-- overwrite of the last one, and the balance is derived from all of them
-- rather than kept as a number that could drift from what was actually paid.
--
-- set_po_bill_paid is gone. A bill is paid by paying it — recording a
-- payment that reaches the balance is what "paid" now means, the same way
-- take_off_advance is how an advance reaches zero. Nothing else asks
-- whether a bill is paid; everything reads it off the ledger.
-- ============================================================================

create table if not exists purchase_order_bill_payments (
  id         bigint generated always as identity primary key,
  bill_id    bigint not null references purchase_order_bills (id) on delete cascade,
  amount     numeric(12,2) not null check (amount > 0),
  paid_on    date not null default (now() at time zone 'Asia/Manila')::date,
  note       text,
  created_at timestamptz not null default now(),
  created_by text not null default current_actor()
);
create index if not exists purchase_order_bill_payments_by_bill
  on purchase_order_bill_payments (bill_id);

alter table purchase_order_bill_payments enable row level security;
drop policy if exists stock_reads_purchase_order_bill_payments on purchase_order_bill_payments;
create policy stock_reads_purchase_order_bill_payments on purchase_order_bill_payments for select
  using (current_role_name() in ('admin', 'warehouse', 'supervisor', 'office'));
grant select on purchase_order_bill_payments to app_client;

-- Superseded by the ledger: paid is now derived from what has actually come
-- off, not a flag somebody remembered to flip. Both go before the view below
-- is created — it reads the table with select b.*, and a column dropped out
-- from under an already-built view is a dependency error, not a quiet no-op.
drop function if exists set_po_bill_paid(bigint, boolean);
alter table purchase_order_bills drop column if exists paid_on;

-- What has come off each bill, and what is left — the two figures the State
-- column and "Still owed" are worked out from. Paid, unpaid, or paid w/ bal
-- — the same three states the order list already shows — is worked out from
-- paid and balance alone, nothing about the due date.
-- security_invoker: a view runs as its owner by default, which for every
-- migration in this file is the superuser that applies them — RLS on
-- purchase_order_bills would otherwise never see anyone but a role that
-- bypasses it. The same reason every other _balances view in this file's
-- family needs it, whether or not it has been added yet.
create or replace view purchase_order_bill_balances
  with (security_invoker = true) as
select b.*, o.po_no, s.name as supplier, s.brand_name,
       coalesce((select sum(p.amount) from purchase_order_bill_payments p
                  where p.bill_id = b.id), 0)::numeric(12,2) as paid,
       (b.amount - coalesce((select sum(p.amount) from purchase_order_bill_payments p
                              where p.bill_id = b.id), 0))::numeric(12,2) as balance,
       (select max(p.paid_on) from purchase_order_bill_payments p
         where p.bill_id = b.id) as last_paid_on
  from purchase_order_bills b
  join purchase_orders o on o.id = b.po_id
  join suppliers s on s.id = o.supplier_id;

grant select on purchase_order_bill_balances to app_client;

create or replace function record_bill_payment(
  p_bill bigint, p_amount numeric, p_paid_on date, p_note text
) returns numeric
language plpgsql security definer as $$
declare v_balance numeric;
begin
  perform require_role('admin', 'warehouse', 'office');
  if coalesce(p_amount, 0) <= 0 then
    raise exception 'How much is coming off?';
  end if;
  select balance into v_balance from purchase_order_bill_balances where id = p_bill;
  if not found then raise exception 'There is no bill with that number.'; end if;
  if p_amount > v_balance then
    raise exception 'Only % is still owed.', to_char(v_balance, 'FM999,999.00');
  end if;

  insert into purchase_order_bill_payments (bill_id, amount, paid_on, note)
  values (p_bill, p_amount, coalesce(p_paid_on, (now() at time zone 'Asia/Manila')::date),
          nullif(btrim(coalesce(p_note, '')), ''));

  return v_balance - p_amount;
end;
$$;
alter function record_bill_payment(bigint, numeric, date, text)
  set search_path = public, extensions;
grant execute on function record_bill_payment(bigint, numeric, date, text) to app_client;

create or replace function undo_bill_payment(p_id bigint) returns void
language plpgsql security definer as $$
begin
  perform require_role('admin', 'warehouse', 'office');
  delete from purchase_order_bill_payments where id = p_id;
  if not found then raise exception 'There is no such payment.'; end if;
end;
$$;
alter function undo_bill_payment(bigint) set search_path = public, extensions;
grant execute on function undo_bill_payment(bigint) to app_client;

-- Removing a bill with payments against it would cascade them away silently.
-- Undo the payments first — the same rule advances already hold to.
create or replace function remove_po_bill(p_id bigint) returns void
language plpgsql security definer as $$
begin
  perform require_role('admin', 'warehouse', 'office');
  if exists (select 1 from purchase_order_bill_payments where bill_id = p_id) then
    raise exception 'REMOVE_BLOCKED: this bill has payments against it. Undo those first.';
  end if;
  delete from purchase_order_bills where id = p_id;
  if not found then raise exception 'There is no bill with that number.'; end if;
end;
$$;
alter function remove_po_bill(bigint) set search_path = public, extensions;
grant execute on function remove_po_bill(bigint) to app_client;

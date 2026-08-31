-- ============================================================================
-- MS BEAU AVE — Books (Phase 2: payables & expenses)
--
-- Phase 1 gave the books their spine: a chart of accounts, balanced journal
-- postings, the trial balance and statements that fall out of them. This is the
-- first thing a business actually keeps books FOR — what it owes and what it
-- spends.
--
-- Three everyday acts, each one a proper double-entry posting so the trial
-- balance never has to be told about them twice:
--
--   * A BILL from a supplier — goods or a service taken on account. Debit
--     whatever it was for (inventory, delivery, rent); credit Accounts Payable.
--     Now the company owes money and the balance sheet says so.
--   * A PAYMENT against a bill — in part or in full. Debit Accounts Payable;
--     credit the cash it came out of. The debt shrinks; the cash shrinks with
--     it.
--   * An EXPENSE paid on the spot — no debt in between. Debit the expense;
--     credit the cash. The everyday small stuff: fare, load, a repair.
--
-- Every one of these is built on post_journal from Phase 1, so it balances to
-- the centavo or it does not post at all — and the moment it posts it is in the
-- trial balance and on the income statement and balance sheet, with nothing
-- else to do. Still the owner's alone, like the rest of the books.
-- ============================================================================

-- Where a posting came from, so the journal can say "bill" or "payment" and the
-- Expenses screen can find its own. Null means somebody typed it in by hand.
alter table journal_entries add column if not exists source text;

-- The suppliers, as the books know them. Kept here rather than borrowed from the
-- warehouse's supplier list on purpose: the books are hand-kept and self-
-- contained, and a name the owner writes on a bill need not be a company that
-- raises purchase orders.
create table if not exists book_vendors (
  id          bigint generated always as identity primary key,
  name        text not null unique,
  notes       text,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- A bill: what a supplier is owed, and the posting that recorded it. The amount
-- is the total of its expense lines; the credit to Accounts Payable equals it.
create table if not exists book_bills (
  id          bigint generated always as identity primary key,
  bill_no     text unique,
  vendor_id   bigint not null references book_vendors(id),
  reference   text,                       -- the supplier's own DR / invoice number
  bill_date   date not null,
  due_date    date,
  memo        text,
  amount      numeric(14,2) not null check (amount > 0),
  entry_id    bigint references journal_entries(id),
  created_at  timestamptz not null default now()
);
create sequence if not exists book_bill_seq start 1;
create index if not exists book_bills_vendor on book_bills(vendor_id);

-- A payment against a bill. A bill can be paid in several goes; each one is its
-- own posting out of a chosen cash account.
create table if not exists book_bill_payments (
  id          bigint generated always as identity primary key,
  bill_id     bigint not null references book_bills(id) on delete cascade,
  pay_date    date not null,
  amount      numeric(14,2) not null check (amount > 0),
  paid_from   text not null references coa_accounts(code),
  memo        text,
  entry_id    bigint references journal_entries(id),
  created_at  timestamptz not null default now()
);
create index if not exists book_bill_payments_bill on book_bill_payments(bill_id);

-- A bill with what has been paid on it and what is left. 'open' is untouched,
-- 'part' is partly paid, 'paid' is settled.
create or replace view bill_status as
select b.id, b.bill_no, b.vendor_id, v.name as vendor, b.reference,
       b.bill_date, b.due_date, b.memo, b.amount, b.entry_id, b.created_at,
       coalesce(sum(p.amount), 0)              as paid,
       b.amount - coalesce(sum(p.amount), 0)   as balance,
       case when coalesce(sum(p.amount), 0) >= b.amount then 'paid'
            when coalesce(sum(p.amount), 0) >  0        then 'part'
            else 'open' end                    as status
  from book_bills b
  join book_vendors v on v.id = b.vendor_id
  left join book_bill_payments p on p.bill_id = b.id
 group by b.id, v.name;

-- ---------------------------------------------------------------------------
-- Adding or editing a supplier.
-- ---------------------------------------------------------------------------
create or replace function save_vendor(p_id bigint, p_name text, p_notes text)
returns bigint
language plpgsql security definer as $$
declare v_id bigint; v_name text;
begin
  perform require_role('admin');
  v_name := btrim(coalesce(p_name, ''));
  if length(v_name) = 0 then raise exception 'A supplier needs a name.'; end if;

  if p_id is null then
    insert into book_vendors (name, notes) values (v_name, nullif(btrim(coalesce(p_notes,'')),''))
    returning id into v_id;
  else
    update book_vendors set name = v_name, notes = nullif(btrim(coalesce(p_notes,'')),'')
     where id = p_id returning id into v_id;
    if not found then raise exception 'There is no such supplier.'; end if;
  end if;
  return v_id;
end;
$$;
alter function save_vendor(bigint, text, text) set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- Recording a bill. The lines are what the money was for — [{account, amount,
-- memo}] — and their total is credited to Accounts Payable in one posting. The
-- posting is built and checked by post_journal, so a bill that would not
-- balance never lands, and the moment it does it is on the books.
-- ---------------------------------------------------------------------------
create or replace function record_bill(
  p_vendor bigint, p_date date, p_due date, p_ref text, p_memo text, p_lines jsonb
) returns bigint
language plpgsql security definer as $$
declare
  v_vendor text; v_total numeric(14,2); v_n int;
  v_lines jsonb; v_memo text; v_entry bigint; v_bill bigint;
begin
  perform require_role('admin');

  select name into v_vendor from book_vendors where id = p_vendor;
  if not found then raise exception 'Pick a supplier for the bill first.'; end if;
  if not exists (select 1 from coa_accounts where code = '201') then
    raise exception 'The chart has no Accounts Payable (201) to owe against.';
  end if;

  select coalesce(sum((l->>'amount')::numeric), 0), count(*)
    into v_total, v_n
    from jsonb_array_elements(p_lines) l
   where coalesce((l->>'amount')::numeric, 0) > 0 and coalesce(l->>'account','') <> '';
  if v_n < 1 then raise exception 'A bill needs at least one line.'; end if;
  if v_total <= 0 then raise exception 'A bill cannot be for nothing.'; end if;

  -- The debit lines, then a single credit to Accounts Payable for the total.
  select jsonb_agg(jsonb_build_object(
           'account', l->>'account', 'debit', (l->>'amount')::numeric, 'credit', 0,
           'memo', nullif(btrim(coalesce(l->>'memo','')),'')))
    into v_lines
    from jsonb_array_elements(p_lines) l
   where coalesce((l->>'amount')::numeric, 0) > 0 and coalesce(l->>'account','') <> '';
  v_lines := v_lines || jsonb_build_array(jsonb_build_object(
    'account', '201', 'debit', 0, 'credit', v_total, 'memo', 'Payable — ' || v_vendor));

  v_memo := coalesce(nullif(btrim(coalesce(p_memo,'')),''), 'Bill from ' || v_vendor);
  v_entry := post_journal(p_date, v_memo, v_lines);
  update journal_entries set source = 'bill' where id = v_entry;

  insert into book_bills (bill_no, vendor_id, reference, bill_date, due_date, memo, amount, entry_id)
  values ('BILL-' || lpad(nextval('book_bill_seq')::text, 5, '0'),
          p_vendor, nullif(btrim(coalesce(p_ref,'')),''), p_date, p_due,
          nullif(btrim(coalesce(p_memo,'')),''), v_total, v_entry)
  returning id into v_bill;
  return v_bill;
end;
$$;
alter function record_bill(bigint, date, date, text, text, jsonb) set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- Paying a bill, in part or in full, out of a chosen cash account. Cannot pay
-- more than is still owed. Debit Accounts Payable, credit the cash.
-- ---------------------------------------------------------------------------
create or replace function pay_bill(
  p_bill bigint, p_date date, p_from text, p_amount numeric, p_memo text
) returns bigint
language plpgsql security definer as $$
declare
  v_bal numeric(14,2); v_vendor text; v_no text;
  v_lines jsonb; v_entry bigint; v_pay bigint;
begin
  perform require_role('admin');

  select balance, vendor, bill_no into v_bal, v_vendor, v_no from bill_status where id = p_bill;
  if not found then raise exception 'There is no such bill.'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'A payment has to be more than nothing.'; end if;
  -- A hair of rounding room, otherwise the exact balance is refused as "too much".
  if p_amount > v_bal + 0.005 then
    raise exception 'That is more than the % still owed on this bill.', to_char(v_bal, 'FM999,999,990.00');
  end if;
  if not exists (select 1 from coa_accounts where code = p_from) then
    raise exception 'Pick the cash account the payment came out of.';
  end if;

  v_lines := jsonb_build_array(
    jsonb_build_object('account', '201',   'debit', p_amount, 'credit', 0, 'memo', 'Paid ' || v_no),
    jsonb_build_object('account', p_from,  'debit', 0, 'credit', p_amount, 'memo', 'Paid ' || v_vendor));
  v_entry := post_journal(p_date, 'Payment — ' || v_vendor || ' (' || v_no || ')', v_lines);
  update journal_entries set source = 'payment' where id = v_entry;

  insert into book_bill_payments (bill_id, pay_date, amount, paid_from, memo, entry_id)
  values (p_bill, p_date, p_amount, p_from, nullif(btrim(coalesce(p_memo,'')),''), v_entry)
  returning id into v_pay;
  return v_pay;
end;
$$;
alter function pay_bill(bigint, date, text, numeric, text) set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- An expense paid on the spot — no bill, no debt. The lines are what was spent
-- on; the total is credited to the cash it came from, all in one posting.
-- ---------------------------------------------------------------------------
create or replace function record_expense(
  p_date date, p_from text, p_memo text, p_lines jsonb
) returns bigint
language plpgsql security definer as $$
declare v_total numeric(14,2); v_n int; v_lines jsonb; v_memo text; v_entry bigint;
begin
  perform require_role('admin');

  if not exists (select 1 from coa_accounts where code = p_from) then
    raise exception 'Pick the cash account the money came out of.';
  end if;

  select coalesce(sum((l->>'amount')::numeric), 0), count(*)
    into v_total, v_n
    from jsonb_array_elements(p_lines) l
   where coalesce((l->>'amount')::numeric, 0) > 0 and coalesce(l->>'account','') <> '';
  if v_n < 1 then raise exception 'An expense needs at least one line.'; end if;
  if v_total <= 0 then raise exception 'An expense cannot be for nothing.'; end if;

  select jsonb_agg(jsonb_build_object(
           'account', l->>'account', 'debit', (l->>'amount')::numeric, 'credit', 0,
           'memo', nullif(btrim(coalesce(l->>'memo','')),'')))
    into v_lines
    from jsonb_array_elements(p_lines) l
   where coalesce((l->>'amount')::numeric, 0) > 0 and coalesce(l->>'account','') <> '';
  v_lines := v_lines || jsonb_build_array(jsonb_build_object(
    'account', p_from, 'debit', 0, 'credit', v_total, 'memo', 'Paid in cash'));

  v_memo := coalesce(nullif(btrim(coalesce(p_memo,'')),''), 'Expense');
  v_entry := post_journal(p_date, v_memo, v_lines);
  update journal_entries set source = 'expense' where id = v_entry;
  return v_entry;
end;
$$;
alter function record_expense(date, text, text, jsonb) set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- The owner's alone, like the rest of the books.
-- ---------------------------------------------------------------------------
alter table book_vendors       enable row level security;
alter table book_bills         enable row level security;
alter table book_bill_payments enable row level security;
drop policy if exists admin_book_vendors on book_vendors;
create policy admin_book_vendors on book_vendors for all
  using (current_role_name() = 'admin') with check (current_role_name() = 'admin');
drop policy if exists admin_book_bills on book_bills;
create policy admin_book_bills on book_bills for all
  using (current_role_name() = 'admin') with check (current_role_name() = 'admin');
drop policy if exists admin_book_bill_payments on book_bill_payments;
create policy admin_book_bill_payments on book_bill_payments for all
  using (current_role_name() = 'admin') with check (current_role_name() = 'admin');

grant select, insert, update, delete on book_vendors, book_bills, book_bill_payments to app_client;
grant select on bill_status to app_client;
grant usage on sequence book_bill_seq to app_client;

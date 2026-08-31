-- ============================================================================
-- MS BEAU AVE — Books (Phase 3: cash & disbursements)
--
-- Phase 2 could record a bill and pay it, and spend on the spot. What it could
-- not do was answer the first question an owner asks in the morning: how much
-- cash do we have, and where. This phase names the cash accounts, keeps a
-- running position across them, lets money move between them, and turns every
-- payment and expense into a numbered DISBURSEMENT VOUCHER — the slip an
-- accounting system hands you for money going out, with who it was paid to, how
-- (cash or cheque), and the cheque number if there was one.
--
-- Nothing here invents a second way to move money. A transfer, a bill payment,
-- an expense — each is still one balanced posting through post_journal, so the
-- trial balance never has to be told twice. What is new is that the money-out
-- ones now carry a voucher number and a method, and gather into one register
-- you can read and print from.
-- ============================================================================

-- Which accounts are cash. The pickers narrow to these, and the cash position
-- is their balances. Seeded with the obvious three; the owner can mark more.
alter table coa_accounts add column if not exists is_cash boolean not null default false;
update coa_accounts set is_cash = true where code in ('102', '103', '115');

create or replace function set_cash_account(p_code text, p_on boolean) returns void
language plpgsql security definer as $$
begin
  perform require_role('admin');
  update coa_accounts set is_cash = coalesce(p_on, false) where code = p_code;
  if not found then raise exception 'There is no such account.'; end if;
end;
$$;
alter function set_cash_account(text, boolean) set search_path = public, extensions;

-- Voucher numbers for money going out — DV-00001 and up, shared by payments and
-- expenses so the register reads in one run.
create sequence if not exists book_voucher_seq start 1;

-- A payment carries how it was paid and its voucher now.
alter table book_bill_payments add column if not exists method text not null default 'cash';
alter table book_bill_payments add column if not exists reference text;
alter table book_bill_payments add column if not exists voucher_no text;

-- Expenses get a home of their own, so they carry a voucher and a method like a
-- payment does and show up in the same register. The Expenses screen still
-- reads them off the journal by source, so nothing there changes.
create table if not exists book_expenses (
  id          bigint generated always as identity primary key,
  entry_id    bigint references journal_entries(id),
  exp_date    date not null,
  paid_from   text not null references coa_accounts(code),
  amount      numeric(14,2) not null check (amount > 0),
  method      text not null default 'cash',
  reference   text,
  voucher_no  text,
  memo        text,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Moving cash between two cash accounts — bank to the drawer, drawer to bank.
-- Both ends must be cash accounts, and they must differ. Debit where it lands,
-- credit where it left.
-- ---------------------------------------------------------------------------
create or replace function transfer_cash(
  p_from text, p_to text, p_date date, p_amount numeric, p_memo text
) returns bigint
language plpgsql security definer as $$
declare v_from text; v_to text; v_lines jsonb; v_memo text; v_entry bigint;
begin
  perform require_role('admin');
  if p_from = p_to then raise exception 'A transfer moves cash between two different accounts.'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'A transfer has to be more than nothing.'; end if;
  select title into v_from from coa_accounts where code = p_from and is_cash;
  if not found then raise exception 'The account it comes from has to be a cash account.'; end if;
  select title into v_to from coa_accounts where code = p_to and is_cash;
  if not found then raise exception 'The account it goes to has to be a cash account.'; end if;

  v_lines := jsonb_build_array(
    jsonb_build_object('account', p_to,   'debit', p_amount, 'credit', 0, 'memo', 'From ' || v_from),
    jsonb_build_object('account', p_from, 'debit', 0, 'credit', p_amount, 'memo', 'To ' || v_to));
  v_memo := coalesce(nullif(btrim(coalesce(p_memo,'')),''), 'Transfer — ' || v_from || ' to ' || v_to);
  v_entry := post_journal(p_date, v_memo, v_lines);
  update journal_entries set source = 'transfer' where id = v_entry;
  return v_entry;
end;
$$;
alter function transfer_cash(text, text, date, numeric, text) set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- Paying a bill — now recreated to carry a method (cash/cheque/bank/online) and
-- a reference (a cheque number, say), and to mint a voucher. The extra two
-- arguments default, so a five-argument call from before still works.
-- ---------------------------------------------------------------------------
drop function if exists pay_bill(bigint, date, text, numeric, text);
create or replace function pay_bill(
  p_bill bigint, p_date date, p_from text, p_amount numeric, p_memo text,
  p_method text default 'cash', p_reference text default null
) returns bigint
language plpgsql security definer as $$
declare
  v_bal numeric(14,2); v_vendor text; v_no text; v_voucher text;
  v_lines jsonb; v_entry bigint; v_pay bigint;
begin
  perform require_role('admin');
  select balance, vendor, bill_no into v_bal, v_vendor, v_no from bill_status where id = p_bill;
  if not found then raise exception 'There is no such bill.'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'A payment has to be more than nothing.'; end if;
  if p_amount > v_bal + 0.005 then
    raise exception 'That is more than the % still owed on this bill.', to_char(v_bal, 'FM999,999,990.00');
  end if;
  if not exists (select 1 from coa_accounts where code = p_from) then
    raise exception 'Pick the cash account the payment came out of.';
  end if;

  v_lines := jsonb_build_array(
    jsonb_build_object('account', '201',  'debit', p_amount, 'credit', 0, 'memo', 'Paid ' || v_no),
    jsonb_build_object('account', p_from, 'debit', 0, 'credit', p_amount, 'memo', 'Paid ' || v_vendor));
  v_entry := post_journal(p_date, 'Payment — ' || v_vendor || ' (' || v_no || ')', v_lines);
  update journal_entries set source = 'payment' where id = v_entry;
  v_voucher := 'DV-' || lpad(nextval('book_voucher_seq')::text, 5, '0');

  insert into book_bill_payments (bill_id, pay_date, amount, paid_from, memo, entry_id, method, reference, voucher_no)
  values (p_bill, p_date, p_amount, p_from, nullif(btrim(coalesce(p_memo,'')),''), v_entry,
          coalesce(nullif(btrim(coalesce(p_method,'')),''),'cash'), nullif(btrim(coalesce(p_reference,'')),''), v_voucher)
  returning id into v_pay;
  return v_pay;
end;
$$;
alter function pay_bill(bigint, date, text, numeric, text, text, text) set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- An expense — recreated the same way, and now with a home in book_expenses so
-- it carries a voucher and a method. The method and reference are REQUIRED here
-- (not defaulted like pay_bill's) on purpose: the main app already has its own
-- petty-cash record_expense(text,text,numeric,date,text), and a defaulted
-- five-argument form of this one would make an untyped five-argument call
-- ambiguous between the two. Six arguments keeps them apart. The books routes
-- always pass all six.
-- ---------------------------------------------------------------------------
drop function if exists record_expense(date, text, text, jsonb);
create or replace function record_expense(
  p_date date, p_from text, p_memo text, p_lines jsonb, p_method text, p_reference text
) returns bigint
language plpgsql security definer as $$
declare v_total numeric(14,2); v_n int; v_lines jsonb; v_memo text; v_entry bigint; v_voucher text;
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
  v_voucher := 'DV-' || lpad(nextval('book_voucher_seq')::text, 5, '0');

  insert into book_expenses (entry_id, exp_date, paid_from, amount, method, reference, voucher_no, memo)
  values (v_entry, p_date, p_from, v_total,
          coalesce(nullif(btrim(coalesce(p_method,'')),''),'cash'), nullif(btrim(coalesce(p_reference,'')),''),
          v_voucher, nullif(btrim(coalesce(p_memo,'')),''));
  return v_entry;
end;
$$;
alter function record_expense(date, text, text, jsonb, text, text) set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- The disbursements register: every voucher, whether it paid a bill or was an
-- expense on the spot, in one run newest first.
-- ---------------------------------------------------------------------------
create or replace view cash_disbursements as
select p.voucher_no, 'Bill payment'::text as kind, p.pay_date as paid_on,
       v.name as payee, p.method, p.reference, p.amount,
       p.paid_from, a.title as paid_from_title, p.memo, p.entry_id, b.bill_no
  from book_bill_payments p
  join book_bills b on b.id = p.bill_id
  join book_vendors v on v.id = b.vendor_id
  join coa_accounts a on a.code = p.paid_from
union all
select e.voucher_no, 'Expense'::text as kind, e.exp_date as paid_on,
       coalesce(e.memo, 'Expense') as payee, e.method, e.reference, e.amount,
       e.paid_from, a.title as paid_from_title, e.memo, e.entry_id, null::text as bill_no
  from book_expenses e
  join coa_accounts a on a.code = e.paid_from;

-- The owner's alone.
alter table book_expenses enable row level security;
drop policy if exists admin_book_expenses on book_expenses;
create policy admin_book_expenses on book_expenses for all
  using (current_role_name() = 'admin') with check (current_role_name() = 'admin');
grant select, insert, update, delete on book_expenses to app_client;
grant select on cash_disbursements to app_client;
grant usage on sequence book_voucher_seq to app_client;

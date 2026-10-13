-- MS BEAU AVE — one list of banks: Payment Management's
--
-- A bank went by two names: BDO on Payment Management's Account list (db/187)
-- and the Cash position box, BANCO DE ORO (BDO) on every Mode of payment
-- (MOP_OPTIONS in app.js, and purchase order bill payments' own check,
-- db/126). Renaming it in Payment Management changed only the first. Now the
-- Account list is the one list: Mode of payment — on Customer order's Record
-- payment, Purchase order's billing statement Record payment, and Confirm the
-- bank payment — offers its banks by the same names, plus CASH and FUNDS,
-- which are not banks. A rename there carries to both Mode of payment lists,
-- to the payments already recorded under the old name, and to the Books
-- account behind the Cash position box, so the name is the same everywhere.
--
-- Each account keeps:
--   is_bank      offered as a Mode of payment (Bank and Cash on hand are not)
--   cash_column  which side of Cash position its box sits: bank, cash, rest
--   coa_code     the Books account that carries its money
--   aliases      the old Mode of payment wording, still read as this bank —
--                a payment typed before this change routes the same.
--   place        its order on every list

alter table bank_txn_accounts add column if not exists is_bank boolean not null default true;
alter table bank_txn_accounts add column if not exists cash_column text not null default 'bank';
alter table bank_txn_accounts drop constraint if exists bank_txn_accounts_cash_column_check;
alter table bank_txn_accounts add constraint bank_txn_accounts_cash_column_check
  check (cash_column in ('bank', 'cash', 'rest'));
alter table bank_txn_accounts add column if not exists coa_code text references coa_accounts (code);
alter table bank_txn_accounts add column if not exists aliases text[] not null default '{}';
-- Where it sits in Mode of payment and Cash position: the six in the order
-- the shop has always seen them, any bank added after them in turn.
alter table bank_txn_accounts add column if not exists place int;

-- The six the list started with, found by name — or, for BDO, by "de oro" if
-- it has already been renamed here — and told what they are.
do $$
declare s record; v_id bigint;
begin
  for s in select * from (values
      ('BDO',           'BANCO DE ORO (BDO)', 'bank', 'BDO',           true,  1),
      ('BPI',           'BPI',                'bank', 'BPI',           true,  2),
      ('Security Bank', 'SECURITY BANK',      'bank', 'Security Bank', true,  3),
      ('GCash',         'GCASH',              'cash', 'GCash',         true,  4),
      ('Bank',          null,                 'rest', 'Bank',          false, 5),
      ('Cash on hand',  'CASH',               'cash', 'Cash On Hand',  false, 6)
    ) v(name, alias, col, coa_title, is_bank, place)
  loop
    v_id := null;
    select id into v_id from bank_txn_accounts where lower(name) = lower(s.name);
    if v_id is null and s.name = 'BDO' then
      select id into v_id from bank_txn_accounts
       where name ilike '%de oro%' or name ilike '%(bdo)%' order by id limit 1;
    end if;
    if v_id is null then
      insert into bank_txn_accounts (name) values (s.name) returning id into v_id;
    end if;
    update bank_txn_accounts a
       set is_bank = s.is_bank, cash_column = s.col, place = s.place,
           aliases = case when s.alias is null then '{}'::text[] else array[s.alias] end,
           coa_code = coalesce(a.coa_code,
             (select c.code from coa_accounts c where lower(btrim(c.title)) = lower(a.name)),
             (select c.code from coa_accounts c where lower(btrim(c.title)) = lower(s.coa_title)))
     where a.id = v_id;
  end loop;
end;
$$;

-- Any bank added since (db/187) is a bank like the rest: offered as a Mode
-- of payment, boxed under BANK, with a Books cash account of its own.
insert into coa_accounts (code, title, type, normal_side, is_cash)
select 'G' || nextval('coa_code_seq'), a.name, 'Asset', 'debit', true
  from bank_txn_accounts a
 where a.coa_code is null
   and not exists (select 1 from coa_accounts c where lower(btrim(c.title)) = lower(a.name));
update bank_txn_accounts a
   set coa_code = (select c.code from coa_accounts c where lower(btrim(c.title)) = lower(a.name))
 where a.coa_code is null;

-- The Books account takes the list's name, so the Cash position box reads
-- what Payment Management says (a box already named the same, in any case,
-- is left as it is).
update coa_accounts c set title = a.name
  from bank_txn_accounts a
 where a.coa_code = c.code and lower(btrim(c.title)) <> lower(a.name)
   and not exists (select 1 from coa_accounts x where x.title = a.name);

-- A bank named the old way, on a payment already recorded, now reads the
-- list's name. CASH and FUNDS are not banks and are left as they are.
update payments p set method = a.name
  from bank_txn_accounts a
 where a.is_bank and upper(btrim(p.method)) = any(a.aliases) and p.method <> a.name;

alter table purchase_order_bill_payments
  drop constraint if exists purchase_order_bill_payments_method_check;
update purchase_order_bill_payments p set method = a.name
  from bank_txn_accounts a
 where a.is_bank and upper(btrim(p.method)) = any(a.aliases) and p.method <> a.name;

-- What a typed Mode of payment means: the bank on the list it names — by its
-- name or its old wording — or, for anything else, just what was typed.
create or replace function mop_canonical(p text) returns text
language plpgsql stable security definer as $$
declare v text := btrim(coalesce(p, '')); v_name text;
begin
  if v = '' then return null; end if;
  select a.name into v_name from bank_txn_accounts a
   where a.is_bank and (lower(a.name) = lower(v) or upper(v) = any(a.aliases))
   order by a.id limit 1;
  return coalesce(v_name, v);
end;
$$;

-- Which Books account a payment by this Mode of payment lands in: cash on
-- hand for cash, the named bank's own account, or the generic Bank (102).
create or replace function mop_account_code(p text) returns text
language plpgsql stable security definer as $$
declare v text := btrim(coalesce(p, 'cash')); v_code text;
begin
  if lower(v) = 'cash' then return '103'; end if;
  select a.coa_code into v_code from bank_txn_accounts a
   where a.coa_code is not null and (lower(a.name) = lower(v) or upper(v) = any(a.aliases))
   order by a.id limit 1;
  return coalesce(v_code, '102');
end;
$$;

-- Whatever screen writes a payment, a bank is stored by the list's name.
create or replace function payment_method_canonical() returns trigger
language plpgsql as $$
begin
  new.method := mop_canonical(new.method);
  return new;
end;
$$;
drop trigger if exists payments_method_canonical on payments;
create trigger payments_method_canonical before insert or update of method on payments
  for each row when (new.method is not null) execute function payment_method_canonical();
drop trigger if exists bill_payments_method_canonical on purchase_order_bill_payments;
create trigger bill_payments_method_canonical before insert or update of method on purchase_order_bill_payments
  for each row when (new.method is not null) execute function payment_method_canonical();

-- Mode of payment, as every Record payment offers it: the banks on the
-- list, in the order they were added, then CASH and FUNDS.
create or replace function payment_modes() returns jsonb
language plpgsql stable security definer as $$
begin
  perform require_role('admin', 'orderdesk', 'warehouse', 'supervisor', 'office', 'datacoord');
  return coalesce((select jsonb_agg(a.name order by a.place nulls last, a.id)
                      from bank_txn_accounts a where a.is_bank),
                  '[]'::jsonb) || '["CASH", "FUNDS"]'::jsonb;
end;
$$;

-- Cash position's boxes, off the same list: each account, its side, its
-- Books account and the old wording it still answers to.
create or replace function bank_acct_boxes() returns jsonb
language plpgsql stable security definer as $$
begin
  perform require_role('admin');
  return coalesce((select jsonb_agg(jsonb_build_object(
            'name', a.name, 'column', a.cash_column, 'is_bank', a.is_bank,
            'coa_code', a.coa_code, 'aliases', to_jsonb(a.aliases)) order by a.place nulls last, a.id)
           from bank_txn_accounts a), '[]'::jsonb);
end;
$$;

-- Adding a bank: on the list, offered as a Mode of payment, and given a
-- Books cash account of its own so its box has something to read.
create or replace function bank_acct_add(p_name text) returns text
language plpgsql security definer as $$
declare v_name text := btrim(coalesce(p_name, '')); v_code text;
begin
  perform require_role('admin');
  if v_name = '' then raise exception 'Type the bank''s name.'; end if;
  if exists (select 1 from bank_txn_accounts where lower(name) = lower(v_name))
     or upper(v_name) in ('CASH', 'FUNDS') then
    raise exception '% is already on the list.', v_name;
  end if;
  select code into v_code from coa_accounts where lower(btrim(title)) = lower(v_name);
  if v_code is null then
    v_code := 'G' || nextval('coa_code_seq');
    insert into coa_accounts (code, title, type, normal_side, is_cash)
    values (v_code, v_name, 'Asset', 'debit', true);
  end if;
  insert into bank_txn_accounts (name, is_bank, cash_column, coa_code)
  values (v_name, true, 'bank', v_code);
  return v_name;
end;
$$;

-- Renaming a bank: the list, the Books account behind its box, and every
-- payment already recorded under the old name — one name, everywhere.
create or replace function bank_acct_rename(p_from text, p_to text) returns text
language plpgsql security definer as $$
declare v_to text := btrim(coalesce(p_to, '')); v_code text;
begin
  perform require_role('admin');
  if v_to = '' then raise exception 'Type the new name.'; end if;
  select coa_code into v_code from bank_txn_accounts where name = p_from;
  if not found then
    raise exception 'There is no account called %.', p_from;
  end if;
  if exists (select 1 from bank_txn_accounts where lower(name) = lower(v_to) and name <> p_from)
     or upper(v_to) in ('CASH', 'FUNDS') then
    raise exception '% is already on the list.', v_to;
  end if;
  if exists (select 1 from coa_accounts where lower(btrim(title)) = lower(v_to)
              and code is distinct from v_code) then
    raise exception 'Books already has an account called %.', v_to;
  end if;
  update bank_txn_accounts set name = v_to where name = p_from;
  update coa_accounts set title = v_to where code = v_code;
  update payments set method = v_to where lower(btrim(method)) = lower(p_from);
  update purchase_order_bill_payments set method = v_to where lower(btrim(method)) = lower(p_from);
  return v_to;
end;
$$;

-- A bill payment's mode: a bank on the list, CASH or FUNDS — checked here
-- now that the list is no longer six names written into a constraint.
create or replace function record_bill_payment(
  p_bill bigint, p_amount numeric, p_paid_on date, p_method text, p_note text
) returns jsonb
language plpgsql security definer as $$
declare v_balance numeric; v_id bigint; v_method text := mop_canonical(p_method);
begin
  perform require_role('admin', 'warehouse', 'office');
  if coalesce(p_amount, 0) <= 0 then
    raise exception 'How much is coming off?';
  end if;
  if v_method is not null and upper(v_method) not in ('CASH', 'FUNDS')
     and not exists (select 1 from bank_txn_accounts where is_bank and name = v_method) then
    raise exception 'That is not a mode of payment this shop uses.';
  end if;
  select balance into v_balance from purchase_order_bill_balances where id = p_bill;
  if not found then raise exception 'There is no bill with that number.'; end if;
  if p_amount > v_balance then
    raise exception 'Only % is still owed.', to_char(v_balance, 'FM999,990.00');
  end if;

  insert into purchase_order_bill_payments (bill_id, amount, paid_on, method, note)
  values (p_bill, p_amount, coalesce(p_paid_on, (now() at time zone 'Asia/Manila')::date),
          v_method, nullif(btrim(coalesce(p_note, '')), ''))
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'balance', v_balance - p_amount);
end;
$$;

-- Books' sweep routes a payment by the list, not four names written in.
create or replace function sync_books() returns jsonb
language plpgsql security definer as $$
declare
  r record; v_entry bigint; v_cash text;
  n_counter int := 0; n_invoice int := 0; n_payment int := 0; n_discount int := 0;
  n_receiving int := 0; n_cost int := 0;
begin
  perform require_role('admin');
  perform pg_advisory_xact_lock(hashtext('book_sync'));

  -- Counter / cash sales — cash against revenue. Till sales stay exactly as
  -- they were: this migration is about a payment recorded against an
  -- invoice, not the till, which is its own screen and wasn't asked for.
  for r in
    select s.id, s.total, coalesce(s.method,'cash') as method, s.at::date as d, s.receipt_no
      from sales s
     where s.total > 0
       and not exists (select 1 from book_source_postings sp
                        where sp.source_type='counter' and sp.source_id=s.id)
     order by s.id
  loop
    v_cash := case lower(r.method) when 'cash' then '103' else '102' end;
    v_entry := post_journal(r.d, 'Counter sale ' || r.receipt_no,
      jsonb_build_array(
        jsonb_build_object('account', v_cash, 'debit', r.total, 'credit', 0, 'memo', r.method),
        jsonb_build_object('account', '402', 'debit', 0, 'credit', r.total, 'memo', 'Item sales')));
    update journal_entries set source='sale' where id=v_entry;
    insert into book_source_postings(source_type, source_id, entry_id) values ('counter', r.id, v_entry);
    n_counter := n_counter + 1;
  end loop;

  -- Wholesale invoices — a receivable against revenue, from the day it is raised.
  for r in
    select i.id, i.amount, i.issued_on, coalesce(i.si_no, 'INV-'||i.id) as no
      from invoices i join orders o on o.id = i.order_id
     where o.status <> 'cancelled' and i.status <> 'void' and i.amount > 0
       and not exists (select 1 from book_source_postings sp
                        where sp.source_type='invoice' and sp.source_id=i.id)
     order by i.id
  loop
    v_entry := post_journal(coalesce(r.issued_on, current_date), 'Invoice ' || r.no,
      jsonb_build_array(
        jsonb_build_object('account', '101', 'debit', r.amount, 'credit', 0, 'memo', r.no),
        jsonb_build_object('account', '402', 'debit', 0, 'credit', r.amount, 'memo', 'Item sales')));
    update journal_entries set source='sale' where id=v_entry;
    insert into book_source_postings(source_type, source_id, entry_id) values ('invoice', r.id, v_entry);
    n_invoice := n_invoice + 1;
  end loop;

  -- Payments on account — cash in, receivable down. The one loop this
  -- migration is actually for: a payment now names which bank it was, not
  -- just cash-or-not, so it lands in that bank's own account.
  for r in
    select p.id, p.amount, coalesce(p.method,'cash') as method, p.paid_on
      from payments p
     where p.amount > 0
       and not exists (select 1 from book_source_postings sp
                        where sp.source_type='payment' and sp.source_id=p.id)
     order by p.id
  loop
    -- The bank the payment names, looked up on Payment Management's own
    -- list — by its name now, or the old Mode of payment wording — so a
    -- bank renamed or added there is routed without touching this.
    v_cash := mop_account_code(r.method);
    v_entry := post_journal(r.paid_on, 'Payment received',
      jsonb_build_array(
        jsonb_build_object('account', v_cash, 'debit', r.amount, 'credit', 0, 'memo', r.method),
        jsonb_build_object('account', '101', 'debit', 0, 'credit', r.amount, 'memo', 'On account')));
    update journal_entries set source='collection' where id=v_entry;
    insert into book_source_postings(source_type, source_id, entry_id) values ('payment', r.id, v_entry);
    n_payment := n_payment + 1;
  end loop;

  -- Early-payment discount on a settled invoice — contra-revenue clears the last
  -- of the receivable.
  for r in
    select i.id, i.discount, coalesce(i.si_no,'INV-'||i.id) as no,
           coalesce(i.settled_on, current_date) as d
      from invoices i join orders o on o.id=i.order_id
     where i.status='paid' and coalesce(i.discount,0) > 0 and o.status <> 'cancelled'
       and not exists (select 1 from book_source_postings sp
                        where sp.source_type='discount' and sp.source_id=i.id)
     order by i.id
  loop
    v_entry := post_journal(r.d, 'Payment discount ' || r.no,
      jsonb_build_array(
        jsonb_build_object('account', '602', 'debit', r.discount, 'credit', 0, 'memo', 'Early payment'),
        jsonb_build_object('account', '101', 'debit', 0, 'credit', r.discount, 'memo', r.no)));
    update journal_entries set source='discount' where id=v_entry;
    insert into book_source_postings(source_type, source_id, entry_id) values ('discount', r.id, v_entry);
    n_discount := n_discount + 1;
  end loop;

  -- Stock received — into inventory, against the clearing account.
  for r in
    select e.id, e.amount, e.spent_on
      from expenses e
     where e.kind='stock' and not e.voided and e.amount > 0
       and not exists (select 1 from book_source_postings sp
                        where sp.source_type='receiving' and sp.source_id=e.id)
     order by e.id
  loop
    v_entry := post_journal(r.spent_on, 'Stock received',
      jsonb_build_array(
        jsonb_build_object('account', '104', 'debit', r.amount, 'credit', 0, 'memo', 'Into inventory'),
        jsonb_build_object('account', '805', 'debit', 0, 'credit', r.amount, 'memo', 'Received, not yet billed')));
    update journal_entries set source='receiving' where id=v_entry;
    insert into book_source_postings(source_type, source_id, entry_id) values ('receiving', r.id, v_entry);
    n_receiving := n_receiving + 1;
  end loop;

  -- Cost of a counter sale — out of inventory, into cost of goods.
  for r in
    select sc.sale_id, sc.cost, s.at::date as d
      from sale_cost sc join sales s on s.id = sc.sale_id
     where sc.cost > 0
       and not exists (select 1 from book_source_postings sp
                        where sp.source_type='cogs_counter' and sp.source_id=sc.sale_id)
     order by sc.sale_id
  loop
    v_entry := post_journal(r.d, 'Cost of counter sale',
      jsonb_build_array(
        jsonb_build_object('account', '105', 'debit', r.cost, 'credit', 0, 'memo', 'Cost of goods'),
        jsonb_build_object('account', '104', 'debit', 0, 'credit', r.cost, 'memo', 'Out of inventory')));
    update journal_entries set source='cogs' where id=v_entry;
    insert into book_source_postings(source_type, source_id, entry_id) values ('cogs_counter', r.sale_id, v_entry);
    n_cost := n_cost + 1;
  end loop;

  -- Cost of a wholesale sale — matched to the invoice that recognised its
  -- revenue, so gross profit lands in the same period.
  for r in
    select ic.invoice_id, ic.cost, coalesce(i.issued_on, current_date) as d
      from invoice_cost ic
      join invoices i on i.id = ic.invoice_id
      join orders o on o.id = i.order_id
     where ic.cost > 0 and i.status <> 'void' and o.status <> 'cancelled'
       and not exists (select 1 from book_source_postings sp
                        where sp.source_type='cogs_invoice' and sp.source_id=ic.invoice_id)
     order by ic.invoice_id
  loop
    v_entry := post_journal(r.d, 'Cost of invoice',
      jsonb_build_array(
        jsonb_build_object('account', '105', 'debit', r.cost, 'credit', 0, 'memo', 'Cost of goods'),
        jsonb_build_object('account', '104', 'debit', 0, 'credit', r.cost, 'memo', 'Out of inventory')));
    update journal_entries set source='cogs' where id=v_entry;
    insert into book_source_postings(source_type, source_id, entry_id) values ('cogs_invoice', r.invoice_id, v_entry);
    n_cost := n_cost + 1;
  end loop;

  return jsonb_build_object('counter', n_counter, 'invoice', n_invoice,
                            'payment', n_payment, 'discount', n_discount,
                            'receiving', n_receiving, 'cost', n_cost,
                            'total', n_counter + n_invoice + n_payment + n_discount
                                     + n_receiving + n_cost);
end;
$$;
alter function mop_canonical(text) set search_path = public, extensions;
alter function mop_account_code(text) set search_path = public, extensions;
alter function payment_modes() set search_path = public, extensions;
alter function bank_acct_boxes() set search_path = public, extensions;
alter function bank_acct_add(text) set search_path = public, extensions;
alter function bank_acct_rename(text, text) set search_path = public, extensions;
alter function record_bill_payment(bigint, numeric, date, text, text)
  set search_path = public, extensions;
alter function sync_books() set search_path = public, extensions;
alter function payment_method_canonical() set search_path = public, extensions;

revoke all on function mop_canonical(text) from public;
revoke all on function mop_account_code(text) from public;
revoke all on function payment_modes() from public;
revoke all on function bank_acct_boxes() from public;
grant execute on function mop_canonical(text) to app_client;
grant execute on function mop_account_code(text) to app_client;
grant execute on function payment_modes() to app_client;
grant execute on function bank_acct_boxes() to app_client;
grant execute on function record_bill_payment(bigint, numeric, date, text, text) to app_client;

-- What the list holds now, for whoever runs this to read back.
select name, is_bank, cash_column, coa_code, aliases from bank_txn_accounts order by place nulls last, id;

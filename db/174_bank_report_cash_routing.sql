-- MS BEAU AVE — a payment posts to the bank it was actually paid into
--
-- Bank report's own Cash position panel shows seven named boxes — Bank, Cash
-- on hand, GCash, BDO, BPI, Security Bank, Balance — read straight off
-- Books. Record payment (Customer order's Invoice tab, and the account-level
-- "Confirm the bank payment" dialog reached from the Resellers/Distributors/
-- Retailers and Birthdays screens) already asks which of those a payment
-- came in as — MOP_OPTIONS has carried GCash, BDO, BPI and Security Bank for
-- a while. sync_books() just never listened past "is this cash or not": every
-- non-cash payment, whichever bank it actually named, piled into one
-- generic account. This is the one line that decided that, taught to tell
-- the four apart.
--
-- The account rename and the four new accounts were already made by hand on
-- production before this migration existed, so both steps below are guarded
-- by title rather than assumed absent — harmless there, and what seeds a
-- fresh database (a new test run, a laptop's own copy) the same way.

-- The original "Cash In Bank" is what Bank report's own "Bank" box looks
-- for — same account, same history, just the name Bank report already uses.
update coa_accounts set title = 'Bank' where code = '102' and title = 'Cash In Bank';

-- GCash, BDO, BPI, Security Bank — named and marked as cash, the same way
-- Books already lets an owner add any account of their own. Codes come from
-- the same generator set_cash_account's own screen uses (POST
-- /api/books/accounts), not a fixed number, so this can never collide with
-- the hand-kept chart above.
insert into coa_accounts (code, title, type, normal_side, is_cash)
select 'G' || nextval('coa_code_seq'), seed.title, 'Asset', 'debit', true
  from (values ('GCash'), ('BDO'), ('BPI'), ('Security Bank')) as seed(title)
 where not exists (select 1 from coa_accounts c where c.title = seed.title);

create or replace function sync_books() returns jsonb
language plpgsql security definer as $$
declare
  r record; v_entry bigint; v_cash text;
  n_counter int := 0; n_invoice int := 0; n_payment int := 0; n_discount int := 0;
  n_receiving int := 0; n_cost int := 0;
  -- Looked up once by title, not hard-coded — the four accounts' own codes
  -- differ between a fresh database (seeded above, in order) and production
  -- (made by hand before this migration existed), the same reason Bank
  -- report's own Cash position panel matches by title rather than code.
  v_gcash text; v_bdo text; v_bpi text; v_secbank text;
begin
  perform require_role('admin');
  perform pg_advisory_xact_lock(hashtext('book_sync'));

  select code into v_gcash   from coa_accounts where title = 'GCash';
  select code into v_bdo     from coa_accounts where title = 'BDO';
  select code into v_bpi     from coa_accounts where title = 'BPI';
  select code into v_secbank from coa_accounts where title = 'Security Bank';

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
    v_cash := case lower(r.method)
      when 'cash' then '103'
      when 'gcash' then coalesce(v_gcash, '102')
      when 'banco de oro (bdo)' then coalesce(v_bdo, '102')
      when 'bpi' then coalesce(v_bpi, '102')
      when 'security bank' then coalesce(v_secbank, '102')
      else '102'
    end;
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
alter function sync_books() set search_path = public, extensions;

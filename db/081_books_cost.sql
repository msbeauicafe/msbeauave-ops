-- ============================================================================
-- MS BEAU AVE — Books (Phase 6: the cost side)
--
-- Auto-posting booked the revenue side of trading; the cost side stayed in the
-- purchase flow, so the income statement showed sales with no cost against them
-- and gross profit read too high. This posts the cost side too, as a proper
-- perpetual inventory, driven from the stock system the business already keeps
-- exactly.
--
-- Three postings, and one clearing account that keeps them honest:
--
--   RECEIVING   debit Cost of Inventory (104)   credit Inventory Clearing (805)
--   COST OF SALE debit Cost of Stocks Sold (105) credit Cost of Inventory (104)
--   TRUE-UP     104 set to the actual value of stock on hand; the difference to
--               Inventory Loss (504) when short, or back through 805 when over.
--
-- Cost of Stocks Sold (105) was seeded as an asset in the old chart — it is a
-- cost, an expense, so it is reclassified here, and now it lands on the income
-- statement where it belongs and gross profit comes right.
--
-- The clearing account (805) is the "goods received, not yet billed" line. A
-- receipt credits it; the supplier's BILL, when it is recorded to 805, debits it
-- and it nets to nothing — so the cost of a purchase is counted once, through
-- the goods, never twice. Until a receipt is billed, 805 carries its value,
-- which is exactly the unbilled-receipts figure a business wants to see. The one
-- rule this asks of the owner: a bill for stock is booked to Inventory Clearing
-- (805), not to an expense.
--
-- Inventory (104) then equals receipts less cost-of-sales less losses, which is
-- the stock on hand at cost; the nightly true-up trims any drift to the real
-- count. All of it is additive, idempotent and owner-only, like the rest.
-- ============================================================================

-- Cost of Stocks Sold is an expense, not an asset.
update coa_accounts set type = 'Expense' where code = '105' and type <> 'Expense';

-- The cost of one sale, and one invoice, from the cost snapshot each line
-- carried at the moment it was sold (falling back to the product's cost for a
-- line old enough to predate the snapshot).
create or replace view sale_cost as
select s.id as sale_id, s.order_id,
       coalesce(sum(ol.qty * coalesce(ol.unit_cost, p.unit_cost)), 0) as cost
  from sales s
  join order_lines ol on ol.order_id = s.order_id
  join products p on p.sku = ol.sku
 group by s.id, s.order_id;

create or replace view invoice_cost as
select i.id as invoice_id, i.order_id,
       coalesce(sum(ol.qty * coalesce(ol.unit_cost, p.unit_cost)), 0) as cost
  from invoices i
  join order_lines ol on ol.order_id = i.order_id
  join products p on p.sku = ol.sku
 group by i.id, i.order_id;

grant select on sale_cost, invoice_cost to app_client;

-- What is waiting to be posted, now counting the cost side too.
create or replace function books_pending() returns jsonb
language plpgsql security definer as $$
declare j jsonb;
begin
  perform require_role('admin');
  select jsonb_build_object(
    'counter', (select count(*) from sales s
                 where s.total > 0 and not exists (select 1 from book_source_postings sp
                   where sp.source_type='counter' and sp.source_id=s.id)),
    'invoice', (select count(*) from invoices i join orders o on o.id=i.order_id
                 where o.status<>'cancelled' and i.status<>'void' and i.amount>0
                   and not exists (select 1 from book_source_postings sp
                     where sp.source_type='invoice' and sp.source_id=i.id)),
    'payment', (select count(*) from payments p
                 where coalesce(p.amount,0)>0 and not exists (select 1 from book_source_postings sp
                   where sp.source_type='payment' and sp.source_id=p.id)),
    'discount', (select count(*) from invoices i join orders o on o.id=i.order_id
                 where i.status='paid' and coalesce(i.discount,0)>0 and o.status<>'cancelled'
                   and not exists (select 1 from book_source_postings sp
                     where sp.source_type='discount' and sp.source_id=i.id)),
    'receiving', (select count(*) from expenses e
                   where e.kind='stock' and not e.voided and e.amount>0
                     and not exists (select 1 from book_source_postings sp
                       where sp.source_type='receiving' and sp.source_id=e.id)),
    'cost', (select count(*) from sale_cost sc
              where sc.cost>0 and not exists (select 1 from book_source_postings sp
                where sp.source_type='cogs_counter' and sp.source_id=sc.sale_id))
          + (select count(*) from invoice_cost ic join invoices i on i.id=ic.invoice_id
                             join orders o on o.id=i.order_id
              where ic.cost>0 and i.status<>'void' and o.status<>'cancelled'
                and not exists (select 1 from book_source_postings sp
                  where sp.source_type='cogs_invoice' and sp.source_id=ic.invoice_id))
  ) into j;
  return j;
end;
$$;
alter function books_pending() set search_path = public, extensions;

-- The sweep, now with the cost side.
create or replace function sync_books() returns jsonb
language plpgsql security definer as $$
declare
  r record; v_entry bigint; v_cash text;
  n_counter int := 0; n_invoice int := 0; n_payment int := 0; n_discount int := 0;
  n_receiving int := 0; n_cost int := 0;
begin
  perform require_role('admin');
  perform pg_advisory_xact_lock(hashtext('book_sync'));

  -- Counter / cash sales — cash against revenue.
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

  -- Payments on account — cash in, receivable down.
  for r in
    select p.id, p.amount, coalesce(p.method,'cash') as method, p.paid_on
      from payments p
     where p.amount > 0
       and not exists (select 1 from book_source_postings sp
                        where sp.source_type='payment' and sp.source_id=p.id)
     order by p.id
  loop
    v_cash := case lower(r.method) when 'cash' then '103' else '102' end;
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

-- The true-up: bring the Inventory book value to the actual value of stock on
-- hand at cost. A shortfall (stock lost, or costed a hair high) goes to
-- Inventory Loss; a surplus (found on a count) back through the clearing
-- account. It only posts when there is a difference, so it is safe to run over
-- and over — a second run finds nothing to do.
create or replace function value_inventory() returns jsonb
language plpgsql security definer as $$
declare v_actual numeric(14,2); v_book numeric(14,2); v_diff numeric(14,2); v_entry bigint;
begin
  perform require_role('admin');
  select coalesce(sum(s.on_hand * p.unit_cost), 0) into v_actual
    from stock s join batches b on b.id = s.batch_id join products p on p.sku = b.sku;
  select coalesce(balance, 0) into v_book from trial_balance where code = '104';
  v_diff := round(v_actual - coalesce(v_book, 0), 2);

  if v_diff = 0 then
    return jsonb_build_object('adjusted', 0, 'actual', v_actual, 'book', coalesce(v_book,0));
  elsif v_diff < 0 then
    v_entry := post_journal(current_date, 'Inventory valued to stock on hand',
      jsonb_build_array(
        jsonb_build_object('account', '504', 'debit', -v_diff, 'credit', 0, 'memo', 'Shrinkage / cost true-up'),
        jsonb_build_object('account', '104', 'debit', 0, 'credit', -v_diff, 'memo', 'To actual on hand')));
  else
    v_entry := post_journal(current_date, 'Inventory valued to stock on hand',
      jsonb_build_array(
        jsonb_build_object('account', '104', 'debit', v_diff, 'credit', 0, 'memo', 'To actual on hand'),
        jsonb_build_object('account', '805', 'debit', 0, 'credit', v_diff, 'memo', 'Found on count / true-up')));
  end if;
  update journal_entries set source = 'inventory' where id = v_entry;
  return jsonb_build_object('adjusted', v_diff, 'actual', v_actual, 'book', coalesce(v_book,0), 'entry', v_entry);
end;
$$;
alter function value_inventory() set search_path = public, extensions;
revoke all on function value_inventory() from public;
grant execute on function value_inventory() to app_client;

-- The nightly job trues up the stockroom after it sweeps the day's trading.
create or replace function run_book_sync_job() returns jsonb
language plpgsql security definer as $$
declare j jsonb;
begin
  perform set_config('app.role',  'admin',   true);
  perform set_config('app.actor', 'nightly', true);
  j := sync_books();
  perform value_inventory();
  return j;
end;
$$;
alter function run_book_sync_job() set search_path = public, extensions;
revoke all on function run_book_sync_job() from public;

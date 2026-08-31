-- ============================================================================
-- MS BEAU AVE — Books (Phase 5: auto-posting)
--
-- Until now the books were kept by hand — correct before automatic, as the very
-- first migration promised. This is the "automatic": the day's real trading,
-- read out of the selling side and posted to the ledger on its own.
--
-- Three rules hold this together, and they are what make it safe to point at a
-- live shop:
--
--   * ADDITIVE ONLY. Nothing here writes to a sale, an order, a stock row or a
--     price. It reads what already happened and writes journal entries. The
--     selling side does not know this exists and cannot be broken by it.
--   * IDEMPOTENT. Every source event is written down once in
--     book_source_postings against the entry it produced. Run the sweep a
--     hundred times and each sale is still posted exactly once. An advisory
--     lock keeps two sweeps from racing.
--   * DECOUPLED. This is a sweep the owner (or a schedule) runs, never a
--     trigger on the checkout. A bug in here can never roll back a real sale.
--
-- The model is periodic inventory: the REVENUE side of trading is posted here;
-- the COST side stays where the business already keeps it — the purchase and
-- bill flow. So a sale books cash (or a receivable) against Item Sales Revenue,
-- and no cost of goods is guessed from an unreliable per-line snapshot.
--
--   Counter / cash sale      debit cash (by method)      credit Item Sales Revenue
--   Wholesale invoice        debit Accounts Receivable   credit Item Sales Revenue
--   Payment on account       debit cash (by method)      credit Accounts Receivable
--   Early-payment discount   debit Customer Pmt Discounts credit Accounts Receivable
--
-- The receivable is recognised when the INVOICE is raised, not when the order is
-- later fulfilled — because a customer can pay against an invoice before it
-- ships, and a payment must always have a receivable to draw down. Every
-- non-void invoice (whose order was not cancelled) is booked; every payment
-- credits it; so A/R and the payments against it can never disagree.
--
-- A receivable is drawn back down to nothing by its payments and, if one was
-- given, its discount — so a settled invoice leaves no balance behind.
-- ============================================================================

-- The one thing that makes a sweep idempotent: a source event, and the entry it
-- became. The primary key is the guard — a second attempt to post the same
-- event cannot insert a second row.
create table if not exists book_source_postings (
  source_type text   not null,   -- 'counter' | 'invoice' | 'payment' | 'discount'
  source_id   bigint not null,   -- the id in sales / invoices / payments
  entry_id    bigint not null references journal_entries(id),
  posted_at   timestamptz not null default now(),
  primary key (source_type, source_id)
);

-- What is waiting to be posted, without posting it — the number the screen shows.
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
                     where sp.source_type='discount' and sp.source_id=i.id))
  ) into j;
  return j;
end;
$$;
alter function books_pending() set search_path = public, extensions;

-- The sweep. Posts everything not yet posted, in one pass, and reports how many
-- of each it did.
create or replace function sync_books() returns jsonb
language plpgsql security definer as $$
declare
  r record; v_entry bigint; v_cash text;
  n_counter int := 0; n_invoice int := 0; n_payment int := 0; n_discount int := 0;
begin
  perform require_role('admin');
  -- Only one sweep at a time, so two runs cannot post the same event twice.
  perform pg_advisory_xact_lock(hashtext('book_sync'));

  -- Counter / cash sales — cash settles at the till, so cash against revenue.
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

  -- The early-payment discount on a settled invoice — contra-revenue clears the
  -- last of the receivable, so a paid invoice leaves nothing owed.
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

  return jsonb_build_object('counter', n_counter, 'invoice', n_invoice,
                            'payment', n_payment, 'discount', n_discount,
                            'total', n_counter + n_invoice + n_payment + n_discount);
end;
$$;
alter function sync_books() set search_path = public, extensions;

-- The map is the owner's, like the rest of the books.
alter table book_source_postings enable row level security;
drop policy if exists admin_book_source_postings on book_source_postings;
create policy admin_book_source_postings on book_source_postings for all
  using (current_role_name() = 'admin') with check (current_role_name() = 'admin');
grant select, insert on book_source_postings to app_client;
grant execute on function books_pending() to app_client;
grant execute on function sync_books() to app_client;

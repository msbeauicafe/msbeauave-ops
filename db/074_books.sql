-- ============================================================================
-- MS BEAU AVE — Books (Phase 1: the accounting foundation)
--
-- A separate app on the same deploy, the way the shop and the clock are. This
-- is the spine an accounting system is built around: a chart of accounts, a
-- journal of double-entry postings, and the trial balance that falls out of
-- them. Sales and stock do not post here yet — that is a later phase; this is
-- the book somebody keeps by hand, correct before it is automatic.
--
-- The chart is seeded from the 75-line template the business already had in
-- the old system, so it opens familiar. Everything here is the owner's: these
-- are the company's books, and only 'admin' reads or writes them.
-- ============================================================================

create table if not exists coa_accounts (
  code          text primary key,
  title         text not null unique,
  type          text not null check (type in
                  ('Asset','Contra Asset','Liability','Equity','Common',
                   'Revenue','Contra Revenue','Expense','Contra Expense')),
  normal_side   text not null check (normal_side in ('debit','credit')),
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

-- A code is handy but not every title in the old system had one; where it did
-- not, the title itself is the key. So a surrogate is generated only when the
-- imported code is blank.
create sequence if not exists coa_code_seq start 9001;

-- One posting: a date, a memo, and two or more lines that MUST balance. The
-- balance is enforced when the entry is posted, not trusted from the caller.
create table if not exists journal_entries (
  id           bigint generated always as identity primary key,
  entry_no     text unique,
  entry_date   date not null,
  memo         text not null,
  posted_by    text,
  created_at   timestamptz not null default now()
);

create table if not exists journal_lines (
  id          bigint generated always as identity primary key,
  entry_id    bigint not null references journal_entries(id) on delete cascade,
  account     text not null references coa_accounts(code),
  debit       numeric(14,2) not null default 0 check (debit  >= 0),
  credit      numeric(14,2) not null default 0 check (credit >= 0),
  memo        text,
  -- A line is one side or the other, never both and never neither.
  constraint one_side check ((debit > 0) <> (credit > 0))
);
create index if not exists journal_lines_account on journal_lines(account);
create index if not exists journal_lines_entry on journal_lines(entry_id);

-- The trial balance: every account, its debits and credits, and the balance on
-- its normal side. The heart of the whole thing, and the proof it is right —
-- total debits equal total credits or the books do not balance.
create or replace view trial_balance as
select a.code, a.title, a.type, a.normal_side,
       coalesce(sum(l.debit), 0)  as debits,
       coalesce(sum(l.credit), 0) as credits,
       case when a.normal_side = 'debit'
            then coalesce(sum(l.debit),0) - coalesce(sum(l.credit),0)
            else coalesce(sum(l.credit),0) - coalesce(sum(l.debit),0) end as balance
  from coa_accounts a
  left join journal_lines l on l.account = a.code
 group by a.code, a.title, a.type, a.normal_side;

-- One account's history, oldest first, with a running balance on its normal
-- side — the account ledger.
create or replace view account_ledger as
select l.account, e.id as entry_id, e.entry_no, e.entry_date, e.memo,
       l.debit, l.credit,
       sum(case when a.normal_side='debit' then l.debit - l.credit
                else l.credit - l.debit end)
         over (partition by l.account order by e.entry_date, e.id, l.id) as running
  from journal_lines l
  join journal_entries e on e.id = l.entry_id
  join coa_accounts a on a.code = l.account;

-- Posting an entry. The lines are the whole entry; they are checked to balance
-- to the centavo before a single row is written, and the entry gets its number
-- in the run BK-000001. Off by a centavo is refused, named, and nothing lands.
create or replace function post_journal(p_date date, p_memo text, p_lines jsonb)
returns bigint
language plpgsql security definer as $$
declare v_id bigint; v_no text; v_debit numeric(14,2); v_credit numeric(14,2); v_n int;
begin
  perform require_role('admin');

  if p_date is null then raise exception 'A posting needs a date.'; end if;
  if length(btrim(coalesce(p_memo,''))) = 0 then raise exception 'A posting needs a memo.'; end if;

  select coalesce(sum((l->>'debit')::numeric),0),
         coalesce(sum((l->>'credit')::numeric),0),
         count(*)
    into v_debit, v_credit, v_n
    from jsonb_array_elements(p_lines) l;

  if v_n < 2 then raise exception 'A posting is at least two lines.'; end if;
  if v_debit <> v_credit then
    raise exception 'BOOKS_DONT_BALANCE: debits % and credits % are not equal.', v_debit, v_credit;
  end if;
  if v_debit = 0 then raise exception 'A posting cannot be for nothing.'; end if;

  if exists (select 1 from jsonb_array_elements(p_lines) l
              where not exists (select 1 from coa_accounts a where a.code = l->>'account')) then
    raise exception 'A line names an account that is not in the chart.';
  end if;

  insert into journal_entries (entry_no, entry_date, memo, posted_by)
  values ('BK-' || lpad(nextval('journal_entry_seq')::text, 6, '0'),
          p_date, btrim(p_memo), current_actor())
  returning id, entry_no into v_id, v_no;

  insert into journal_lines (entry_id, account, debit, credit, memo)
  select v_id, l->>'account',
         coalesce((l->>'debit')::numeric,0), coalesce((l->>'credit')::numeric,0),
         nullif(btrim(coalesce(l->>'memo','')),'')
    from jsonb_array_elements(p_lines) l;

  return v_id;
end;
$$;
alter function post_journal(date, text, jsonb) set search_path = public, extensions;

create sequence if not exists journal_entry_seq start 1;

-- Adding or hiding an account in the chart.
create or replace function save_account(p_code text, p_title text, p_type text, p_normal text)
returns text
language plpgsql security definer as $$
declare v_code text;
begin
  perform require_role('admin');
  if length(btrim(coalesce(p_title,''))) = 0 then raise exception 'An account needs a title.'; end if;
  v_code := nullif(btrim(coalesce(p_code,'')), '');
  if v_code is null then v_code := 'G' || nextval('coa_code_seq'); end if;
  insert into coa_accounts (code, title, type, normal_side)
  values (v_code, btrim(p_title), p_type, p_normal)
  on conflict (code) do update set title = excluded.title, type = excluded.type,
                                    normal_side = excluded.normal_side;
  return v_code;
end;
$$;
alter function save_account(text, text, text, text) set search_path = public, extensions;

-- The books are the owner's. Read and write, admin only.
alter table coa_accounts   enable row level security;
alter table journal_entries enable row level security;
alter table journal_lines   enable row level security;
drop policy if exists admin_books_accounts on coa_accounts;
create policy admin_books_accounts on coa_accounts for all
  using (current_role_name() = 'admin') with check (current_role_name() = 'admin');
drop policy if exists admin_books_entries on journal_entries;
create policy admin_books_entries on journal_entries for all
  using (current_role_name() = 'admin') with check (current_role_name() = 'admin');
drop policy if exists admin_books_lines on journal_lines;
create policy admin_books_lines on journal_lines for all
  using (current_role_name() = 'admin') with check (current_role_name() = 'admin');
grant select, insert, update, delete on coa_accounts, journal_entries, journal_lines to app_client;
grant select on trial_balance, account_ledger to app_client;
grant usage on sequence coa_code_seq, journal_entry_seq to app_client;

-- The chart, seeded from the old system's own template so it opens familiar.
insert into coa_accounts (code, title, type, normal_side) values
  ('201', 'Accounts Payable', 'Liability', 'credit'),
  ('101', 'Accounts Receivable', 'Asset', 'debit'),
  ('902', 'Accumulated Depreciation - Furnitures and Fixtures', 'Contra Asset', 'credit'),
  ('106', 'Advance Payment To Supplier', 'Asset', 'debit'),
  ('804', 'Beginning Inventory', 'Common', 'credit'),
  ('803', 'Cash Adjustment', 'Common', 'credit'),
  ('102', 'Cash In Bank', 'Asset', 'debit'),
  ('103', 'Cash On Hand', 'Asset', 'debit'),
  ('115', 'Cash Only', 'Asset', 'debit'),
  ('512', 'Commission Expense', 'Expense', 'debit'),
  ('517', 'Communication Expense', 'Expense', 'debit'),
  ('120', 'COMPUTER EQUIPMENT', 'Asset', 'debit'),
  ('533', 'COMPUTER EQUIPMENT EXPENSE', 'Expense', 'debit'),
  ('123', 'Cost of Fixed Assets - Furnitures and Fixtures', 'Asset', 'debit'),
  ('104', 'Cost of Inventory', 'Asset', 'debit'),
  ('114', 'Cost of Inventory VAT', 'Asset', 'debit'),
  ('105', 'Cost of Stocks Sold', 'Asset', 'debit'),
  ('602', 'Customer Payment Discounts', 'Contra Revenue', 'debit'),
  ('607', 'Deferred VAT Payables', 'Contra Revenue', 'debit'),
  ('522', 'DELIVERY EXP', 'Expense', 'debit'),
  ('501', 'Delivery Expenses', 'Expense', 'debit'),
  ('532', 'DEPRECIATION EXPENSE', 'Expense', 'debit'),
  ('542', 'Depreciation Expense - Furnitures and Fixtures', 'Expense', 'debit'),
  ('530', 'equipment', 'Expense', 'debit'),
  ('703', 'Expense Discounts', 'Contra Expense', 'debit'),
  ('538', 'Expense Sample 1', 'Expense', 'debit'),
  ('119', 'Fixed Assets - Vehicle', 'Asset', 'debit'),
  ('520', 'Hazard Pay', 'Expense', 'debit'),
  ('209', 'HDMF Payable', 'Liability', 'credit'),
  ('518', 'Holiday Pay', 'Expense', 'debit'),
  ('202', 'Income Tax Payables', 'Liability', 'credit'),
  ('113', 'Income Tax Recoverables', 'Asset', 'debit'),
  ('534', 'Interest Expense', 'Expense', 'debit'),
  ('805', 'Inventory Adjustment', 'Common', 'credit'),
  ('504', 'Inventory Loss Expense', 'Expense', 'debit'),
  ('604', 'Item Sales Discounts', 'Contra Revenue', 'debit'),
  ('402', 'Item Sales Revenue', 'Revenue', 'credit'),
  ('124', 'Land Property', 'Asset', 'debit'),
  ('524', 'LIGHT & POWER', 'Expense', 'debit'),
  ('523', 'OFFICE EXP', 'Expense', 'debit'),
  ('802', 'Opening Balance', 'Common', 'credit'),
  ('808', 'Opening Payable', 'Common', 'credit'),
  ('807', 'Opening Receivable', 'Common', 'debit'),
  ('521', 'Operating Expense', 'Expense', 'debit'),
  ('502', 'Operating Expenses', 'Expense', 'debit'),
  ('535', 'Penalties and Fines', 'Expense', 'debit'),
  ('208', 'PHIC Payable', 'Liability', 'credit'),
  ('540', 'Postage and Delivery', 'Expense', 'debit'),
  ('701', 'Purchase Discounts', 'Contra Expense', 'credit'),
  ('605', 'Rebates', 'Contra Revenue', 'debit'),
  ('516', 'RENT', 'Expense', 'debit'),
  ('606', 'Return To Supplier Discounts', 'Contra Revenue', 'debit'),
  ('406', 'Return To Supplier Refund', 'Revenue', 'credit'),
  ('515', 'Rod', 'Expense', 'debit'),
  ('519', 'Salaries and Wages', 'Expense', 'debit'),
  ('510', 'Salary Expense', 'Expense', 'debit'),
  ('509', 'Sales Refund', 'Expense', 'debit'),
  ('705', 'Sales Refund Discounts', 'Contra Expense', 'credit'),
  ('122', 'SAMPLE', 'Asset', 'debit'),
  ('525', 'SSS CONTRI EXP', 'Expense', 'debit'),
  ('702', 'Supplier Payment Discounts', 'Contra Expense', 'credit'),
  ('511', 'Test', 'Expense', 'debit'),
  ('514', 'test1231231', 'Expense', 'debit'),
  ('121', 'testing', 'Asset', 'debit'),
  ('537', 'testing123', 'Expense', 'debit'),
  ('508', 'Transportation Expense', 'Expense', 'debit'),
  ('207', 'Unearned Revenue', 'Liability', 'credit'),
  ('507', 'Utility Expense', 'Expense', 'debit'),
  ('203', 'VAT Payables', 'Liability', 'credit'),
  ('107', 'VAT Recoverables', 'Asset', 'debit'),
  ('541', 'water expenses', 'Expense', 'debit'),
  ('117', 'WH EQUIPMENT', 'Asset', 'debit')
on conflict (code) do nothing;

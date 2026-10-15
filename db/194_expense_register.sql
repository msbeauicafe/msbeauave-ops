-- MS BEAU AVE — Bank report's Expense Register
--
-- Bank report → Expenses becomes a register, laid out like the owner's
-- reference: an Expenses Overview for a month (total, unpaid, for
-- reimbursement, missing receipts) and the expenses themselves, each with a
-- payee, how it was paid, whether it is paid yet, and whether its receipt is
-- in. Recorded from the register's own form; the Finance screen's own way of
-- recording an expense (record_expense) is left as it is.
--
-- An expense here was never posted to Books (only stock receiving is), so a
-- pending or to-be-reimbursed one does not move Cash position. Stock bought
-- for the shelves stays out of the register — it is Purchases'.

alter table expenses add column if not exists payee text;
-- The Mode of payment it went out through, as Payment Management names it
-- (BDO, GCash, CASH …); method keeps its old four for everything that reads it.
alter table expenses add column if not exists paid_through text;
alter table expenses add column if not exists payment_status text not null default 'paid';
alter table expenses drop constraint if exists expenses_payment_status_check;
alter table expenses add constraint expenses_payment_status_check
  check (payment_status in ('paid', 'pending', 'reimburse'));
-- Null on everything recorded before the register: nobody said either way.
alter table expenses add column if not exists receipt_status text;
alter table expenses drop constraint if exists expenses_receipt_status_check;
alter table expenses add constraint expenses_receipt_status_check
  check (receipt_status is null or receipt_status in ('with_receipt', 'with_invoice', 'pending', 'missing'));

-- One expense as the register shows it: EXP-2026-001 from its year and id.
create or replace function expense_register(p_from date, p_to date) returns jsonb
language plpgsql stable security definer as $$
begin
  perform require_role('admin');
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', e.id,
      'ref', 'EXP-' || to_char(e.spent_on, 'YYYY') || '-' || lpad(e.id::text, 3, '0'),
      'spent_on', e.spent_on, 'kind', e.kind, 'description', e.description,
      'payee', e.payee, 'amount', e.amount, 'method', e.method,
      'paid_through', e.paid_through, 'payment_status', e.payment_status,
      'receipt_status', e.receipt_status, 'source', e.source, 'paid_by', e.paid_by)
      order by e.spent_on desc, e.id desc)
     from expenses e
    where not e.voided and e.spent_on between p_from and p_to
      -- Stock bought for the shelves is Purchases' (and Books'), not an
      -- operating expense: it would bury the register's real expenses.
      and e.kind <> 'stock'), '[]'::jsonb);
end;
$$;

-- Adding one from the register's form. Every field it picks from is checked
-- against its list; Particulars and Payee are the two that are typed.
create or replace function expense_register_add(p jsonb) returns bigint
language plpgsql security definer as $$
declare
  v_id bigint;
  v_through text := mop_canonical(p ->> 'paid_through');
  v_method text;
begin
  perform require_role('admin');
  if coalesce(btrim(p ->> 'description'), '') = '' then raise exception 'Describe the expense.'; end if;
  if coalesce((p ->> 'amount')::numeric, 0) <= 0 then raise exception 'The amount must be more than zero.'; end if;
  if coalesce(p ->> 'kind', 'other') = 'stock' then
    raise exception 'Stock is recorded by receiving it, not here.';
  end if;
  if v_through is null or (upper(v_through) not in ('CASH', 'FUNDS')
     and not exists (select 1 from bank_txn_accounts where is_bank and name = v_through)) then
    raise exception 'Pick how it was paid.';
  end if;
  v_method := case when upper(v_through) = 'CASH' then 'cash'
                   when exists (select 1 from bank_txn_accounts
                                 where name = v_through and 'GCASH' = any(aliases)) then 'gcash'
                   else 'bank' end;
  insert into expenses (spent_on, kind, description, payee, amount, method, paid_through,
                        payment_status, receipt_status)
  values (coalesce(nullif(p ->> 'spent_on', '')::date, (now() at time zone 'Asia/Manila')::date),
          coalesce(nullif(p ->> 'kind', ''), 'other'), btrim(p ->> 'description'),
          nullif(btrim(coalesce(p ->> 'payee', '')), ''), round((p ->> 'amount')::numeric, 2),
          v_method, v_through,
          coalesce(nullif(p ->> 'payment_status', ''), 'paid'),
          coalesce(nullif(p ->> 'receipt_status', ''), 'pending'))
  returning id into v_id;
  return v_id;
end;
$$;

-- Paid at last, or the receipt came in: the two things that change after.
create or replace function expense_register_status(p_id bigint, p_payment text, p_receipt text) returns void
language plpgsql security definer as $$
begin
  perform require_role('admin');
  update expenses
     set payment_status = coalesce(nullif(p_payment, ''), payment_status),
         receipt_status = coalesce(nullif(p_receipt, ''), receipt_status)
   where id = p_id and not voided;
  if not found then raise exception 'There is no such expense.'; end if;
end;
$$;

alter function expense_register(date, date) set search_path = public, extensions;
alter function expense_register_add(jsonb) set search_path = public, extensions;
alter function expense_register_status(bigint, text, text) set search_path = public, extensions;
revoke all on function expense_register(date, date) from public;
revoke all on function expense_register_add(jsonb) from public;
revoke all on function expense_register_status(bigint, text, text) from public;
grant execute on function expense_register(date, date) to app_client;
grant execute on function expense_register_add(jsonb) to app_client;
grant execute on function expense_register_status(bigint, text, text) to app_client;

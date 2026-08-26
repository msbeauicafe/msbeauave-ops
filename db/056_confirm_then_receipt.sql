-- ============================================================================
-- MS BEAU AVE — confirming a payment and issuing the receipt are two acts
--
-- A reseller settles an invoice in instalments. Five of them fit on the
-- paper: five MOP slots, five references, five dates. Until now the app took
-- one amount and immediately stamped an OR for it, which made every partial
-- payment its own receipt and left the reseller holding four receipts for one
-- invoice.
--
-- So the two are separated. Confirming records the money and applies it,
-- oldest invoice first, exactly as before. Issuing the receipt is a decision
-- taken afterwards, over whatever has been confirmed and not yet receipted —
-- which is how one OR comes to cover four transfers.
--
-- A payment therefore has to remember whether a receipt has been given for
-- it. Two columns rather than one clever one, because they answer different
-- questions: awaits_receipt is whether Issue OR should pick this up, and
-- receipt_id is which OR did. The second is the paper trail; the first is
-- the queue.
-- ============================================================================

alter table payments add column if not exists receipt_id bigint
  references reseller_receipts (id);

-- Everything already in the ledger predates the split. Nobody is going to
-- issue receipts retroactively for six hundred and fifty-seven historical
-- payments, and the first press of Issue OR must not offer to. The backfill
-- runs only when the column is new, so re-running this file cannot sweep
-- genuinely waiting payments out of the queue.
do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'payments'
                    and column_name = 'awaits_receipt') then
    alter table payments add column awaits_receipt boolean not null default true;
    update payments set awaits_receipt = false;
  end if;
end $$;

create index if not exists payments_awaiting_receipt
  on payments (invoice_id) where awaits_receipt;

-- ---------------------------------------------------------------------------
-- Confirming: the money is recorded and applied. No number is put on it.
-- ---------------------------------------------------------------------------
create or replace function confirm_reseller_payment(
  p_reseller bigint, p_amount numeric, p_paid_on date default current_date,
  p_method text default null, p_details text default null, p_reference text default null
) returns jsonb
language plpgsql security definer as $$
declare v_mark bigint; v_result jsonb;
begin
  perform require_role('admin');

  -- The high-water mark before pay_reseller_account writes, so the rows it
  -- creates can be found afterwards and stamped with which bank this came
  -- through. That function stays untouched: other callers have not asked for
  -- any of this.
  select coalesce(max(id), 0) into v_mark from payments;
  v_result := pay_reseller_account(p_reseller, p_amount, p_paid_on);

  update payments p
     set method        = coalesce(p_method,    p.method),
         payer_details = coalesce(p_details,   p.payer_details),
         reference_no  = coalesce(p_reference, p.reference_no)
    from invoices i
   where i.id = p.invoice_id and i.reseller_id = p_reseller and p.id > v_mark;

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Issuing: a number over everything confirmed and not yet receipted.
-- ---------------------------------------------------------------------------
create or replace function issue_reseller_receipt_now(p_reseller bigint)
returns jsonb
language plpgsql security definer as $$
declare
  v_receipt text;
  v_id      bigint;
  v_amount  numeric(12,2);
  v_applied jsonb;
  v_paid_on date;
begin
  perform require_role('admin');

  select coalesce(sum(p.amount), 0),
         coalesce(jsonb_agg(jsonb_build_object(
           'invoice_id', p.invoice_id,
           'order_id',   i.order_id,
           'applied',    p.amount,
           'discount',   0,
           'paid_on',    p.paid_on,
           'method',     p.method,
           'reference_no', p.reference_no,
           'now_owes',   i.amount - i.paid - i.discount)
           order by p.paid_on, p.id), '[]'::jsonb),
         max(p.paid_on)
    into v_amount, v_applied, v_paid_on
    from payments p
    join invoices i on i.id = p.invoice_id
   where i.reseller_id = p_reseller and p.awaits_receipt;

  if v_amount <= 0 then
    raise exception 'Nothing confirmed on this account is waiting for a receipt.';
  end if;

  v_receipt := 'OR-' || to_char(now() at time zone 'Asia/Manila', 'YYYYMMDD')
               || '-' || lpad(nextval('receipt_counter')::text, 5, '0');

  insert into reseller_receipts (receipt_no, reseller_id, amount, applied, credited, paid_on)
  values (v_receipt, p_reseller, v_amount, v_applied, 0, coalesce(v_paid_on, current_date))
  returning id into v_id;

  update payments p
     set awaits_receipt = false, receipt_id = v_id
    from invoices i
   where i.id = p.invoice_id and i.reseller_id = p_reseller and p.awaits_receipt;

  return jsonb_build_object(
    'receipt_no', v_receipt,
    'amount',     v_amount,
    'applied',    v_applied,
    'credited',   0,
    'still_owed', amount_outstanding(p_reseller));
end;
$$;

-- ---------------------------------------------------------------------------
-- What is waiting, so the screen can say so before anybody presses anything.
-- ---------------------------------------------------------------------------
create or replace function receipt_pending(p_reseller bigint)
returns jsonb
language sql stable security definer as $$
  select jsonb_build_object(
    'count',  count(*)::int,
    'amount', coalesce(sum(p.amount), 0),
    'lines',  coalesce(jsonb_agg(jsonb_build_object(
                'invoice_id', p.invoice_id, 'amount', p.amount,
                'paid_on', p.paid_on, 'method', p.method,
                'reference_no', p.reference_no) order by p.paid_on, p.id), '[]'::jsonb))
    from payments p
    join invoices i on i.id = p.invoice_id
   where i.reseller_id = p_reseller and p.awaits_receipt;
$$;

-- The one-step call keeps working — it is what the tests hold to and it is a
-- fair thing to want — but it now closes off the payments it created, so a
-- receipt issued that way is never offered again by Issue OR.
create or replace function issue_reseller_receipt(
  p_reseller bigint, p_amount numeric, p_paid_on date default current_date,
  p_method text default null, p_details text default null, p_reference text default null
) returns jsonb
language plpgsql security definer as $$
declare v_result jsonb; v_receipt text; v_id bigint;
begin
  perform require_role('admin');
  v_result := confirm_reseller_payment(p_reseller, p_amount, p_paid_on,
                                       p_method, p_details, p_reference);

  v_receipt := 'OR-' || to_char(now() at time zone 'Asia/Manila', 'YYYYMMDD')
               || '-' || lpad(nextval('receipt_counter')::text, 5, '0');

  insert into reseller_receipts (receipt_no, reseller_id, amount, applied, credited, paid_on)
  values (v_receipt, p_reseller, p_amount, v_result -> 'applied',
          coalesce((v_result ->> 'credited')::numeric, 0), p_paid_on)
  returning id into v_id;

  update payments p
     set awaits_receipt = false, receipt_id = v_id
    from invoices i
   where i.id = p.invoice_id and i.reseller_id = p_reseller and p.awaits_receipt;

  return v_result || jsonb_build_object('receipt_no', v_receipt);
end;
$$;

alter function confirm_reseller_payment(bigint, numeric, date, text, text, text)
  set search_path = public, extensions;
alter function issue_reseller_receipt_now(bigint) set search_path = public, extensions;
alter function receipt_pending(bigint)            set search_path = public, extensions;

grant execute on function confirm_reseller_payment(bigint, numeric, date, text, text, text)
  to app_client;
grant execute on function issue_reseller_receipt_now(bigint) to app_client;
grant execute on function receipt_pending(bigint)            to app_client;
alter function issue_reseller_receipt(bigint, numeric, date, text, text, text)
  set search_path = public, extensions;

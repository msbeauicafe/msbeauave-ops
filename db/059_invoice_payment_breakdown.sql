-- ============================================================================
-- MS BEAU AVE — how one invoice was paid, not just that it was
--
-- Confirming a payment against the account already takes five rows: five
-- amounts, five banks, five references, applied oldest invoice first. But
-- Record payment, on one invoice's own row, still took a single number and
-- nothing else — no bank, no reference, no breakdown. A reseller who settles
-- ₱103,785 with a BDO transfer, a BPI transfer and GCash landed in the ledger
-- as one anonymous lump against that invoice, and the invoice printed three
-- blank MOP slots underneath a figure nobody could trace.
--
-- Same five rows, then, but pointed at one invoice instead of at the account.
-- The difference is not cosmetic: this is the case where somebody is looking
-- at a particular bill and knows exactly which bill the money is for, and
-- oldest-first would put it somewhere else.
--
-- record_payment does the work, once per row, exactly as it always has — the
-- early-settlement discount, the paid/settled bookkeeping, the unblocking of
-- an account brought current. All this adds is which bank each row came
-- through, which is the thing the paper wanted all along.
-- ============================================================================

create or replace function record_invoice_payments(
  p_invoice bigint, p_payments jsonb
) returns jsonb
language plpgsql security definer as $$
declare
  inv       invoices%rowtype;
  pay       record;
  v_mark    bigint;
  v_total   numeric(12,2) := 0;
  v_n       int := 0;
  v_balance numeric(12,2);
  v_rows    jsonb := '[]'::jsonb;
begin
  perform require_role('admin');

  select * into inv from invoices where id = p_invoice;
  if not found then raise exception 'There is no invoice #%.', p_invoice; end if;
  if inv.status <> 'open' then
    raise exception 'Invoice #% is already %.', p_invoice, inv.status;
  end if;

  -- Counted before anything is written, so a fat-fingered extra nought is
  -- refused whole rather than half-applied and then complained about.
  select coalesce(sum((p ->> 'amount')::numeric), 0), count(*)
    into v_total, v_n
    from jsonb_array_elements(coalesce(p_payments, '[]'::jsonb)) p
   where coalesce(nullif(btrim(coalesce(p ->> 'amount', '')), ''), '0')::numeric > 0;

  if v_n = 0 then
    raise exception 'Fill in at least one row — how much actually landed?';
  end if;

  v_balance := inv.amount - inv.paid - inv.discount;
  if v_total > v_balance then
    raise exception 'That is %, and invoice #% only has % left on it. Anything over what one invoice owes goes through Confirm the bank payment on the account, which turns the remainder into credit.',
      to_char(v_total, 'FM999,999,990.00'), p_invoice,
      to_char(v_balance, 'FM999,999,990.00');
  end if;

  for pay in
    select nullif(btrim(coalesce(p ->> 'amount', '')), '')::numeric as amount,
           coalesce(nullif(btrim(coalesce(p ->> 'paid_on', '')), '')::date,
                    (now() at time zone 'Asia/Manila')::date) as paid_on,
           nullif(btrim(coalesce(p ->> 'method', '')), '')       as method,
           nullif(btrim(coalesce(p ->> 'details', '')), '')      as details,
           nullif(btrim(coalesce(p ->> 'reference_no', '')), '') as reference_no
      from jsonb_array_elements(p_payments) with ordinality as t(p, ord)
     where coalesce(nullif(btrim(coalesce(p ->> 'amount', '')), ''), '0')::numeric > 0
     order by t.ord
  loop
    -- The high-water mark before each row, so the payment record_payment
    -- writes can be found again and stamped with the bank it came through.
    -- record_payment itself stays untouched: its other callers have not asked
    -- for any of this.
    select coalesce(max(id), 0) into v_mark from payments;
    perform record_payment(p_invoice, pay.amount, pay.paid_on);
    update payments
       set method        = coalesce(pay.method,       method),
           payer_details = coalesce(pay.details,      payer_details),
           reference_no  = coalesce(pay.reference_no, reference_no)
     where invoice_id = p_invoice and id > v_mark;

    v_rows := v_rows || jsonb_build_object(
      'amount', pay.amount, 'paid_on', pay.paid_on, 'method', pay.method,
      'reference_no', pay.reference_no);
  end loop;

  select * into inv from invoices where id = p_invoice;
  return jsonb_build_object(
    'invoice_id', inv.id, 'order_id', inv.order_id,
    'taken', v_total, 'rows', v_rows,
    'paid', inv.paid, 'discount', inv.discount,
    'balance', inv.amount - inv.paid - inv.discount,
    'status', inv.status);
end;
$$;

alter function record_invoice_payments(bigint, jsonb)
  set search_path = public, extensions;
grant execute on function record_invoice_payments(bigint, jsonb) to app_client;

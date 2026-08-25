-- ============================================================================
-- MS BEAU AVE — how a payment arrived, not just that it did
--
-- The invoice carries a PAYMENT DETAILS block: the bank it came through, the
-- account it landed in, the bank's own reference number, the date and the
-- amount. Only the last two were ever recorded, so the block could not be
-- filled from the ledger and was written out by hand every time.
--
-- The reference number matters more than it looks. It is the bank's, not
-- ours: it is what a reseller quotes when they say the money left, and what
-- anybody checking the statement matches against. An OR number cannot stand
-- in for it — they answer different questions.
-- ============================================================================
alter table payments add column if not exists method        text;
alter table payments add column if not exists payer_details text;
alter table payments add column if not exists reference_no  text;

comment on column payments.method is
  'How the money came — the bank or wallet, as written on the invoice MOP line';
comment on column payments.reference_no is
  'The bank''s own transaction reference, quoted by the payer. Not the OR number.';

-- Same job as before, plus carrying those three down onto the payment rows
-- pay_reseller_account writes. They are stamped afterwards rather than passed
-- through it, so that function keeps working untouched for every other caller.
create or replace function issue_reseller_receipt(
  p_reseller bigint, p_amount numeric, p_paid_on date default current_date,
  p_method text default null, p_details text default null, p_reference text default null
) returns jsonb
language plpgsql security definer as $$
declare
  v_result  jsonb;
  v_receipt text;
  v_mark    bigint;
begin
  perform require_role('admin');

  select coalesce(max(id), 0) into v_mark from payments;
  v_result := pay_reseller_account(p_reseller, p_amount, p_paid_on);

  if p_method is not null or p_details is not null or p_reference is not null then
    update payments p
       set method = p_method, payer_details = p_details, reference_no = p_reference
      from invoices i
     where i.id = p.invoice_id
       and i.reseller_id = p_reseller
       and p.id > v_mark;
  end if;

  v_receipt := 'OR-' || to_char(now() at time zone 'Asia/Manila', 'YYYYMMDD')
               || '-' || lpad(nextval('receipt_counter')::text, 5, '0');

  insert into reseller_receipts (receipt_no, reseller_id, amount, applied, credited, paid_on)
  values (v_receipt, p_reseller, p_amount, v_result -> 'applied',
          coalesce((v_result ->> 'credited')::numeric, 0), p_paid_on);

  return v_result || jsonb_build_object('receipt_no', v_receipt);
end;
$$;

alter function issue_reseller_receipt(bigint, numeric, date, text, text, text)
  set search_path = public, extensions;
revoke all on function issue_reseller_receipt(bigint, numeric, date, text, text, text) from public;
grant execute on function issue_reseller_receipt(bigint, numeric, date, text, text, text) to app_client;

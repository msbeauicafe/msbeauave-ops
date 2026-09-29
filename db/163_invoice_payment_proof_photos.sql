-- A reseller's payment proof landed in a bucket with no thread back to the
-- payment it was proof of — every upload from Record payment's own
-- Attachment column went into the account's general file drawer instead,
-- the same drawer a tax certificate or a signed agreement sits in. Payments
-- on file could only ever show a blank icon for every row, because there
-- was nothing here to look up an actual photo by.
--
-- Purchase order's own bill payments already keep this the right way — a
-- photo filed against the one payment it belongs to, read back the moment
-- that payment's row is drawn. This is that same shape, for an invoice.

create table if not exists invoice_payment_files (
  id          bigint generated always as identity primary key,
  payment_id  bigint not null references payments (id) on delete cascade,
  mime        text   not null,
  bytes       bytea  not null,
  uploaded_by text   not null default current_actor(),
  uploaded_at timestamptz not null default now()
);
create index if not exists invoice_payment_files_by_payment
  on invoice_payment_files (payment_id);
alter table invoice_payment_files enable row level security;
drop policy if exists office_reads_invoice_payment_files on invoice_payment_files;
create policy office_reads_invoice_payment_files
  on invoice_payment_files for select
  using (current_role_name() in ('admin', 'observer', 'orderdesk'));
grant select on invoice_payment_files to app_client;

create or replace function add_invoice_payment_file(
  p_payment bigint, p_mime text, p_bytes bytea
) returns bigint
language plpgsql security definer as $$
declare v_id bigint;
begin
  perform require_role('admin', 'orderdesk');
  if not exists (select 1 from payments where id = p_payment) then
    raise exception 'There is no such payment.';
  end if;
  insert into invoice_payment_files (payment_id, mime, bytes)
  values (p_payment, p_mime, p_bytes)
  returning id into v_id;
  return v_id;
end;
$$;
alter function add_invoice_payment_file(bigint, text, bytea) set search_path = public, extensions;
grant execute on function add_invoice_payment_file(bigint, text, bytea) to app_client;

-- record_invoice_payments, unchanged apart from handing back the id each row
-- was actually written under — the id a proof photo, uploaded right after,
-- has to be filed against.
create or replace function record_invoice_payments(
  p_invoice bigint, p_payments jsonb
) returns jsonb
language plpgsql security definer as $$
declare
  inv       invoices%rowtype;
  pay       record;
  v_mark    bigint;
  v_new_id  bigint;
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
    select coalesce(max(id), 0) into v_mark from payments;
    perform record_payment(p_invoice, pay.amount, pay.paid_on);
    update payments
       set method        = coalesce(pay.method,       method),
           payer_details = coalesce(pay.details,      payer_details),
           reference_no  = coalesce(pay.reference_no, reference_no)
     where invoice_id = p_invoice and id > v_mark
    returning id into v_new_id;

    v_rows := v_rows || jsonb_build_object(
      'id', v_new_id,
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

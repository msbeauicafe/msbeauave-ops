-- ============================================================================
-- MS BEAU AVE — a bill payment carries how it came in, and its own proof
--
-- Amount and date were never the whole of a payment — how it arrived (cash,
-- GCash, a bank transfer, a card) and the screenshot or slip that proves it
-- landed are the same two facts every other payment in this app already
-- keeps. Record payment grows five rows, the same shape the reseller side's
-- Confirm the bank payment already uses for several transfers landing at
-- once, each row its own amount, date, method and proof.
-- ============================================================================

alter table purchase_order_bill_payments add column if not exists method text;
alter table purchase_order_bill_payments
  drop constraint if exists purchase_order_bill_payments_method_check;
alter table purchase_order_bill_payments
  add constraint purchase_order_bill_payments_method_check
  check (method is null or method in ('cash', 'gcash', 'bank', 'card'));

create table if not exists purchase_order_bill_payment_files (
  id          bigint generated always as identity primary key,
  payment_id  bigint not null references purchase_order_bill_payments (id) on delete cascade,
  mime        text   not null,
  bytes       bytea  not null,
  uploaded_by text   not null default current_actor(),
  uploaded_at timestamptz not null default now()
);
create index if not exists purchase_order_bill_payment_files_by_payment
  on purchase_order_bill_payment_files (payment_id);
alter table purchase_order_bill_payment_files enable row level security;
drop policy if exists stock_reads_purchase_order_bill_payment_files
  on purchase_order_bill_payment_files;
create policy stock_reads_purchase_order_bill_payment_files
  on purchase_order_bill_payment_files for select
  using (current_role_name() in ('admin', 'warehouse', 'supervisor', 'office'));
grant select on purchase_order_bill_payment_files to app_client;

-- The old four-argument signature is gone, replaced by one that also takes
-- how the payment arrived and returns the new row's id along with the
-- balance, so a proof uploaded right after has something to attach to.
drop function if exists record_bill_payment(bigint, numeric, date, text);

create or replace function record_bill_payment(
  p_bill bigint, p_amount numeric, p_paid_on date, p_method text, p_note text
) returns jsonb
language plpgsql security definer as $$
declare v_balance numeric; v_id bigint;
begin
  perform require_role('admin', 'warehouse', 'office');
  if coalesce(p_amount, 0) <= 0 then
    raise exception 'How much is coming off?';
  end if;
  if p_method is not null and p_method not in ('cash', 'gcash', 'bank', 'card') then
    raise exception 'That is not a mode of payment this shop uses.';
  end if;
  select balance into v_balance from purchase_order_bill_balances where id = p_bill;
  if not found then raise exception 'There is no bill with that number.'; end if;
  if p_amount > v_balance then
    raise exception 'Only % is still owed.', to_char(v_balance, 'FM999,999.00');
  end if;

  insert into purchase_order_bill_payments (bill_id, amount, paid_on, method, note)
  values (p_bill, p_amount, coalesce(p_paid_on, (now() at time zone 'Asia/Manila')::date),
          p_method, nullif(btrim(coalesce(p_note, '')), ''))
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'balance', v_balance - p_amount);
end;
$$;
alter function record_bill_payment(bigint, numeric, date, text, text)
  set search_path = public, extensions;
grant execute on function record_bill_payment(bigint, numeric, date, text, text) to app_client;

create or replace function add_bill_payment_file(
  p_payment bigint, p_mime text, p_bytes bytea
) returns bigint
language plpgsql security definer as $$
declare v_id bigint;
begin
  perform require_role('admin', 'warehouse', 'office');
  if not exists (select 1 from purchase_order_bill_payments where id = p_payment) then
    raise exception 'There is no such payment.';
  end if;
  insert into purchase_order_bill_payment_files (payment_id, mime, bytes)
  values (p_payment, p_mime, p_bytes)
  returning id into v_id;
  return v_id;
end;
$$;
alter function add_bill_payment_file(bigint, text, bytea) set search_path = public, extensions;
grant execute on function add_bill_payment_file(bigint, text, bytea) to app_client;

create or replace function remove_bill_payment_file(p_file bigint) returns void
language plpgsql security definer as $$
begin
  perform require_role('admin', 'warehouse', 'office');
  delete from purchase_order_bill_payment_files where id = p_file;
  if not found then raise exception 'There is no such file.'; end if;
end;
$$;
alter function remove_bill_payment_file(bigint) set search_path = public, extensions;
grant execute on function remove_bill_payment_file(bigint) to app_client;

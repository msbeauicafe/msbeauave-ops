-- ============================================================================
-- MS BEAU AVE — the supplier's own paper, photographed
-- ============================================================================
--
-- A bill so far was three facts typed in: a number, an amount, a date. The
-- paper the supplier actually handed over — invoice, receipt, a screenshot
-- of one — had nowhere to live, the same gap a payment's own proof had
-- before 125_bill_payment_method_and_proof.sql. This is that file, kept
-- against the bill itself rather than the payment.
-- ============================================================================

create table if not exists purchase_order_bill_files (
  id          bigint generated always as identity primary key,
  bill_id     bigint not null references purchase_order_bills (id) on delete cascade,
  mime        text   not null,
  bytes       bytea  not null,
  uploaded_by text   not null default current_actor(),
  uploaded_at timestamptz not null default now()
);
create index if not exists purchase_order_bill_files_by_bill
  on purchase_order_bill_files (bill_id);
alter table purchase_order_bill_files enable row level security;
drop policy if exists stock_reads_purchase_order_bill_files on purchase_order_bill_files;
create policy stock_reads_purchase_order_bill_files on purchase_order_bill_files for select
  using (current_role_name() in ('admin', 'warehouse', 'supervisor', 'office'));
grant select on purchase_order_bill_files to app_client;

create or replace function add_bill_file(p_bill bigint, p_mime text, p_bytes bytea) returns bigint
language plpgsql security definer as $$
declare v_id bigint;
begin
  perform require_role('admin', 'warehouse', 'office');
  if not exists (select 1 from purchase_order_bills where id = p_bill) then
    raise exception 'There is no such bill.';
  end if;
  insert into purchase_order_bill_files (bill_id, mime, bytes)
  values (p_bill, p_mime, p_bytes)
  returning id into v_id;
  return v_id;
end;
$$;
alter function add_bill_file(bigint, text, bytea) set search_path = public, extensions;
grant execute on function add_bill_file(bigint, text, bytea) to app_client;

create or replace function remove_bill_file(p_file bigint) returns void
language plpgsql security definer as $$
begin
  perform require_role('admin', 'warehouse', 'office');
  delete from purchase_order_bill_files where id = p_file;
  if not found then raise exception 'There is no such file.'; end if;
end;
$$;
alter function remove_bill_file(bigint) set search_path = public, extensions;
grant execute on function remove_bill_file(bigint) to app_client;

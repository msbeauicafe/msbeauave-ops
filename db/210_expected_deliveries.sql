-- Warehouse receiving management's Expected deliveries monitoring: when each
-- purchase order's delivery is expected, and how the follow-up with its
-- supplier stands — Pending, Contacted, Completed — with a note. Kept in a
-- table of its own, beside the order, so the Purchase order screen and its
-- order itself are not touched: a PO with no row here simply has no expected
-- date yet and a Pending follow-up.

create table if not exists expected_deliveries (
  po_id        bigint primary key references purchase_orders (id) on delete cascade,
  expected_on  date,
  follow_up    text not null default 'pending' check (follow_up in ('pending', 'contacted', 'completed')),
  note         text,
  updated_by   text not null default current_actor(),
  updated_at   timestamptz not null default now()
);
alter table expected_deliveries enable row level security;
revoke all on expected_deliveries from public;

drop policy if exists stock_reads_expected_deliveries on expected_deliveries;
create policy stock_reads_expected_deliveries on expected_deliveries for select
  using (current_role_name() in ('admin', 'warehouse', 'supervisor', 'office'));
grant select on expected_deliveries to app_client;

-- Set or change an order's expected delivery and follow-up: the people who
-- receive (admin, warehouse), and only for an order that is not cancelled.
create or replace function save_expected_delivery(p_po bigint, p_expected date, p_follow text, p_note text)
returns void
language plpgsql security definer as $$
declare v_follow text := coalesce(nullif(p_follow, ''), 'pending');
begin
  perform require_role('admin', 'warehouse');
  if v_follow not in ('pending', 'contacted', 'completed') then
    raise exception 'Pick the follow-up from the list.';
  end if;
  if not exists (select 1 from purchase_orders where id = p_po and status <> 'cancelled') then
    raise exception 'There is no such purchase order, or it was cancelled.';
  end if;
  insert into expected_deliveries (po_id, expected_on, follow_up, note)
  values (p_po, p_expected, v_follow, nullif(btrim(p_note), ''))
  on conflict (po_id) do update
     set expected_on = excluded.expected_on, follow_up = excluded.follow_up, note = excluded.note,
         updated_by = current_actor(), updated_at = now();
end;
$$;
alter function save_expected_delivery(bigint, date, text, text) set search_path = public, extensions;
revoke all on function save_expected_delivery(bigint, date, text, text) from public;
grant execute on function save_expected_delivery(bigint, date, text, text) to app_client;

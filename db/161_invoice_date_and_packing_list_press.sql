-- Two more things read the moment Invoice, or Packing list, was last
-- actually pressed — not the moment either first came to exist.
--
-- Invoice issued date now moves the same way Invoice no. already does:
-- pressing Invoice again re-dates it to today, the same press that can
-- move its number. A number that moved but a date that stayed behind
-- would read as two different stories about the same press.
--
-- Packing list gets its own version of the same idea. The office presses
-- Packing list on Invoice tab's own Record payment dialog to send an order
-- on to the Packing list tab — that press is now a timestamp on the order,
-- packing_list_issued_at, and Packing list itself reads newest-pressed
-- first off it, the same as Invoice tab already reads Invoice no.

alter table orders add column if not exists packing_list_issued_at timestamptz;

create or replace function commit_order(p_order bigint) returns void
language plpgsql security definer as $$
declare o orders%rowtype;
begin
  perform require_role('admin', 'orderdesk', 'warehouse');
  select * into o from orders where id = p_order for update;
  if not found then raise exception 'no such order (%)', p_order; end if;
  if o.committed_at is null then
    update orders set committed_at = now() where id = p_order;
  end if;
  perform raise_invoice(p_order);
  -- Read last, the same as the number itself — an invoice's date is when
  -- it was actually last handled, not only when it first came to exist.
  update invoices set issued_on = current_date where order_id = p_order;
  perform bump_invoice_number(p_order);
end;
$$;
alter function commit_order(bigint) set search_path = public, extensions;

create or replace function stamp_packing_list_pressed(p_order bigint) returns void
language plpgsql security definer as $$
begin
  perform require_role('admin', 'orderdesk', 'warehouse');
  update orders set packing_list_issued_at = now() where id = p_order;
end;
$$;
alter function stamp_packing_list_pressed(bigint) set search_path = public, extensions;

-- order_board, unchanged apart from carrying packing_list_issued_at along
-- at the end — create or replace view cannot reorder or insert a column
-- ahead of the ones already there, only append one.
create or replace view order_board as
select o.id, o.channel, o.status, o.total, o.placed_at, o.placed_by,
       o.delivered_at, o.reseller_id, r.name as reseller, r.tier,
       i.id as invoice_id, i.status as invoice_status, i.due_on,
       i.status = 'open' and i.due_on < current_date as invoice_overdue,
       case when current_role_name() in ('admin', 'orderdesk')
            then i.amount - i.paid - i.discount else null end as balance,
       r.tax_type, r.trade_name, r.taxpayer_name, r.tin, r.business_address,
       o.co_no, o.pl_no, i.si_no, o.shipping, o.others, o.subtotal,
       o.drop_ship, r.chat_link, r.full_name, o.parked_at,
       i.amount as invoice_amount, i.issued_on as invoice_issued_on,
       o.committed_at, o.packing_list_issued_at
  from orders o
  left join resellers r on r.id = o.reseller_id
  left join invoices i on i.order_id = o.id
 where current_role_name() in ('admin', 'warehouse', 'orderdesk');

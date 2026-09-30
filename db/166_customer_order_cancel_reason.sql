-- Pending customer order: a cancelled row says why, the same as a cancelled
-- purchase order already does. cancel_order itself is shared with the
-- Invoice tab's own Cancel and stays exactly as it was — nothing here
-- makes a reason required to cancel an order at all, only to record one
-- against it once it already is. Set from Pending customer order's own
-- Cancel button, and read back only by that screen's own Stage tag.

alter table orders add column if not exists cancel_reason text;

create or replace function set_order_cancel_reason(p_order bigint, p_reason text) returns void
language plpgsql security definer as $$
begin
  perform require_role('admin', 'orderdesk', 'warehouse', 'cashier');
  if length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'Why is this order being cancelled?';
  end if;
  update orders set cancel_reason = btrim(p_reason)
   where id = p_order and status = 'cancelled';
  if not found then
    raise exception 'that order is not cancelled';
  end if;
end;
$$;
alter function set_order_cancel_reason(bigint, text) set search_path = public, extensions;
grant execute on function set_order_cancel_reason(bigint, text) to app_client;

-- order_board, carrying cancel_reason along at the end — create or replace
-- view cannot reorder or insert a column ahead of the ones already there,
-- only append one.
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
       o.committed_at, o.packing_list_issued_at, o.cancel_reason
  from orders o
  left join resellers r on r.id = o.reseller_id
  left join invoices i on i.order_id = o.id
 where current_role_name() in ('admin', 'warehouse', 'orderdesk');

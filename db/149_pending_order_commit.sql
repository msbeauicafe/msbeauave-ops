-- Pending customer order's own Open dialog has an Invoice button now, and
-- pushing it says the office has raised the invoice and moved this order
-- along — worth recording even for a tier-1 order orderTag would otherwise
-- still call Awaiting payment on payment status alone. A plain timestamp,
-- set once; pushing Invoice again on an order already marked leaves it as
-- it was rather than erroring, the same as park_order's own idempotency.

alter table orders add column if not exists committed_at timestamptz;

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
end;
$$;
alter function commit_order(bigint) set search_path = public, extensions;

-- order_board, unchanged apart from carrying committed_at along at the end —
-- `create or replace view` refuses to reorder or insert a column ahead of
-- the ones already there, only to append one.
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
       o.committed_at
  from orders o
  left join resellers r on r.id = o.reseller_id
  left join invoices i on i.order_id = o.id
 where current_role_name() in ('admin', 'warehouse', 'orderdesk');

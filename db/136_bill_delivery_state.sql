-- ============================================================================
-- MS BEAU AVE — the Delivery column, told straight
--
-- Paid/unpaid crossed with lackings/completed answered two questions at once
-- and answered neither plainly. The order's own delivery state — the same
-- open / part / closed / cancelled the Receiving status list now shows — is
-- the one fact the Delivery column is actually for.
-- ============================================================================

-- create or replace view can only add columns at the end, not thread a new
-- one in among the old — po_status goes after last_paid_on, not up by po_no.
create or replace view purchase_order_bill_balances
  with (security_invoker = true) as
select b.*, o.po_no, s.name as supplier, s.brand_name,
       coalesce((select sum(p.amount) from purchase_order_bill_payments p
                  where p.bill_id = b.id), 0)::numeric(12,2) as paid,
       (b.amount - coalesce((select sum(p.amount) from purchase_order_bill_payments p
                              where p.bill_id = b.id), 0))::numeric(12,2) as balance,
       (select max(p.paid_on) from purchase_order_bill_payments p
         where p.bill_id = b.id) as last_paid_on,
       o.status as po_status
  from purchase_order_bills b
  join purchase_orders o on o.id = b.po_id
  join suppliers s on s.id = o.supplier_id;

grant select on purchase_order_bill_balances to app_client;

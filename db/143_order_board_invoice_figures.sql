-- The Invoice tab needs the invoice's own figures — what was actually billed
-- and when, which can differ from the order once a price is corrected on the
-- invoice (see revise-invoice) — not the order's own total and placed date.
-- order_board already joins invoices; it just never exposed these two.
--
-- `create or replace view` only ever appends, never reorders or inserts a
-- column ahead of what is already there, so these go on the tail.
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
       i.amount as invoice_amount, i.issued_on as invoice_issued_on
  from orders o
  left join resellers r on r.id = o.reseller_id
  left join invoices i on i.order_id = o.id
 where current_role_name() in ('admin', 'warehouse', 'orderdesk');

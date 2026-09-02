-- ============================================================================
-- MS BEAU AVE — the real name on the paperwork
--
-- The name a reseller is known by on Messenger is rarely the one on their ID.
-- We started keeping the real full name on the account; this carries it onto
-- the order so every paper the order becomes — the customer order form, the
-- invoice, the packing list — can print the real name beside the Messenger one,
-- smaller and lighter, the way it reads on the account list.
--
-- order_board, as db/084 left it, with the account's full name appended.
-- ============================================================================

create or replace view order_board as
select o.id, o.channel, o.status, o.total, o.placed_at, o.placed_by, o.delivered_at,
       o.reseller_id, r.name as reseller, r.tier,
       i.id as invoice_id, i.status as invoice_status, i.due_on,
       i.status = 'open' and i.due_on < current_date as invoice_overdue,
       case when current_role_name() in ('admin','orderdesk')
            then (i.amount - i.paid - i.discount) end as balance,
       r.tax_type, r.trade_name, r.taxpayer_name, r.tin, r.business_address,
       o.co_no, o.pl_no, i.si_no,
       o.shipping, o.others, o.subtotal,
       o.drop_ship, r.chat_link, r.full_name
  from orders o
  left join resellers r on r.id = o.reseller_id
  left join invoices i on i.order_id = o.id
 where current_role_name() in ('admin','warehouse','orderdesk');

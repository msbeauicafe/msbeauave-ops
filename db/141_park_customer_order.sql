-- A placed order that has sat for days without moving is not wrong, just
-- stalled — chasing a reseller for payment, waiting on a courier slot. The
-- Pending customer order list is worked from daily, so a stalled order left
-- in it is noise on a list meant to stay short. Parking sets it aside on its
-- own Draft tab without touching its stock, its invoice, or its status; it
-- comes back the same order it left.

alter table orders add column if not exists parked_at timestamptz;

create or replace function park_order(p_order bigint) returns void
language plpgsql security definer as $$
declare o orders%rowtype;
begin
  perform require_role('admin', 'orderdesk', 'warehouse');
  select * into o from orders where id = p_order for update;
  if not found then raise exception 'no such order (%)', p_order; end if;
  if o.status not in ('placed', 'picking') then
    raise exception 'that order is already % and cannot be parked', o.status;
  end if;
  if o.parked_at is not null then
    raise exception 'that order is already on Draft';
  end if;
  update orders set parked_at = now() where id = p_order;
end;
$$;
alter function park_order(bigint) set search_path = public, extensions;

create or replace function unpark_order(p_order bigint) returns void
language plpgsql security definer as $$
declare o orders%rowtype;
begin
  perform require_role('admin', 'orderdesk', 'warehouse');
  select * into o from orders where id = p_order for update;
  if not found then raise exception 'no such order (%)', p_order; end if;
  if o.parked_at is null then
    raise exception 'that order is not on Draft';
  end if;
  update orders set parked_at = null where id = p_order;
end;
$$;
alter function unpark_order(bigint) set search_path = public, extensions;

-- order_board, unchanged apart from carrying parked_at along at the end —
-- `create or replace view` refuses to reorder or insert a column ahead of
-- the ones already there, only to append one, so it goes on the tail rather
-- than sitting next to delivered_at where it reads best.
create or replace view order_board as
select o.id, o.channel, o.status, o.total, o.placed_at, o.placed_by,
       o.delivered_at, o.reseller_id, r.name as reseller, r.tier,
       i.id as invoice_id, i.status as invoice_status, i.due_on,
       i.status = 'open' and i.due_on < current_date as invoice_overdue,
       case when current_role_name() in ('admin', 'orderdesk')
            then i.amount - i.paid - i.discount else null end as balance,
       r.tax_type, r.trade_name, r.taxpayer_name, r.tin, r.business_address,
       o.co_no, o.pl_no, i.si_no, o.shipping, o.others, o.subtotal,
       o.drop_ship, r.chat_link, r.full_name, o.parked_at
  from orders o
  left join resellers r on r.id = o.reseller_id
  left join invoices i on i.order_id = o.id
 where current_role_name() in ('admin', 'warehouse', 'orderdesk');

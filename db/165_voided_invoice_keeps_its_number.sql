-- Reversing 164: a voided invoice's number turned out to be wanted for the
-- record it leaves behind, not freed for the next one to pick up. Cancelling
-- goes back to what it was before — the invoice is marked void and nothing
-- about its number, or anything above it, moves.

create or replace function cancel_order(p_order bigint) returns void
language plpgsql security definer as $$
declare o orders%rowtype; line record;
begin
  perform require_role('admin', 'orderdesk','warehouse','cashier','reseller');
  select * into o from orders where id = p_order for update;
  if not found then raise exception 'no such order (%)', p_order; end if;
  if current_role_name() = 'reseller' and o.reseller_id is distinct from current_reseller() then
    raise exception 'FORBIDDEN: that is not your order' using errcode = '42501';
  end if;
  if o.status not in ('placed','picking') then
    raise exception 'that order is already % and cannot be cancelled', o.status;
  end if;

  for line in
    select batch_id, sum(qty) as qty from order_lines
     where order_id = p_order group by batch_id order by batch_id
  loop
    update stock set committed = committed - line.qty
     where batch_id = line.batch_id and pool = 'shop' and branch_id = o.branch_id;
  end loop;

  update orders set status = 'cancelled' where id = p_order;
  update invoices set status = 'void'
   where order_id = p_order and status = 'open' and paid = 0;
end;
$$;
alter function cancel_order(bigint) set search_path = public, extensions;

-- Nothing else calls it any more.
drop function if exists close_voided_invoice_gap(bigint);

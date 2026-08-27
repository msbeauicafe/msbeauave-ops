-- An invoice can be corrected without being cancelled and raised again.
--
-- The sheet is filled from the order, and the order is filled from a basket
-- typed while somebody is reading a chat window. So the figures on it are
-- right most of the time and wrong some of the time: a price agreed in the
-- conversation and not in the price list, a delivery fee nobody knew about
-- until the rider quoted it, a discount the owner gave on the phone. Until now
-- the only way to fix any of that was to cancel the order, which puts the
-- stock back on sale and loses the number the reseller already has.
--
-- Shipping and Others were on the printed sheet from the beginning, and were
-- always zero, because there was nowhere to put them.
alter table orders add column if not exists shipping numeric(12,2) not null default 0
  check (shipping >= 0);
alter table orders add column if not exists others numeric(12,2) not null default 0
  check (others >= 0);

-- ---------------------------------------------------------------------------
-- Prices, shipping and Others. Not quantities, and not which products.
--
-- What is picked belongs to the order, and stock is held against it from the
-- moment it is placed. Letting the invoice screen change a quantity would let
-- the paperwork quietly disagree with what the bench is holding — the invoice
-- would say four and the box would have six, and the difference would surface
-- as a shortage weeks later with nothing to trace it to. Changing what is
-- picked is done on the order, where the stock moves with it.
--
-- Money is different. Nothing physical follows a price, so a price can be
-- corrected on the document that charges it.
-- ---------------------------------------------------------------------------
create or replace function revise_invoice(
  p_order bigint,
  p_lines jsonb default '[]'::jsonb,
  p_shipping numeric default null,
  p_others numeric default null)
returns jsonb language plpgsql security definer as $$
declare
  o orders%rowtype; v_inv invoices%rowtype;
  v_sub numeric(12,2); v_total numeric(12,2);
  v_ship numeric(12,2); v_oth numeric(12,2); v_settled numeric(12,2);
begin
  perform require_role('admin', 'office');

  select * into o from orders where id = p_order for update;
  if o.id is null then raise exception 'No such order.'; end if;
  if o.channel <> 'b2b' then
    raise exception 'A counter sale has a receipt, not an invoice.';
  end if;
  if o.status = 'cancelled' then
    raise exception 'That order was cancelled. Nothing is owed on it.';
  end if;

  select * into v_inv from invoices where order_id = p_order for update;
  if v_inv.id is not null and v_inv.status = 'void' then
    raise exception 'That invoice was voided. Raise a new one rather than editing it.';
  end if;

  update order_lines l
     set unit_price = (x ->> 'price')::numeric
    from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) x
   where l.id = (x ->> 'id')::bigint
     and l.order_id = p_order
     and (x ->> 'price')::numeric >= 0;

  v_ship := coalesce(p_shipping, o.shipping);
  v_oth  := coalesce(p_others,   o.others);
  if v_ship < 0 or v_oth < 0 then
    raise exception 'Shipping and Others cannot be less than nothing.';
  end if;

  select coalesce(sum(qty * unit_price), 0) into v_sub
    from order_lines where order_id = p_order;
  v_total := v_sub + v_ship + v_oth;

  update orders
     set subtotal = v_sub, total = v_total, shipping = v_ship, others = v_oth
   where id = p_order;

  if v_inv.id is not null then
    -- Money already taken is the floor. An invoice revised below what has been
    -- settled against it owes the reseller a refund, and a refund is a
    -- decision somebody makes on purpose, not a side effect of a typo in a
    -- price box.
    v_settled := v_inv.paid + v_inv.discount;
    if v_total < v_settled then
      raise exception 'REVISED_BELOW_PAID: that comes to %, and % has already been settled against this invoice.',
        to_char(v_total, 'FM999,999,990.00'), to_char(v_settled, 'FM999,999,990.00');
    end if;

    update invoices
       set amount = v_total,
           status = case when v_total <= v_settled then 'paid' else 'open' end,
           settled_on = case when v_total <= v_settled
                             then coalesce(settled_on, current_date) end
     where id = v_inv.id;
  end if;

  return jsonb_build_object(
    'order_id', p_order, 'invoice_id', v_inv.id, 'si_no', v_inv.si_no,
    'subtotal', v_sub, 'shipping', v_ship, 'others', v_oth, 'total', v_total);
end $$;

alter function revise_invoice(bigint, jsonb, numeric, numeric)
  set search_path = public, extensions;
revoke all on function revise_invoice(bigint, jsonb, numeric, numeric) from public;
grant execute on function revise_invoice(bigint, jsonb, numeric, numeric) to app_client;

-- Shipping and Others have to reach the screen that prints them.
create or replace view order_board as
select o.id, o.channel, o.status, o.total, o.placed_at, o.placed_by, o.delivered_at,
       o.reseller_id, r.name as reseller, r.tier,
       i.id as invoice_id, i.status as invoice_status, i.due_on,
       i.status = 'open' and i.due_on < current_date as invoice_overdue,
       case when current_role_name() = 'admin'
            then (i.amount - i.paid - i.discount) end as balance,
       r.tax_type, r.trade_name, r.taxpayer_name, r.tin, r.business_address,
       o.co_no, o.pl_no, i.si_no,
       o.shipping, o.others, o.subtotal
  from orders o
  left join resellers r on r.id = o.reseller_id
  left join invoices i on i.order_id = o.id
 where current_role_name() in ('admin','warehouse');

grant select on order_board to app_client;

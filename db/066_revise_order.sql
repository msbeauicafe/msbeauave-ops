-- What actually goes in the box, corrected on the sheet that travels with it.
--
-- The packing list is the last document anybody reads before the goods leave.
-- It is also the first place a difference shows up: two were ordered and only
-- one is on the shelf worth sending, or the reseller adds something over chat
-- while the box is still open. Until now the sheet could not say so. Correcting
-- it meant cancelling the whole order — which puts every line back on sale and
-- loses the customer order number the reseller already has in front of them.
--
-- 063 made prices correctable and said, in as many words, that quantities are
-- not the invoice's business: what is picked belongs to the order, because
-- stock is held against it from the moment it is placed. This is that other
-- half. Quantities change here, on the order, and the stock moves with them.
--
-- ---------------------------------------------------------------------------
-- The payload is the whole picture, by product
--
-- p_lines is what goes in the box when the sheet is signed — not a list of
-- adjustments. A product on the order and missing from the picture is a
-- product that is not going. That is what the paper means: the checker reads
-- the sheet, and what is not on the sheet is not in the box.
--
-- By product rather than by picked line, because a line is a batch and a batch
-- is not a decision anybody makes on a packing list. Three of something may sit
-- on two rows because they came from two deliveries; the person shortening it
-- to two is not choosing which delivery to keep. So the function chooses, and
-- chooses the way the warehouse already works: what leaves is what expires
-- soonest, so a reduction comes off the longest-dated batch and the oldest
-- stock still ships.
-- ---------------------------------------------------------------------------
create or replace function revise_order(p_order bigint, p_lines jsonb)
returns jsonb language plpgsql security definer as $$
declare
  o        orders%rowtype;
  v_inv    invoices%rowtype;
  want     record;
  row_     record;
  v_left   int;
  v_take   int;
  v_price  numeric(12,2);
  v_code   text;
  v_cost   numeric(12,2);
  v_cutoff date;
  v_sub    numeric(12,2);
  v_total  numeric(12,2);
  v_settled numeric(12,2);
begin
  perform require_role('admin', 'office');

  select * into o from orders where id = p_order for update;
  if o.id is null then raise exception 'No such order.'; end if;

  -- Once it is fulfilled the goods are gone. A sheet cannot call them back,
  -- and a return is its own document with its own reasons.
  if o.status not in ('placed', 'picking') then
    raise exception 'ALREADY_GONE: that order is % — the stock has left the building, so the packing list cannot change it.', o.status;
  end if;

  select * into v_inv from invoices where order_id = p_order for update;
  if v_inv.id is not null and v_inv.status = 'void' then
    raise exception 'That invoice was voided. Raise a new one rather than editing it.';
  end if;

  -- An order with nothing in it is a cancellation, and a cancellation is a
  -- decision somebody makes on purpose — it puts stock back on sale and voids
  -- the invoice. Emptying every row of a sheet must not do that quietly.
  if coalesce((select sum(greatest((x ->> 'qty')::int, 0))
                 from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) x), 0) <= 0 then
    raise exception 'NOTHING_LEFT: an order with nothing in it is a cancellation. Cancel it on the order itself.';
  end if;

  for want in
    with asked as (
      select btrim(x ->> 'sku') as sku,
             sum(greatest(coalesce((x ->> 'qty')::int, 0), 0))::int as qty
        from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) x
       where btrim(coalesce(x ->> 'sku', '')) <> ''
       group by 1
    ),
    held as (
      select sku, sum(qty)::int as qty
        from order_lines where order_id = p_order group by 1
    )
    select coalesce(a.sku, h.sku)  as sku,
           coalesce(a.qty, 0)::int as wanted,
           coalesce(h.qty, 0)::int as picked
      from asked a
      full join held h on h.sku = a.sku
     order by 1
  loop
    continue when want.wanted = want.picked;

    -- --------------------------------------------------------------------
    -- Fewer than are held: give the difference back to the shelf
    -- --------------------------------------------------------------------
    if want.wanted < want.picked then
      v_left := want.picked - want.wanted;
      for row_ in
        select l.id, l.qty, l.batch_id
          from order_lines l
          join batches b on b.id = l.batch_id
         where l.order_id = p_order and l.sku = want.sku
         order by b.expiry desc, b.id desc
           for update of l
      loop
        exit when v_left <= 0;
        v_take := least(row_.qty, v_left);
        update stock set committed = committed - v_take
         where batch_id = row_.batch_id and pool = o.channel
           and branch_id = o.branch_id;
        if v_take = row_.qty then
          delete from order_lines where id = row_.id;
        else
          update order_lines set qty = qty - v_take where id = row_.id;
        end if;
        v_left := v_left - v_take;
      end loop;
      continue;
    end if;

    -- --------------------------------------------------------------------
    -- More than are held: hold the difference, soonest to expire first
    -- --------------------------------------------------------------------
    if not exists (select 1 from products where sku = want.sku and active) then
      raise exception 'NO_SUCH_PRODUCT: there is no product with code %.', want.sku;
    end if;

    -- A price already on this order stays on it. The office may have corrected
    -- it on the invoice, and adding a unit to a line is not a reason to hand
    -- back the figure the reseller already agreed to.
    select unit_price, price_code into v_price, v_code
      from order_lines where order_id = p_order and sku = want.sku limit 1;
    if v_price is null then
      v_price := effective_price(want.sku, o.channel);
      v_code  := null;
    end if;
    select unit_cost into v_cost from products where sku = want.sku;

    v_cutoff := earliest_usable_expiry(o.channel, want.sku);
    v_left   := want.wanted - want.picked;

    for row_ in
      select s.id, s.on_hand, s.committed, s.batch_id
        from stock s
        join batches b on b.id = s.batch_id
       where s.pool = o.channel and s.branch_id = o.branch_id
         and b.sku = want.sku and b.expiry > v_cutoff
       order by b.expiry, b.id
         for update of s
    loop
      exit when v_left <= 0;
      v_take := least(row_.on_hand - row_.committed, v_left);
      if v_take > 0 then
        update stock set committed = committed + v_take where id = row_.id;
        -- Onto the line already holding that batch where there is one, so a
        -- sheet does not grow a second row for the same product and batch
        -- every time somebody adds one more.
        update order_lines set qty = qty + v_take
         where order_id = p_order and sku = want.sku and batch_id = row_.batch_id;
        if not found then
          insert into order_lines (order_id, sku, batch_id, qty, unit_price,
                                   unit_cost, price_code)
          values (p_order, want.sku, row_.batch_id, v_take, v_price, v_cost, v_code);
        end if;
        v_left := v_left - v_take;
      end if;
    end loop;

    if v_left > 0 then
      raise exception 'NOT_ENOUGH_STOCK: % is short % unit(s) of what the sheet asks for.',
        want.sku, v_left using errcode = 'P0002';
    end if;
  end loop;

  select coalesce(sum(qty * unit_price), 0) into v_sub
    from order_lines where order_id = p_order;
  v_total := v_sub + o.shipping + o.others;

  update orders set subtotal = v_sub, total = v_total where id = p_order;

  if v_inv.id is not null then
    -- The same floor 063 put under the invoice: money already taken cannot be
    -- undone by a sheet. Sending less than was paid for is a refund, and a
    -- refund is a decision, not a side effect of a quantity box.
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
    'pl_no', o.pl_no, 'subtotal', v_sub, 'total', v_total);
end $$;

alter function revise_order(bigint, jsonb) set search_path = public, extensions;
revoke all on function revise_order(bigint, jsonb) from public;
grant execute on function revise_order(bigint, jsonb) to app_client;

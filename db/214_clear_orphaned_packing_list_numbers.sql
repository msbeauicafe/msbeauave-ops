-- db/213 removed checkout-time invoices but left the orders' packing list
-- numbers behind. A packing list number mirrors its invoice's (db/171:
-- SI26_10_044 ↔ PL26_10_044), so an order with no invoice must carry none —
-- the leftover one was still held by the undone order, and the next invoice
-- raised, handed that same freed SI number, could not give its order the
-- matching PL number: "That already exists" on pressing Invoice.
--
-- Every order with no invoice is put back in line with db/171's rule, and
-- the cleanup function is corrected so it clears the number with the invoice.

update orders set pl_no = null
 where channel = 'b2b' and pl_no is not null
   and not exists (select 1 from invoices i where i.order_id = orders.id);

create or replace function undo_checkout_invoices() returns jsonb
language plpgsql security definer as $$
declare
  i record; v_back numeric(12,2); v_done jsonb := '[]'::jsonb; v_kept jsonb := '[]'::jsonb;
begin
  for i in
    select inv.id, inv.si_no, inv.reseller_id, inv.order_id, o.co_no
      from invoices inv join orders o on o.id = inv.order_id
     where o.channel = 'b2b' and o.committed_at is null and o.status = 'placed'
     order by inv.id
  loop
    if exists (select 1 from payments p where p.invoice_id = i.id
                and (p.recorded_by <> 'credit balance' or p.receipt_id is not null))
       or exists (select 1 from invoice_pending_payments x where x.invoice_id = i.id)
       or exists (select 1 from invoice_payment_overflow x
                   where x.source_invoice_id = i.id or x.target_invoice_id = i.id) then
      v_kept := v_kept || jsonb_build_object('co_no', i.co_no, 'si_no', i.si_no);
      raise notice 'Left as it is — a real payment is recorded on it: % / %', i.co_no, i.si_no;
      continue;
    end if;

    select coalesce(sum(amount), 0) into v_back from payments where invoice_id = i.id;
    if v_back > 0 then
      insert into reseller_credits (reseller_id, amount, reason, recorded_by)
      values (i.reseller_id, v_back,
              format('Given back: drawn automatically at portal checkout for %s (%s), whose invoice is undone — the order waits for Invoice on Pending customer order.',
                     i.co_no, i.si_no),
              'db/213 cleanup');
      delete from payments where invoice_id = i.id;
    end if;
    delete from invoices where id = i.id;
    -- Its packing list number mirrored that invoice's, so it goes with it.
    update orders set pl_no = null where id = i.order_id;
    v_done := v_done || jsonb_build_object('co_no', i.co_no, 'si_no', i.si_no, 'funds_back', v_back);
    raise notice 'Undone: % / % — Funds given back: %', i.co_no, i.si_no, v_back;
  end loop;
  return jsonb_build_object('undone', v_done, 'kept', v_kept);
end;
$$;
alter function undo_checkout_invoices() set search_path = public, extensions;
revoke all on function undo_checkout_invoices() from public;

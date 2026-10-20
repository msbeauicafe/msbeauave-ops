-- Cleanup after db/212. Before it, a reseller's portal checkout raised its
-- invoice on the spot and, with Funds on file, paid it from them on the spot
-- too — so an order still Awaiting payment on Pending customer order could
-- already show on the Invoice tab, even as paid (CO26_10_046, ₱1,220 off
-- Angel Austria's Funds). The owner asked for every such order to be put
-- back the way db/212 now places them: on Pending customer order with no
-- invoice yet, and any Funds drawn automatically given back.
--
-- Which invoices: a wholesale order not yet pushed through Invoice
-- (committed_at null) and still placed. Staff orders never had an invoice at
-- that point, so these are exactly the checkout-time ones.
--
-- What is undone, per invoice: the automatic Funds payments (recorded by
-- 'credit balance') are removed and the same amount goes back to the
-- account's Funds; then the invoice itself is removed. An invoice anybody
-- has recorded a real payment against, a pending payment, a receipt or an
-- overflow on is left exactly as it is and named in a notice instead.
--
-- A function so the same steps can be checked by the tests; run once below.
-- Nobody is granted it.

create or replace function undo_checkout_invoices() returns jsonb
language plpgsql security definer as $$
declare
  i record; v_back numeric(12,2); v_done jsonb := '[]'::jsonb; v_kept jsonb := '[]'::jsonb;
begin
  for i in
    select inv.id, inv.si_no, inv.reseller_id, o.co_no
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
    v_done := v_done || jsonb_build_object('co_no', i.co_no, 'si_no', i.si_no, 'funds_back', v_back);
    raise notice 'Undone: % / % — Funds given back: %', i.co_no, i.si_no, v_back;
  end loop;
  return jsonb_build_object('undone', v_done, 'kept', v_kept);
end;
$$;
alter function undo_checkout_invoices() set search_path = public, extensions;
revoke all on function undo_checkout_invoices() from public;

select undo_checkout_invoices();

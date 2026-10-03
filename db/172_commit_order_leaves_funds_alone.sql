-- raise_invoice (047) does two things when an invoice is first created:
-- raises it, and — if the account already has credit sitting on file —
-- draws down as much of it as the new invoice can take, on the spot. That
-- second half is exactly right for a reseller checking out on their own
-- portal (place_order, 157): there is no Invoice button waiting for them
-- afterwards, the checkout is the whole transaction, so it pays the same
-- way it always has.
--
-- It is not right for staff pressing Invoice on Pending customer order
-- (commit_order, the only other caller) — placing an order there, then
-- pressing Invoice, should not reach into Funds on its own. Funds stays
-- untouched until a bank payment is actually recorded against the
-- invoice with its Mode of payment set to FUNDS, below.
--
-- raise_invoice itself is untouched — place_order still calls it, credit
-- draw and all. commit_order calls this new, narrower copy instead: the
-- same invoice-raising half, none of the credit-draw half.
create or replace function raise_invoice_no_credit_draw(p_order bigint) returns void
language plpgsql security definer as $$
declare
  o orders%rowtype; v_terms int;
begin
  select * into o from orders where id = p_order;
  if o.channel <> 'b2b' or o.reseller_id is null then return; end if;

  select case when tier = 1 then 0 else terms_days end
    into v_terms from resellers where id = o.reseller_id;

  insert into invoices (order_id, reseller_id, due_on, amount)
  values (p_order, o.reseller_id, current_date + v_terms, o.total)
  on conflict (order_id) do nothing;
end;
$$;
alter function raise_invoice_no_credit_draw(bigint) set search_path = public, extensions;

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
  perform raise_invoice_no_credit_draw(p_order);
  update invoices set issued_on = current_date where order_id = p_order;
  perform bump_invoice_number(p_order);
end;
$$;
alter function commit_order(bigint) set search_path = public, extensions;

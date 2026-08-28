-- The invoice number, typed.
--
-- 062 gave every document a number of its own and a counter that hands out the
-- next one. That is right for the ordinary case and wrong for the ones that
-- matter most: an invoice raised against a BIR booklet whose printed number
-- has to be the one on the sheet, a number quoted to a reseller before
-- somebody noticed the month had rolled over, a gap left by an order that was
-- cancelled and has to be filled by hand to keep a series unbroken.
--
-- None of those can be reached by cancelling and re-raising, because the
-- counter only ever goes forwards. So the number becomes something the office
-- can write, and the counter goes on from whatever is written: next_si_no()
-- reads the highest number in the month rather than counting rows, so setting
-- SI26_08_050 makes the next one 051 by itself. Nothing has to be told.
--
-- Any text, not a shape. Forcing SI26_08_001 here would defeat the point —
-- the reason to type a number at all is usually that it has to match a book
-- this system did not print.
--
-- The unique index 062 put on si_no is what stops two invoices sharing one
-- number. It is a constraint rather than a check in this function on purpose:
-- two people typing the same number in the same second have to lose one of the
-- two, and only the index can say which.
create or replace function set_invoice_no(p_order bigint, p_no text)
returns jsonb language plpgsql security definer as $$
declare v_inv invoices%rowtype; v_new text; v_was text;
begin
  perform require_role('admin', 'office');

  v_new := upper(btrim(coalesce(p_no, '')));
  if v_new = '' then
    raise exception 'NO_DOC_NO: an invoice has to carry a number. Type the one it should have.';
  end if;

  select * into v_inv from invoices where order_id = p_order for update;
  if v_inv.id is null then
    raise exception 'NO_INVOICE: no invoice has been raised against that order yet.';
  end if;
  v_was := v_inv.si_no;
  if v_was is not distinct from v_new then
    return jsonb_build_object('si_no', v_new, 'changed', false);
  end if;

  begin
    update invoices set si_no = v_new where id = v_inv.id;
  exception when unique_violation then
    raise exception 'DUPLICATE_DOC_NO: % is already on another invoice.', v_new;
  end;

  -- invoices carries an audit trigger, so the change is on the record either
  -- way; this puts it where somebody looking at the account will find it,
  -- beside the credit decisions and the tax details.
  insert into reseller_events (reseller_id, kind, detail)
  values (v_inv.reseller_id, 'invoice_renumbered',
          jsonb_build_object('order_id', p_order, 'from', v_was, 'to', v_new));

  return jsonb_build_object('si_no', v_new, 'was', v_was, 'changed', true);
end $$;

alter function set_invoice_no(bigint, text) set search_path = public, extensions;
revoke all on function set_invoice_no(bigint, text) from public;
grant execute on function set_invoice_no(bigint, text) to app_client;

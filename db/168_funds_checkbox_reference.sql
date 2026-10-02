-- Invoice tab's own Record payment dialog: a "Funds" checkbox lets the
-- office apply the account's own existing credit to the invoice being paid,
-- the same one-click shortcut a bank reference already gets. Ticking it
-- needs to carry over the reference the original payment was entered under,
-- so the paper trail still reads as one payment traced back to one bank
-- transfer, not a number invented here. invoice_payment_overflow (db/167)
-- never had anywhere to keep that; this is the only thing this file adds.

alter table invoice_payment_overflow add column if not exists reference_no text;

create or replace function log_invoice_payment_overflow(
  p_reseller bigint, p_source bigint, p_target bigint, p_amount numeric,
  p_reference_no text default null
) returns bigint
language plpgsql security definer as $$
declare v_id bigint;
begin
  perform require_role('admin', 'orderdesk');
  if p_amount <= 0 then raise exception 'Nothing to log.'; end if;
  insert into invoice_payment_overflow
    (reseller_id, source_invoice_id, target_invoice_id, amount, reference_no)
  values (p_reseller, p_source, p_target, p_amount, p_reference_no)
  returning id into v_id;
  return v_id;
end;
$$;
alter function log_invoice_payment_overflow(bigint, bigint, bigint, numeric, text)
  set search_path = public, extensions;
grant execute on function log_invoice_payment_overflow(bigint, bigint, bigint, numeric, text)
  to app_client;

-- The four-argument form a moment ago is replaced outright, not kept
-- alongside the five-argument one — nothing else has ever called it, since
-- this function was only ever this dialog's own, written in db/167 the same
-- session.
drop function if exists log_invoice_payment_overflow(bigint, bigint, bigint, numeric);

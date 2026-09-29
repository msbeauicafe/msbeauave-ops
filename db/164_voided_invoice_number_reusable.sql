-- A voided invoice used to keep its number forever — the accepted practice
-- for a printed, issued document, but this shop's numbers are not printed
-- until Invoice is pressed, and cancelling before anything was ever paid is
-- not the same as a document that went out the door wrong. The owner wants
-- the gap closed rather than left behind: voiding one now frees its number,
-- the same "close the gap behind it" shift bump_invoice_number already does
-- for a press, run here for a void instead. A hand-written number is still
-- never touched — it was never on the automatic counter to begin with.

create or replace function close_voided_invoice_gap(p_invoice bigint) returns void
language plpgsql security definer as $$
declare
  v_invoice invoices%rowtype;
  v_prefix text;
  v_old_n int;
  v_ids bigint[];
  v_ns int[];
  v_new_n int;
  i int;
begin
  select * into v_invoice from invoices where id = p_invoice for update;
  if v_invoice.id is null or v_invoice.si_no is null or v_invoice.si_no_manual then
    return;
  end if;

  v_prefix := substring(v_invoice.si_no from '^SI\d\d_\d\d_');
  if v_prefix is null then
    return;
  end if;

  perform pg_advisory_xact_lock(hashtext('bump_si:' || v_prefix));

  v_old_n := (substring(v_invoice.si_no from '\d+$'))::int;

  select array_agg(id order by n), array_agg(n order by n)
    into v_ids, v_ns
    from (
      select id, (substring(si_no from '\d+$'))::int as n
        from invoices
       where si_no_manual = false and id <> v_invoice.id
         and si_no ~ ('^' || v_prefix || '\d{3}$')
         and (substring(si_no from '\d+$'))::int > v_old_n
    ) x;

  -- Cleared first, the voided invoice's own slot included — freed rather
  -- than reused by anything still being shifted into place.
  update invoices set si_no = null where id = any(v_ids) or id = v_invoice.id;

  if v_ids is not null then
    for i in 1 .. array_length(v_ids, 1) loop
      v_new_n := v_ns[i] - 1;
      while exists (
        select 1 from invoices where si_no = v_prefix || lpad(v_new_n::text, 3, '0')
      ) loop
        v_new_n := v_new_n - 1;
      end loop;
      update invoices set si_no = v_prefix || lpad(v_new_n::text, 3, '0')
       where id = v_ids[i];
    end loop;
  end if;
end;
$$;
alter function close_voided_invoice_gap(bigint) set search_path = public, extensions;

create or replace function cancel_order(p_order bigint) returns void
language plpgsql security definer as $$
declare o orders%rowtype; line record; v_invoice_id bigint;
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
   where order_id = p_order and status = 'open' and paid = 0
  returning id into v_invoice_id;

  if v_invoice_id is not null then
    perform close_voided_invoice_gap(v_invoice_id);
  end if;
end;
$$;
alter function cancel_order(bigint) set search_path = public, extensions;

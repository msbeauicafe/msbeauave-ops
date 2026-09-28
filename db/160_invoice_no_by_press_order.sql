-- Invoice no. reads the order Invoice was actually pressed in, not the
-- order the invoice happened to be raised in. Pressing Invoice on an order
-- that already carries one — the ordinary case, once 157 moved raising to
-- that same press — moves its number to the newest slot in its own month,
-- same as a brand new one landing there. Whoever presses last is read last,
-- and everything between its old spot and the top closes up behind it so
-- the month's own numbers stay one unbroken run.
--
-- A number the office wrote by hand (067) is a promise about a piece of
-- paper already printed — a BIR booklet page, most often — and paper does
-- not renumber itself because the screen pressed a button again. It stays
-- exactly where it was put, forever; everything else moves around it.

alter table invoices add column if not exists si_no_manual boolean not null default false;

-- set_invoice_no, unchanged apart from marking what it just wrote as a
-- number the automatic side must never touch again.
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
    update invoices set si_no = v_new, si_no_manual = true where id = v_inv.id;
  exception when unique_violation then
    raise exception 'DUPLICATE_DOC_NO: % is already on another invoice.', v_new;
  end;

  insert into reseller_events (reseller_id, kind, detail)
  values (v_inv.reseller_id, 'invoice_renumbered',
          jsonb_build_object('order_id', p_order, 'from', v_was, 'to', v_new));

  return jsonb_build_object('si_no', v_new, 'was', v_was, 'changed', true);
end $$;
alter function set_invoice_no(bigint, text) set search_path = public, extensions;
revoke all on function set_invoice_no(bigint, text) from public;
grant execute on function set_invoice_no(bigint, text) to app_client;

-- Moves one invoice to the newest slot in its own month. Only what sat
-- between its old spot and the top has to shift — one slot down each, to
-- close the gap the move leaves — so a manual number below the old spot,
-- or above nothing at all, is never touched or asked to move. The counter
-- a manual number seeds for whatever gets raised after it (067) survives
-- for exactly the same reason: nothing here ever renumbers down past a
-- number nothing is displacing it from.
create or replace function bump_invoice_number(p_order bigint) returns void
language plpgsql security definer as $$
declare
  v_invoice invoices%rowtype;
  v_prefix text;
  v_old_n int;
  v_max_n int;
  v_ids bigint[];
  v_ns int[];
  i int;
begin
  select * into v_invoice from invoices where order_id = p_order for update;
  if v_invoice.id is null or v_invoice.si_no_manual then
    return;
  end if;

  v_prefix := substring(v_invoice.si_no from '^SI\d\d_\d\d_');
  if v_prefix is null then
    return;
  end if;

  perform pg_advisory_xact_lock(hashtext('bump_si:' || v_prefix));

  v_old_n := (substring(v_invoice.si_no from '\d+$'))::int;

  select max((substring(si_no from '\d+$'))::int) into v_max_n
    from invoices
   where si_no_manual = false and si_no ~ ('^' || v_prefix || '\d{3}$');

  -- Already the newest — or something has gone stranger than this
  -- function should try to fix. Either way, nothing to move.
  if v_max_n is null or v_old_n >= v_max_n then
    return;
  end if;

  select array_agg(id order by n), array_agg(n order by n)
    into v_ids, v_ns
    from (
      select id, (substring(si_no from '\d+$'))::int as n
        from invoices
       where si_no_manual = false and si_no ~ ('^' || v_prefix || '\d{3}$')
         and (substring(si_no from '\d+$'))::int > v_old_n
    ) x;

  -- Cleared first: reassigning in the new order would otherwise ask an
  -- early row to take a number a later row, not yet touched, is still
  -- holding. si_no is nullable and only uniquely constrained while it is
  -- not null, which is what makes clearing it first safe.
  update invoices set si_no = null where id = any(v_ids) or id = v_invoice.id;

  if v_ids is not null then
    for i in 1 .. array_length(v_ids, 1) loop
      update invoices set si_no = v_prefix || lpad((v_ns[i] - 1)::text, 3, '0')
       where id = v_ids[i];
    end loop;
  end if;

  update invoices set si_no = v_prefix || lpad(v_max_n::text, 3, '0')
   where id = v_invoice.id;
end;
$$;
alter function bump_invoice_number(bigint) set search_path = public, extensions;

-- Pressing Invoice is what moves a number now, on top of what raising one
-- already does — including the ordinary case, an order that already
-- carries an invoice, where raise_invoice itself has nothing left to do.
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
  perform raise_invoice(p_order);
  perform bump_invoice_number(p_order);
end;
$$;
alter function commit_order(bigint) set search_path = public, extensions;

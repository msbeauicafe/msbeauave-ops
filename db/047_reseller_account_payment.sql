-- ============================================================================
-- One payment, against the whole account — not one invoice at a time
--
-- Brought on by reading the paper the shop actually runs on: a customer order
-- book kept by hand in a spreadsheet, one tab per order, with a running
-- tracker of what came in against what was billed. It works, and the
-- arithmetic in it is right — but two things happen in it that this system
-- could not do at all before this file:
--
--   1. A single payment settles more than one invoice. Somebody sends
--      ₱445,310 and it happens to cover an old order and most of a new one.
--      record_payment(invoice, amount) needs to be told which invoice and how
--      much of the money is theirs — the split is arithmetic somebody has to
--      do by hand first, off a memory of what is still open.
--
--   2. Money arrives ahead of what is owed. In the paper book this reads as
--      one invoice "paid" for more than its own total, with the extra sitting
--      there unexplained until somebody remembers it next time that customer
--      orders. Nothing here held it as theirs; it was just a number that
--      didn't add up.
--
-- pay_reseller_account does the first: given a reseller and an amount, it pays
-- down their open invoices oldest first, the way a person doing this by hand
-- naturally would, until the money runs out. Whatever is left over becomes a
-- credit on the account rather than a mystery on an invoice — reseller_credits
-- is a ledger, not a balance column, for the same reason movements and
-- reseller_events are: a number anybody can read is worth less than a number
-- anybody can trace.
--
-- raise_invoice is the second half. A reseller carrying a credit is not asked
-- to pay again for what they have already sent; the moment their next invoice
-- exists, whatever credit is on their account is drawn down against it first.
-- ============================================================================

create table reseller_credits (
  id          bigint generated always as identity primary key,
  reseller_id bigint not null references resellers (id),
  -- Positive: money arrived with nothing left to apply it to. Negative: an
  -- earlier credit was drawn down against a new invoice. The balance is
  -- never stored — it is the sum of this ledger, always recomputed, the same
  -- discipline as amount_outstanding().
  amount      numeric(12,2) not null check (amount <> 0),
  reason      text not null,
  recorded_by text not null default current_actor(),
  at          timestamptz not null default now()
);
create index reseller_credits_by_reseller on reseller_credits (reseller_id);
create trigger reseller_credits_audit after insert or update or delete on reseller_credits
  for each row execute function write_audit();

alter table reseller_credits enable row level security;
create policy admin_reads_credits on reseller_credits for select
  using (current_role_name() = 'admin');
create policy reseller_reads_own_credits on reseller_credits for select
  using (current_role_name() = 'reseller' and reseller_id = current_reseller());

-- db/003_views_and_access.sql grants select on "all tables in schema public"
-- to app_client — but that grant ran once, against the tables that existed
-- that day. A table created here is not covered by a statement that already
-- executed, and the API reads this one directly rather than through a
-- function, so without this line every read comes back as a bare permission
-- error, RLS never even reached. This is exactly what happened while writing
-- this file: GET /api/resellers/:id failed for every account, not just the
-- ones with a credit to show.
grant select on reseller_credits to app_client;

create or replace function reseller_credit_balance(p_reseller bigint)
returns numeric language sql stable security definer as $$
  select coalesce(sum(amount), 0) from reseller_credits where reseller_id = p_reseller;
$$;

-- ---------------------------------------------------------------------------
-- Pay down an account, oldest invoice first, until the money runs out.
--
-- This does not call record_payment() and does not replace it — a payment
-- against one named invoice is still exactly that function, unchanged, and
-- every test written against it keeps meaning what it always meant. This is
-- the other shape of the same action: what happens when a payment arrives
-- for the account rather than for an invoice, which is what actually landed
-- in the bank. The two duplicate a little arithmetic rather than share a
-- function neither fully needed, the same trade clock_toggle's two-argument
-- wrapper made and for the same reason: touching the function four tests
-- already trust is a bigger risk than a dozen repeated lines.
-- ---------------------------------------------------------------------------
create or replace function pay_reseller_account(
  p_reseller bigint, p_amount numeric, p_paid_on date default current_date
) returns jsonb
language plpgsql security definer as $$
declare
  r             resellers%rowtype;
  inv           invoices%rowtype;
  v_left        numeric(12,2) := p_amount;
  v_take        numeric(12,2);
  v_discount    numeric(12,2);
  v_applied     jsonb := '[]'::jsonb;
  v_settled_any boolean := false;
begin
  perform require_role('admin');
  if p_amount <= 0 then raise exception 'A payment must be more than zero.'; end if;

  select * into r from resellers where id = p_reseller for update;
  if not found then raise exception 'No such account (%).', p_reseller; end if;

  for inv in
    select * from invoices
     where reseller_id = p_reseller and status = 'open'
     order by issued_on, id
       for update
  loop
    exit when v_left <= 0;
    v_take := least(v_left, inv.amount - inv.paid - inv.discount);
    if v_take <= 0 then continue; end if;

    insert into payments (invoice_id, amount, paid_on) values (inv.id, v_take, p_paid_on);

    -- The same early-settlement discount record_payment offers one invoice at
    -- a time: 2% off a 30-day invoice paid within ten days of being issued.
    -- Sweeping the account clean is still paying early, and should not be
    -- worth less than paying the same invoice on its own would have been.
    v_discount := 0;
    if r.terms_days = 30
       and p_paid_on <= inv.issued_on + 10
       and inv.paid + v_take >= round(inv.amount * 0.98, 2) - inv.discount then
      v_discount := greatest(round(inv.amount * 0.02, 2) - inv.discount, 0);
    end if;

    update invoices set paid = paid + v_take, discount = discount + v_discount
     where id = inv.id returning * into inv;

    v_applied := v_applied || jsonb_build_object(
      'invoice_id', inv.id, 'order_id', inv.order_id,
      'applied', v_take, 'discount', v_discount, 'now_owes', inv.amount - inv.paid - inv.discount);

    if inv.paid + inv.discount >= inv.amount then
      update invoices set status = 'paid', settled_on = p_paid_on where id = inv.id;
      v_settled_any := true;
      if p_paid_on > inv.due_on then
        insert into reseller_events (reseller_id, kind, detail)
        values (r.id, 'paid_late',
                jsonb_build_object('invoice', inv.id, 'due', inv.due_on, 'paid', p_paid_on));
      end if;
    end if;

    v_left := v_left - v_take;
  end loop;

  -- Whatever is left when there is nothing open left to pay is not spent —
  -- it is theirs, on the record, until an invoice exists to take it.
  if v_left > 0 then
    insert into reseller_credits (reseller_id, amount, reason, recorded_by)
    values (p_reseller, v_left,
            format('Payment of %s on %s left %s unapplied — no open invoice to put it against.',
                   p_amount, p_paid_on, v_left),
            current_actor());
  end if;

  if v_settled_any and r.blocked and r.blocked_reason = 'past-due invoice'
     and not has_overdue(r.id) then
    update resellers set blocked = false, blocked_reason = null where id = r.id;
    insert into reseller_events (reseller_id, kind, detail)
    values (r.id, 'unblocked', jsonb_build_object('reason', 'account brought current'));
  end if;

  return jsonb_build_object(
    'applied', v_applied,
    'credited', greatest(v_left, 0),
    'still_owed', amount_outstanding(p_reseller));
end;
$$;

-- ---------------------------------------------------------------------------
-- A reseller carrying credit is not billed again for money already sent.
-- Only the amount and the auto-apply are new; everything raise_invoice always
-- did — the invoice, its terms, its due date — is untouched.
-- ---------------------------------------------------------------------------
create or replace function raise_invoice(p_order bigint) returns void
language plpgsql security definer as $$
declare
  o orders%rowtype; v_terms int; v_invoice invoices%rowtype;
  v_credit numeric(12,2); v_take numeric(12,2);
begin
  select * into o from orders where id = p_order;
  if o.channel <> 'b2b' or o.reseller_id is null then return; end if;

  select case when tier = 1 then 0 else terms_days end
    into v_terms from resellers where id = o.reseller_id;

  insert into invoices (order_id, reseller_id, due_on, amount)
  values (p_order, o.reseller_id, current_date + v_terms, o.total)
  on conflict (order_id) do nothing
  returning * into v_invoice;

  -- on conflict left nothing to return: this invoice already existed, and
  -- whatever credit there was to apply was applied when it was first raised.
  if v_invoice.id is null then return; end if;

  v_credit := reseller_credit_balance(o.reseller_id);
  if v_credit > 0 then
    v_take := least(v_credit, v_invoice.amount - v_invoice.paid - v_invoice.discount);
    if v_take > 0 then
      insert into payments (invoice_id, amount, paid_on, recorded_by)
      values (v_invoice.id, v_take, current_date, 'credit balance');
      insert into reseller_credits (reseller_id, amount, reason, recorded_by)
      values (o.reseller_id, -v_take,
              format('Applied to invoice #%s the moment it was raised.', v_invoice.id),
              'credit balance');
      update invoices set paid = paid + v_take where id = v_invoice.id
        returning * into v_invoice;
      if v_invoice.paid + v_invoice.discount >= v_invoice.amount then
        update invoices set status = 'paid', settled_on = current_date where id = v_invoice.id;
      end if;
    end if;
  end if;
end;
$$;

-- create or replace wipes a function's stored settings — search_path included.
-- Everything above ran as its owner with the caller's search_path for exactly
-- as long as it took to read this comment. tests/search-path.test.js is what
-- catches it if one of these is ever missed again.
alter function reseller_credit_balance(bigint)         set search_path = public, extensions;
alter function pay_reseller_account(bigint, numeric, date) set search_path = public, extensions;
alter function raise_invoice(bigint)                    set search_path = public, extensions;

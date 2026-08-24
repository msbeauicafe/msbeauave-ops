-- ============================================================================
-- MS BEAU AVE — paying the whole account at once
--
-- A reseller settling up rarely hands over the amount of one invoice: they
-- pay what they have, against whatever is open, oldest first. What is left
-- over after every open invoice is closed is not lost — it sits as credit
-- and is drawn down automatically the next time an invoice is raised.
-- ============================================================================

create table reseller_credits (
  id          bigint generated always as identity primary key,
  reseller_id bigint not null references resellers (id),
  -- positive: credit added (an overpayment). negative: credit spent (drawn
  -- down against a new invoice). The balance is just the sum of this column,
  -- same as the ledger anything else here keeps.
  amount      numeric(12,2) not null,
  reason      text not null,
  actor       text not null default current_actor(),
  at          timestamptz not null default now()
);

create or replace function reseller_credit_balance(p_reseller bigint)
returns numeric language sql stable security definer as $$
  select coalesce(sum(amount), 0) from reseller_credits where reseller_id = p_reseller;
$$;

-- The engine record_payment already had, pulled out and stripped of its
-- role check: the reseller portal has to be able to draw down standing
-- credit against a freshly raised invoice on its own, at the moment the
-- reseller places the order — nobody with the admin role is in that request
-- at all. record_payment stays the admin-facing entry point below; this is
-- what it (and everything else here) actually runs.
create or replace function apply_invoice_payment(
  p_invoice bigint, p_amount numeric, p_paid_on date default current_date
) returns void
language plpgsql security definer as $$
declare inv invoices%rowtype; r resellers%rowtype; v_discount numeric(12,2) := 0;
begin
  if p_amount <= 0 then raise exception 'payment must be more than zero'; end if;

  select * into inv from invoices where id = p_invoice for update;
  if not found then raise exception 'no such invoice (%)', p_invoice; end if;
  if inv.status <> 'open' then
    raise exception 'that invoice is already %', inv.status;
  end if;
  select * into r from resellers where id = inv.reseller_id for update;

  insert into payments (invoice_id, amount, paid_on) values (p_invoice, p_amount, p_paid_on);

  if r.terms_days = 30
     and p_paid_on <= inv.issued_on + 10
     and inv.paid + p_amount >= round(inv.amount * 0.98, 2) - inv.discount then
    v_discount := greatest(round(inv.amount * 0.02, 2) - inv.discount, 0);
  end if;

  update invoices set paid = paid + p_amount, discount = discount + v_discount
   where id = p_invoice returning * into inv;

  if inv.paid + inv.discount >= inv.amount then
    update invoices set status = 'paid', settled_on = p_paid_on
     where id = p_invoice returning * into inv;

    if p_paid_on > inv.due_on then
      insert into reseller_events (reseller_id, kind, detail)
      values (inv.reseller_id, 'paid_late',
              jsonb_build_object('invoice', inv.id, 'due', inv.due_on, 'paid', p_paid_on));
    end if;

    if r.blocked and r.blocked_reason = 'past-due invoice' and not has_overdue(r.id) then
      update resellers set blocked = false, blocked_reason = null where id = r.id;
      insert into reseller_events (reseller_id, kind, detail)
      values (r.id, 'unblocked', jsonb_build_object('reason', 'account brought current'));
    end if;
  end if;
end;
$$;

create or replace function record_payment(
  p_invoice bigint, p_amount numeric, p_paid_on date default current_date
) returns void
language plpgsql security definer as $$
begin
  perform require_role('admin');
  perform apply_invoice_payment(p_invoice, p_amount, p_paid_on);
end;
$$;

-- Applies a payment across every open invoice on the account, oldest first,
-- so the 2/10 net 30 discount and the auto-unblock on clearing the last
-- past-due invoice both happen exactly as they do for a single-invoice
-- payment. Whatever is left once every open invoice reads zero becomes
-- credit.
create or replace function pay_account(
  p_reseller bigint, p_amount numeric, p_paid_on date default current_date
) returns jsonb
language plpgsql security definer as $$
declare
  inv         record;
  v_remaining numeric(12,2) := p_amount;
  v_take      numeric(12,2);
  v_applied   jsonb := '[]'::jsonb;
begin
  perform require_role('admin');
  if p_amount <= 0 then raise exception 'payment must be more than zero'; end if;
  if not exists (select 1 from resellers where id = p_reseller) then
    raise exception 'no such reseller (%)', p_reseller;
  end if;

  for inv in
    select id, amount, paid, discount from invoices
     where reseller_id = p_reseller and status = 'open'
     order by issued_on, id
       for update
  loop
    exit when v_remaining <= 0;
    v_take := least(v_remaining, inv.amount - inv.paid - inv.discount);
    if v_take > 0 then
      perform apply_invoice_payment(inv.id, v_take, p_paid_on);
      v_applied := v_applied || jsonb_build_object('invoice_id', inv.id, 'amount', v_take);
      v_remaining := v_remaining - v_take;
    end if;
  end loop;

  if v_remaining > 0 then
    insert into reseller_credits (reseller_id, amount, reason)
    values (p_reseller, v_remaining, 'overpayment settling the account');
  end if;

  return jsonb_build_object('applied', v_applied, 'credited', v_remaining);
end;
$$;

-- Draw down any standing credit against a freshly raised invoice, before the
-- reseller ever sees a balance due for it. This runs inside place_order,
-- which a reseller calls for themselves — apply_invoice_payment is what
-- makes that possible, since record_payment would refuse them outright.
create or replace function raise_invoice(p_order bigint) returns void
language plpgsql security definer as $$
declare o orders%rowtype; v_terms int; v_credit numeric(12,2); v_take numeric(12,2); inv invoices%rowtype;
begin
  select * into o from orders where id = p_order;
  if o.channel <> 'b2b' or o.reseller_id is null then return; end if;

  select case when tier = 1 then 0 else terms_days end
    into v_terms from resellers where id = o.reseller_id;

  insert into invoices (order_id, reseller_id, due_on, amount)
  values (p_order, o.reseller_id, current_date + v_terms, o.total)
  on conflict (order_id) do nothing
  returning * into inv;

  if inv.id is not null then
    v_credit := reseller_credit_balance(o.reseller_id);
    if v_credit > 0 then
      v_take := least(v_credit, inv.amount);
      perform apply_invoice_payment(inv.id, v_take, current_date);
      insert into reseller_credits (reseller_id, amount, reason)
      values (o.reseller_id, -v_take, 'applied automatically to invoice ' || inv.id);
    end if;
  end if;
end;
$$;

-- Resellers holding credit but nothing open owe nothing, so ar_ageing (which
-- only joins through open invoices) never surfaces them. Named the way the
-- owner would ask for it: who is sitting on money I owe them.
create or replace view ar_credit_holders as
select r.id as reseller_id, r.name, r.tier, reseller_credit_balance(r.id) as credit
  from resellers r
 where reseller_credit_balance(r.id) > 0
 order by credit desc;

alter table reseller_credits enable row level security;

create policy admin_reads_reseller_credits on reseller_credits for select
  using (current_role_name() = 'admin');
create policy reseller_reads_own_credits on reseller_credits for select
  using (current_role_name() = 'reseller' and reseller_id = current_reseller());

grant select on reseller_credits to app_client;
grant select on ar_credit_holders to app_client;

-- ---------------------------------------------------------------------------
-- Every function above is SECURITY DEFINER, and 004_hosting.sql's pinning and
-- execute lockdown already ran once and will not re-run by itself. Two of
-- these (pay_account, and the create-or-replaced raise_invoice) are new or
-- changed, so redo both sweeps — harmless to repeat on functions already
-- covered, and this file has to stand on its own on a fresh install too,
-- where 004 hasn't run yet at all.
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as signature
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
  loop
    execute format('alter function %s set search_path = public, extensions', r.signature);
    execute format('revoke all on function %s from public', r.signature);
    execute format('grant execute on function %s to app_client', r.signature);
  end loop;
exception when insufficient_privilege then
  raise notice 'skipping the lockdown sweep (no permission) — fine on a plain local Postgres';
end $$;

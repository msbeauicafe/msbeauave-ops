-- ============================================================================
-- MS BEAU AVE — cash advances and loans
--
-- Two kinds of money owed, kept apart because they are not the same thing. A
-- cash advance is the shop's own money, lent and taken back a cutoff at a time.
-- A Pag-IBIG or SSS loan is the agency's money: the shop only collects it and
-- passes it on, and the balance is theirs to agree, not the shop's to forgive.
--
-- The shape is the shop's own CA Record: an amount lent on a date, then a row
-- per cutoff for what came off, and a balance that falls to nothing. It is kept
-- as the ledger rather than as a single running figure so that "why does she
-- still owe four thousand" is a question with an answer.
--
-- A payment can name the payroll period it came off, which is what makes a
-- cutoff's Loan/CA column and this ledger the same number rather than two.
-- ============================================================================

create table if not exists advances (
  id          bigint generated always as identity primary key,
  employee_id bigint not null references employees (id) on delete cascade,
  kind        text not null check (kind in ('ca', 'pagibig', 'sss')),
  principal   numeric(12,2) not null check (principal > 0),
  started_on  date not null default (now() at time zone 'Asia/Manila')::date,
  per_cutoff  numeric(12,2) not null default 0 check (per_cutoff >= 0),
  note        text,
  created_at  timestamptz not null default now(),
  created_by  text not null default current_actor()
);
create index if not exists advances_by_person on advances (employee_id, kind);

create table if not exists advance_payments (
  id          bigint generated always as identity primary key,
  advance_id  bigint not null references advances (id) on delete cascade,
  paid_on     date not null default (now() at time zone 'Asia/Manila')::date,
  amount      numeric(12,2) not null check (amount > 0),
  period_id   bigint references payroll_periods (id) on delete set null,
  note        text,
  created_at  timestamptz not null default now(),
  created_by  text not null default current_actor()
);
create index if not exists advance_payments_by_advance on advance_payments (advance_id);

alter table advances         enable row level security;
alter table advance_payments enable row level security;
drop policy if exists office_reads_advances on advances;
drop policy if exists office_reads_advance_payments on advance_payments;
create policy office_reads_advances on advances for select
  using (current_role_name() in ('admin', 'office'));
create policy office_reads_advance_payments on advance_payments for select
  using (current_role_name() in ('admin', 'office'));
grant select on advances, advance_payments to app_client;

-- What is still owed, and what has been taken so far. Derived, so the ledger
-- and the balance cannot drift apart.
create or replace view advance_balances as
select a.id, a.employee_id, e.name, e.company, e.position,
       a.kind, a.principal, a.started_on, a.per_cutoff, a.note,
       coalesce((select sum(p.amount) from advance_payments p
                  where p.advance_id = a.id), 0)::numeric(12,2) as paid,
       (a.principal - coalesce((select sum(p.amount) from advance_payments p
                                 where p.advance_id = a.id), 0))::numeric(12,2) as balance,
       (select max(p.paid_on) from advance_payments p where p.advance_id = a.id) as last_paid
  from advances a
  join employees e on e.id = a.employee_id;

grant select on advance_balances to app_client;

create or replace function open_advance(
  p_employee bigint, p_kind text, p_amount numeric,
  p_per_cutoff numeric, p_started date, p_note text
) returns bigint
language plpgsql security definer as $$
declare v_id bigint;
begin
  perform require_role('admin', 'office');
  if coalesce(p_kind, '') not in ('ca', 'pagibig', 'sss') then
    raise exception 'A ledger is a cash advance, a Pag-IBIG loan or an SSS loan.';
  end if;
  if coalesce(p_amount, 0) <= 0 then
    raise exception 'How much was lent?';
  end if;
  insert into advances (employee_id, kind, principal, per_cutoff, started_on, note)
  values (p_employee, p_kind, p_amount, greatest(coalesce(p_per_cutoff, 0), 0),
          coalesce(p_started, (now() at time zone 'Asia/Manila')::date),
          nullif(btrim(coalesce(p_note, '')), ''))
  returning id into v_id;
  return v_id;
end;
$$;

-- Taking an amount off. Refused once it would take the balance past nothing:
-- a ledger that goes negative is a ledger nobody trusts again.
create or replace function take_off_advance(
  p_advance bigint, p_amount numeric, p_paid_on date,
  p_period bigint, p_note text
) returns numeric
language plpgsql security definer as $$
declare v_balance numeric;
begin
  perform require_role('admin', 'office');
  if coalesce(p_amount, 0) <= 0 then
    raise exception 'How much is coming off?';
  end if;
  select balance into v_balance from advance_balances where id = p_advance;
  if not found then raise exception 'There is no such ledger.'; end if;
  if p_amount > v_balance then
    raise exception 'Only % is still owed.', to_char(v_balance, 'FM999,999.00');
  end if;

  insert into advance_payments (advance_id, amount, paid_on, period_id, note)
  values (p_advance, p_amount,
          coalesce(p_paid_on, (now() at time zone 'Asia/Manila')::date),
          p_period, nullif(btrim(coalesce(p_note, '')), ''));

  return v_balance - p_amount;
end;
$$;

create or replace function undo_advance_payment(p_id bigint) returns void
language plpgsql security definer as $$
begin
  perform require_role('admin', 'office');
  delete from advance_payments where id = p_id;
  if not found then raise exception 'There is no such payment.'; end if;
end;
$$;

create or replace function remove_advance(p_id bigint) returns void
language plpgsql security definer as $$
begin
  perform require_role('admin');
  if exists (select 1 from advance_payments where advance_id = p_id) then
    raise exception 'REMOVE_BLOCKED: this ledger has payments against it. Undo those first.';
  end if;
  delete from advances where id = p_id;
  if not found then raise exception 'There is no such ledger.'; end if;
end;
$$;

alter function open_advance(bigint, text, numeric, numeric, date, text)
  set search_path = public, extensions;
alter function take_off_advance(bigint, numeric, date, bigint, text)
  set search_path = public, extensions;
alter function undo_advance_payment(bigint) set search_path = public, extensions;
alter function remove_advance(bigint)       set search_path = public, extensions;
grant execute on function open_advance(bigint, text, numeric, numeric, date, text) to app_client;
grant execute on function take_off_advance(bigint, numeric, date, bigint, text)    to app_client;
grant execute on function undo_advance_payment(bigint) to app_client;
grant execute on function remove_advance(bigint)       to app_client;

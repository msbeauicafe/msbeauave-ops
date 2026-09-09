-- ============================================================================
-- MS BEAU AVE — which Pag-IBIG loan, which SSS loan
--
-- The ledger knew a loan was Pag-IBIG's or SSS's and nothing more, and the shop
-- runs six of them: Pag-IBIG salary, calamity and short term; SSS salary,
-- emergency and calamity. Somebody paying two Pag-IBIG loans at once had two
-- rows on the Loans tab that read identically, and the only way to tell them
-- apart was the note somebody had remembered to type.
--
-- The family stays as it was — 'pagibig' or 'sss' — because that is what a
-- payslip is broken down by: the deduction line says Pag-IBIG Loan, and it is
-- the sum of whatever Pag-IBIG loans that person is paying. Splitting the kind
-- column into six would have meant rewriting that arithmetic to add three
-- things back together, and a payslip that has to be re-derived is a payslip
-- that will disagree with itself one cutoff.
--
-- So the family is the kind, and which one it is sits beside it.
-- ============================================================================

alter table advances add column if not exists loan_type text;

alter table advances drop constraint if exists advances_loan_type_check;
alter table advances add constraint advances_loan_type_check check (
  loan_type is null or (kind, loan_type) in (
    ('pagibig', 'salary'), ('pagibig', 'calamity'), ('pagibig', 'short term'),
    ('sss',     'salary'), ('sss',     'emergency'), ('sss', 'calamity')
  )
);

-- Rebuilt rather than replaced: create-or-replace cannot add a column to a
-- view's middle, and the whole thing is short enough to read in one go.
drop view if exists advance_balances;

create view advance_balances as
select a.id, a.employee_id, e.name, e.company, e.position,
       a.kind, a.loan_type, a.principal, a.started_on, a.per_cutoff, a.note,
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
  p_per_cutoff numeric, p_started date, p_note text, p_loan_type text default null
) returns bigint
language plpgsql security definer as $$
declare v_id bigint; v_type text;
begin
  perform require_role('admin', 'office', 'hr');
  if coalesce(p_kind, '') not in ('ca', 'pagibig', 'sss') then
    raise exception 'A ledger is a cash advance, a Pag-IBIG loan or an SSS loan.';
  end if;
  if coalesce(p_amount, 0) <= 0 then
    raise exception 'How much was lent?';
  end if;

  v_type := nullif(lower(btrim(coalesce(p_loan_type, ''))), '');
  -- A cash advance is the shop's own money and has no agency loan behind it.
  if p_kind = 'ca' then v_type := null; end if;
  if p_kind <> 'ca' and v_type is null then
    raise exception 'Which % loan is it?', case p_kind when 'pagibig'
      then 'Pag-IBIG' else 'SSS' end;
  end if;

  insert into advances (employee_id, kind, loan_type, principal, per_cutoff,
                        started_on, note)
  values (p_employee, p_kind, v_type, p_amount, greatest(coalesce(p_per_cutoff, 0), 0),
          coalesce(p_started, (now() at time zone 'Asia/Manila')::date),
          nullif(btrim(coalesce(p_note, '')), ''))
  returning id into v_id;
  return v_id;
end;
$$;

alter function open_advance(bigint, text, numeric, numeric, date, text, text)
  set search_path = public, extensions;
grant execute on function open_advance(bigint, text, numeric, numeric, date, text, text)
  to app_client;

-- The six-argument version is gone: it could only open a loan without saying
-- which loan, and that is the thing being fixed.
drop function if exists open_advance(bigint, text, numeric, numeric, date, text);

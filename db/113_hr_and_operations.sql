-- ============================================================================
-- MS BEAU AVE — HR and the operations manager
--
-- Two people run the people half of this company: the HR & Admin Officer and
-- the Operations Manager. Both were signed in as admin, because admin was the
-- only role that could open Team, HR and Payroll. That gave two people the
-- pricelist, the company's money and the sign-ins as the price of being able
-- to approve somebody's leave.
--
-- So there is a role for the job now. It reaches four screens — Team, HR,
-- Payroll and their own record — and nothing else answers it. Not the till,
-- not the catalogue, not Finance, not Sign-ins: those refuse an 'hr' the same
-- way they refuse a cashier, in the database rather than by hiding a button.
--
-- What it can do inside those four is everything the job needs: hire somebody,
-- set what they are paid, approve leave, run a cutoff, send the payslips. That
-- is the whole point of taking them off admin — a smaller role nobody has to
-- work around is safer than a large one everybody has.
--
-- The guards are widened by rewriting each function's own source rather than
-- by copying thirty bodies into this file. Copied bodies rot: the next person
-- to fix add_employee fixes it in one place and leaves a stale twin here. The
-- list of names below is the decision; the loop is only how it is applied.
-- ============================================================================

alter table app_users drop constraint if exists app_users_role_check;
alter table app_users add constraint app_users_role_check
  check (role in ('admin','warehouse','cashier','supervisor','office',
                  'timekeeper','reseller','employee','observer','orderdesk',
                  'datacoord','hr'));

do $$
declare
  r record;
  src text;
  -- What HR and the operations manager may do. Everything here is people or
  -- pay; nothing here touches a price, a product, an order or the money.
  people_work text[] := array[
    -- The team list
    'add_employee', 'add_employees', 'update_employee', 'remove_employee',
    'end_employment', 'move_employee', 'set_employee_photo',
    'set_employee_pin', 'clear_employee_pin', 'enrol_finger', 'clear_fingers',
    'set_pay_details', 'set_employee_email',
    -- HR
    'set_employment', 'decide_leave', 'add_application', 'move_application',
    'add_appraisal', 'post_announcement', 'withdraw_announcement',
    -- Payroll, and the two ledgers behind it
    'open_payroll', 'save_payroll_line', 'close_payroll', 'reopen_payroll',
    'remove_payroll', 'open_advance', 'take_off_advance',
    'undo_advance_payment', 'remove_advance', 'record_payslip_email',
    -- Attendance — the fortnight a cutoff is worked out from
    'attendance_on', 'attendance_detail', 'attendance_summary'
  ];
begin
  for r in
    select p.oid::regprocedure::text as sig, pg_get_functiondef(p.oid) as def
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = any (people_work)
  loop
    src := r.def;
    src := replace(src, 'require_role(''admin'')', 'require_role(''admin'', ''hr'')');
    src := regexp_replace(src, 'require_role\(''admin'',\s*''office''\)',
                          'require_role(''admin'', ''office'', ''hr'')', 'g');
    src := regexp_replace(src, 'require_role\(''admin'',\s*''observer''\)',
                          'require_role(''admin'', ''observer'', ''hr'')', 'g');
    if src <> r.def then
      execute src;
      -- create or replace wipes a function's stored settings, search_path
      -- included, and tests/search-path.test.js is right to fail if it is not
      -- put back.
      execute format('alter function %s set search_path = public, extensions', r.sig);
    end if;
  end loop;

  -- A sign-in can be set to it, in both the places that decide that.
  for r in
    select p.oid::regprocedure::text as sig, pg_get_functiondef(p.oid) as def
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('create_login', 'change_role')
  loop
    src := replace(r.def, '''orderdesk'',''datacoord'')', '''orderdesk'',''datacoord'',''hr'')');
    src := replace(src, '''orderdesk'', ''datacoord'')', '''orderdesk'', ''datacoord'', ''hr'')');
    if src <> r.def then
      execute src;
      execute format('alter function %s set search_path = public, extensions', r.sig);
    end if;
  end loop;
end;
$$;

-- What it may read. Row-level policies name their roles literally, so nothing
-- above reaches them. The people half of the company and no further — there is
-- deliberately no policy here for products, stock, sales, orders or promos.
do $$
declare t text;
begin
  foreach t in array array[
    'employees', 'employee_photos', 'branches', 'shifts',
    'employment_details', 'leave_requests', 'applications', 'appraisals',
    'announcements', 'payroll_periods', 'payroll_lines',
    'advances', 'advance_payments', 'payslip_emails'
  ] loop
    execute format('drop policy if exists hr_reads_%1$s on %1$I', t);
    execute format(
      'create policy hr_reads_%1$s on %1$I for select using (current_role_name() = ''hr'')', t);
  end loop;
end;
$$;

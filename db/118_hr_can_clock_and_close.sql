-- ============================================================================
-- MS BEAU AVE — the rest of what HR's screens actually press
--
-- Three buttons on the HR officer's own menu answered "your sign-in does not
-- allow that", which is the same mistake as My record and worth writing down
-- properly: the screens were opened up and the things the screens press were
-- not, one at a time, as each got noticed.
--
--   Clock in / Clock out on the team list. Clocking somebody was a cashier's
--   job because the till stands by the door; the person who keeps the hours is
--   at least as entitled to correct them.
--
--   Removing a cash advance or a loan, which the payroll screen offers her and
--   the database refused.
--
-- The branch dropdown is the third and it is a route, not a function, so it is
-- not here.
-- ============================================================================

do $$
declare r record; src text;
begin
  for r in
    select p.oid::regprocedure::text as sig, pg_get_functiondef(p.oid) as def
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('clock_in', 'clock_out')
  loop
    src := replace(r.def, 'require_role(''admin'', ''cashier'')',
                          'require_role(''admin'', ''cashier'', ''hr'')');
    if src <> r.def then
      execute src;
      -- create or replace wipes a function's stored settings, search_path
      -- included.
      execute format('alter function %s set search_path = public, extensions', r.sig);
    end if;
  end loop;
end;
$$;

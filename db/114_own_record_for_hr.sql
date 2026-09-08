-- ============================================================================
-- MS BEAU AVE — HR has a record of her own too
--
-- The new role reached Team, HR, Payroll and Attendance on the first try and
-- fell over on the fifth screen: My record answered "Your sign-in does not
-- allow that." The route had been opened up; the five functions behind it had
-- not, and they are the ones that decide.
--
-- Which is the rule this build keeps learning the same way: a role is not
-- added to a route, it is added to require_role. The route is the polite
-- refusal; the function is the refusal. Adding one without the other gives
-- somebody a menu item that does not work.
--
-- Nothing here is about the company. Every one of these works out who is
-- asking from the session and hands back their own row — the HR officer
-- reading her own leave balance is not HR reading anybody's.
-- ============================================================================

do $$
declare r record; src text;
begin
  for r in
    select p.oid::regprocedure::text as sig, pg_get_functiondef(p.oid) as def
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('my_profile', 'my_leave', 'my_appraisals', 'my_hours',
                         'noticeboard')
  loop
    src := replace(r.def, '''observer''', '''observer'',''hr''');
    if src <> r.def then
      execute src;
      -- create or replace wipes a function's stored settings, search_path
      -- included.
      execute format('alter function %s set search_path = public, extensions', r.sig);
    end if;
  end loop;
end;
$$;

-- ============================================================================
-- MS BEAU AVE — an order desk works here too
--
-- The order desk got Customer order and a menu that also listed My record, My
-- leave and the noticeboard. The menu listed them; nothing behind them would
-- answer. Both of them signed in to "Your sign-in does not allow that" on the
-- first thing they clicked.
--
-- The mistake was reading the role as a slice of the owner and stopping there.
-- It is also a member of staff — somebody with a record, a leave balance and
-- the same noticeboard as everyone else — and every one of those screens was
-- written for 'employee'.
--
-- So the rule is the plain one: wherever a function admits an employee, it
-- admits an order desk. Not a list of screens to keep in step by hand, which
-- is what produced this, but the fact that the two roles are the same person
-- as far as their own record is concerned.
-- ============================================================================

do $rewrite$
declare
  fn   text;
  def  text;
  done int := 0;
begin
  for fn, def in
    -- prokind 'f' is a plain function. pg_get_functiondef refuses an aggregate,
    -- and this schema defines one.
    select p.proname, pg_get_functiondef(p.oid)
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prokind = 'f'
       and pg_get_functiondef(p.oid) ~ 'require_role\([^)]*''employee'''
  loop
    if def like '%''orderdesk''%' then
      continue;
    end if;
    -- Beside the employee it is standing in for, so a list that reads
    -- ('admin','employee','observer') keeps its shape.
    execute regexp_replace(def, '(require_role\([^)]*)''employee''',
                           '\1''employee'', ''orderdesk''', 'g');
    done := done + 1;
  end loop;

  raise notice 'order desk: %  function(s) that admit an employee now admit it too', done;
end;
$rewrite$;

-- ============================================================================
-- MS BEAU AVE — taking a PIN back
--
-- A PIN could be given and replaced, never removed. That is a gap with two
-- faces. The small one: a branch manager who is on the payroll but does not
-- work a shift has a PIN nobody wants and nobody uses. The large one: somebody
-- who leaves keeps a PIN that still opens the clock, and the only way to stop
-- it was to give them a new one they would never see — which is a working PIN,
-- just an unknown one.
--
-- Removing it says what it means: this person does not clock.
-- ============================================================================

create or replace function clear_employee_pin(p_id bigint) returns void
language plpgsql security definer as $$
declare v_name text;
begin
  perform require_role('admin');

  select name into v_name from employees where id = p_id;
  if not found then
    raise exception 'No such person.';
  end if;

  update employees set pin_hash = null, pin_fp = null where id = p_id;
end;
$$;

alter function clear_employee_pin(bigint) set search_path = public, extensions;
revoke all on function clear_employee_pin(bigint) from public;
grant execute on function clear_employee_pin(bigint) to app_client;

-- ============================================================================
-- MS BEAU AVE — taking somebody off the team list for good
--
-- There are two different things people mean by "remove", and conflating them
-- loses money in a way nobody notices for a month.
--
-- Somebody who worked here and left has to stay. Their shifts are hours the
-- shop owes or has paid for, and a payroll period that quietly stops adding up
-- is the worst kind of wrong — plausible, and discovered late. That is what
-- "They have left" is for: it dates the departure and keeps everything.
--
-- Somebody entered by mistake — a test row, a duplicate, a name typed into the
-- wrong box — never worked here at all. Leaving them dated-as-left puts a
-- person who does not exist on a list people read every day, and on the clock
-- screen by the door.
--
-- So this deletes only the second kind, and it decides which is which by
-- looking rather than asking: anybody with a single shift against them is
-- refused, by name and with the count, and pointed at the other button.
-- ============================================================================

create or replace function remove_employee(p_id bigint)
returns text language plpgsql security definer as $$
declare
  v_name   text;
  v_shifts int;
begin
  perform require_role('admin');

  select name into v_name from employees where id = p_id;
  if not found then
    raise exception 'No such person on the team.';
  end if;

  select count(*) into v_shifts from shifts where employee_id = p_id;
  if v_shifts > 0 then
    raise exception
      '% has % shift% on record. Those hours have to keep adding up — use "They have left" instead.',
      v_name, v_shifts, case when v_shifts = 1 then '' else 's' end
      using errcode = 'P0009';
  end if;

  -- Their photograph goes with them; the row cascades. The sign-in they used,
  -- if any, is a separate thing and stays — removing a person from the team is
  -- not the same as taking away an account.
  delete from employees where id = p_id;
  return v_name;
end;
$$;

alter function remove_employee(bigint) set search_path = public, extensions;
revoke all on function remove_employee(bigint) from public;
grant execute on function remove_employee(bigint) to app_client;

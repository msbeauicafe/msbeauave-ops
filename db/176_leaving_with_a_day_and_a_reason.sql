-- "They have left" always dated the departure today. Somebody who walked out
-- last week was then on the books as leaving this week — and the cutoff their
-- last day really fell in is the one that owes them, so the date is not a
-- detail. Now the last day is picked, and so is why they went: resigned,
-- terminated, end of contract, AWOL, retired. Picked from a list, never
-- typed, so the 201 file and the payroll that read it later agree on what
-- the words are.
--
-- And a press of "They have left" on the wrong name was a one-way door: the
-- only way back was the database. return_to_team undoes it — the leaving date
-- and reason cleared, everything else as it was.

alter table employees add column if not exists separation_reason text;
alter table employees drop constraint if exists employees_separation_reason_check;
alter table employees add constraint employees_separation_reason_check
  check (separation_reason is null
         or separation_reason in ('resigned', 'terminated', 'end_of_contract', 'awol', 'retired'));

drop function if exists end_employment(bigint, date);

create or replace function end_employment(p_id bigint, p_on date default null,
                                          p_reason text default null)
returns void language plpgsql security definer as $$
declare v_started date; v_name text;
begin
  perform require_role('admin', 'hr');
  select started_on, name into v_started, v_name from employees where id = p_id;
  if not found then raise exception 'No such person.'; end if;
  if p_on is not null and p_on < v_started then
    raise exception '% started on %, so they cannot have left before that.',
      v_name, to_char(v_started, 'FMMonth FMDD, YYYY');
  end if;
  if p_reason is not null
     and p_reason not in ('resigned', 'terminated', 'end_of_contract', 'awol', 'retired') then
    raise exception 'Pick why they left from the list.';
  end if;

  update employees
     set ended_on = coalesce(p_on, current_date),
         separation_reason = p_reason
   where id = p_id;
  update shifts set ended_at = now(), ended_by = current_actor()
   where employee_id = p_id and ended_at is null;
end;
$$;
alter function end_employment(bigint, date, text) set search_path = public, extensions;
revoke all on function end_employment(bigint, date, text) from public;
grant execute on function end_employment(bigint, date, text) to app_client;

create or replace function return_to_team(p_id bigint)
returns text language plpgsql security definer as $$
declare v_name text;
begin
  perform require_role('admin', 'hr');
  update employees set ended_on = null, separation_reason = null
   where id = p_id and ended_on is not null
  returning name into v_name;
  if v_name is null then raise exception 'They are already on the team.'; end if;
  return v_name;
end;
$$;
alter function return_to_team(bigint) set search_path = public, extensions;
revoke all on function return_to_team(bigint) from public;
grant execute on function return_to_team(bigint) to app_client;

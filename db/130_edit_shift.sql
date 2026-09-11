-- ============================================================================
-- MS BEAU AVE — correcting a shift by hand
--
-- Every clocking on the record so far came from a toggle: clock_toggle,
-- clock_in, clock_out. None of them can put a time in that was not now(), so
-- a shift the door got wrong — a missed clock-out that left somebody "on
-- shift" for three days, a ghost the old double-press bug wrote before it was
-- fixed — had no way back to a true number except by hand in the database.
--
-- edit_shift is that way back, on the one screen that already shows the
-- anomaly: Attendance's "Every press, in order". A shift id corrects that
-- row; no id raises a new one, for the other half of a shift that was split
-- across a missed toggle and needs a second row rather than a wider first
-- one. Same shape as save_supplier and save_brand — null id, new row.
--
-- The note is not optional. A number changed in an hours record with nothing
-- said about why is the thing this system has spent this whole session
-- refusing to allow anywhere else.
-- ============================================================================

create or replace function edit_shift(
  p_shift bigint, p_employee bigint, p_started_at timestamptz,
  p_ended_at timestamptz, p_note text
) returns bigint
language plpgsql security definer as $$
declare v_business_date date; v_id bigint;
begin
  perform require_role('admin', 'hr');

  if p_started_at is null then
    raise exception 'A shift needs a time it started.';
  end if;
  if p_ended_at is not null and p_ended_at < p_started_at then
    raise exception 'A shift cannot end before it starts.';
  end if;
  if length(btrim(coalesce(p_note, ''))) = 0 then
    raise exception 'Say why this shift is being corrected.';
  end if;

  v_business_date := (p_started_at at time zone 'Asia/Manila')::date;

  if p_shift is null then
    if p_employee is null or not exists (
      select 1 from employees where id = p_employee and ended_on is null) then
      raise exception 'That person is not on the team.';
    end if;
    insert into shifts (employee_id, business_date, started_at, ended_at, note)
    values (p_employee, v_business_date, p_started_at, p_ended_at, btrim(p_note))
    returning id into v_id;
  else
    update shifts
       set started_at = p_started_at, ended_at = p_ended_at,
           business_date = v_business_date, note = btrim(p_note)
     where id = p_shift
     returning id into v_id;
    if v_id is null then raise exception 'No such shift.'; end if;
  end if;

  return v_id;
end;
$$;

alter function edit_shift(bigint, bigint, timestamptz, timestamptz, text)
  set search_path = public, extensions;
grant execute on function edit_shift(bigint, bigint, timestamptz, timestamptz, text) to app_client;

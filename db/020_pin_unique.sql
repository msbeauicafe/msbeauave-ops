-- ============================================================================
-- MS BEAU AVE — no two people share a clock PIN
--
-- Twenty-six PINs drawn at random from four digits produced a duplicate on the
-- first try, which is exactly what the arithmetic predicts: across sixty people
-- a collision is not a risk, it is the expected outcome.
--
-- It matters here in a way it would not for a password. The clock asks who you
-- are first and for the PIN second, so two people holding 4821 means either of
-- them can clock the other on. That is the single thing the PIN exists to
-- prevent, so the PINs have to be unique.
--
-- They cannot be compared as stored: a password hash is salted, so the same
-- PIN hashes differently every time — which is right, and also why uniqueness
-- cannot be checked against it. So each PIN also carries a fingerprint: a
-- keyed hash, the same input always giving the same output, kept under a
-- unique index. It reveals nothing on its own; without the server's key it
-- cannot be worked backwards, and with the key it only says "these two are the
-- same", which is precisely the question being asked.
--
-- The index is partial. Somebody who has left frees their PIN for the next
-- person, because there is no reason to retire a number along with the person.
-- ============================================================================

alter table employees add column pin_fp text;
comment on column employees.pin_fp is
  'keyed fingerprint of the clock PIN, so two people cannot hold the same one';

create unique index employees_pin_unique on employees (pin_fp)
  where pin_fp is not null and ended_on is null;

-- Both halves are written together: a hash without its fingerprint would slip
-- past the index and a fingerprint without its hash could not be checked.
create or replace function set_employee_pin(p_id bigint, p_hash text, p_fp text)
returns void language plpgsql security definer as $$
declare v_name text;
begin
  perform require_role('admin');

  select name into v_name from employees where id = p_id and ended_on is null;
  if not found then
    raise exception 'No such person on the team.';
  end if;

  begin
    update employees set pin_hash = p_hash, pin_fp = p_fp where id = p_id;
  exception when unique_violation then
    -- Naming who holds it would hand one person another's PIN by elimination.
    raise exception 'Somebody on the team already uses that PIN. Try another.'
      using errcode = 'P0008';
  end;
end;
$$;

-- The old two-argument form goes rather than sitting beside this one: a PIN
-- set without a fingerprint is a PIN that can be issued twice, and that is the
-- bug this file exists to close.
drop function if exists set_employee_pin(bigint, text);

alter function set_employee_pin(bigint, text, text) set search_path = public, extensions;
revoke all on function set_employee_pin(bigint, text, text) from public;
grant execute on function set_employee_pin(bigint, text, text) to app_client;

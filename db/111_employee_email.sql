-- ============================================================================
-- MS BEAU AVE — where a payslip is sent
--
-- The team's records carried a phone number and no email. Held on the person
-- rather than on their sign-in, because most of the team have no sign-in and
-- every one of them gets paid.
--
-- Checked on the way in only for the shape of an address. A typo that is still
-- a valid address is not something a database can catch, and refusing anything
-- clever here would only mean somebody keeping the real address on paper.
-- ============================================================================

alter table employees add column if not exists email text;

create or replace function set_employee_email(p_id bigint, p_email text)
returns void language plpgsql security definer as $$
declare v_email text;
begin
  perform require_role('admin', 'office');
  v_email := lower(btrim(coalesce(p_email, '')));
  if v_email <> '' and v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception '% does not look like an email address.', v_email;
  end if;
  update employees set email = nullif(v_email, '') where id = p_id;
  if not found then raise exception 'No such person.'; end if;
end;
$$;

alter function set_employee_email(bigint, text) set search_path = public, extensions;
grant execute on function set_employee_email(bigint, text) to app_client;

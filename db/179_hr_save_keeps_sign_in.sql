-- Saving somebody from Team as HR wiped their sign-in.
--
-- HR may save a person (113 widened update_employee to admin + hr), but the
-- Team list hands HR neither each person's sign-in nor the sign-ins free to
-- pick — those are the owner's to give out. So for HR the "Signs in as" box
-- only ever held "No sign-in", every Save sent it, and update_employee wrote
-- user_id = null. Forty-five people lost the link between 26 September and
-- 5 October that way, one routine edit at a time, and every one of them then
-- signed in to "That sign-in does not belong to anybody on the team."
--
-- Who signs in as whom stays the owner's decision: anybody but admin saving a
-- person keeps the sign-in that person already has, whatever was sent. The
-- rest of the body is 011's, unchanged.
create or replace function update_employee(
  p_id bigint, p_name text, p_position text, p_phone text default null,
  p_user bigint default null, p_note text default null) returns void
language plpgsql security definer as $$
begin
  perform require_role('admin', 'hr');
  if current_role_name() <> 'admin' then
    select user_id into p_user from employees where id = p_id;
  end if;
  if p_user is not null
     and exists (select 1 from employees where user_id = p_user and id <> p_id) then
    raise exception 'That sign-in already belongs to someone else on the team.';
  end if;

  update employees
     set name = btrim(p_name), position = btrim(p_position),
         phone = nullif(btrim(coalesce(p_phone, '')), ''),
         user_id = p_user,
         note = nullif(btrim(coalesce(p_note, '')), '')
   where id = p_id;
  if not found then raise exception 'No such person.'; end if;
end;
$$;

alter function update_employee(bigint, text, text, text, bigint, text)
  set search_path = public, extensions;

-- IT support, laid out the way the owner asked for it: a Concern category,
-- "What needs fixing?" kept short with the detail in a message box of its
-- own, and the Department picked from a list rather than typed. IT files
-- concerns too — for somebody who rang it through — picking the person from
-- the team. Built on top of 180 rather than by editing it, so it applies the
-- same whether or not 180 was already run.
alter table it_tickets
  add column if not exists category text not null default 'hardware'
    check (category in ('hardware','software','network','printer','account','other')),
  add column if not exists details text;

drop function if exists it_submit(text, text, text, text, text);

create or replace function it_submit(
  p_name text, p_department text, p_category text, p_issue text, p_urgency text,
  p_details text default null
) returns bigint
language plpgsql security definer as $$
declare v_id bigint;
begin
  perform it_require_staff();
  if coalesce(btrim(p_issue), '') = '' then
    raise exception 'Say what needs fixing before sending.';
  end if;
  if coalesce(p_urgency, '') not in ('low','medium','high') then
    raise exception 'Pick how urgent it is.';
  end if;
  if coalesce(p_category, '') not in ('hardware','software','network','printer','account','other') then
    raise exception 'Pick what kind of problem it is.';
  end if;
  insert into it_tickets (name, department, category, issue, urgency, details)
  values (coalesce(nullif(btrim(p_name), ''), current_actor()),
          nullif(btrim(coalesce(p_department, '')), ''),
          p_category, btrim(p_issue), p_urgency,
          nullif(btrim(coalesce(p_details, '')), ''))
  returning id into v_id;
  insert into it_ticket_messages (ticket_id, body)
  values (v_id, btrim(p_issue)
    || coalesce(E'\n' || nullif(btrim(coalesce(p_details, '')), ''), ''));
  return v_id;
end;
$$;

-- The Department dropdown: the departments HR has actually filed people
-- under, so it is picked rather than typed.
create or replace function it_departments() returns text[]
language plpgsql stable security definer as $$
begin
  perform it_require_staff();
  return coalesce((select array_agg(d order by d) from (
    select distinct btrim(department) as d from employment_details
     where nullif(btrim(coalesce(department, '')), '') is not null) x), '{}');
end;
$$;

-- IT's Name dropdown when filing for somebody: everybody still on the team.
create or replace function it_people() returns text[]
language plpgsql stable security definer as $$
begin
  perform require_role('admin');
  return coalesce((select array_agg(name order by name) from employees
                    where ended_on is null), '{}');
end;
$$;

alter function it_submit(text, text, text, text, text, text) set search_path = public, extensions;
alter function it_departments() set search_path = public, extensions;
alter function it_people() set search_path = public, extensions;
revoke all on function it_submit(text, text, text, text, text, text) from public;
revoke all on function it_departments() from public;
revoke all on function it_people() from public;
grant execute on function it_submit(text, text, text, text, text, text) to app_client;
grant execute on function it_departments() to app_client;
grant execute on function it_people() to app_client;

-- IT is one person, not every admin.
--
-- 180 gave the IT queue to the admin role, and there are three admins. The
-- owner asked for it to be his alone: the dashboard, the badge, moving a
-- ticket and answering as IT belong to the one sign-in marked as IT. Every
-- other admin files concerns like everybody else — to him.
--
-- A mark on the sign-in, not a new role: the IT person keeps everything their
-- role already gives them, and IT is added on top.
alter table app_users add column if not exists is_it boolean not null default false;

-- The owner's own sign-in is the IT one.
update app_users set is_it = true where lower(username) = 'sonny.lorica';

-- Am I IT? An admin whose sign-in is marked so.
create or replace function it_is_it() returns boolean
language sql stable security definer as $$
  select current_role_name() = 'admin' and exists (
    select 1 from app_users u
     where lower(u.username) = lower(current_actor()) and u.active and u.is_it);
$$;

create or replace function it_require_it() returns void
language plpgsql stable security definer as $$
begin
  if not it_is_it() then
    raise exception 'FORBIDDEN: only IT may do that' using errcode = '42501';
  end if;
end;
$$;

create or replace function it_queue(p_status text default null, p_urgency text default null)
returns jsonb
language plpgsql stable security definer as $$
begin
  perform it_require_it();
  return coalesce((
    select jsonb_agg(it_ticket_json(t) order by
             (t.status = 'resolved'),
             case t.urgency when 'high' then 0 when 'medium' then 1 else 2 end,
             t.opened_at desc)
      from it_tickets t
     where (nullif(p_status, '') is null or t.status = p_status)
       and (nullif(p_urgency, '') is null or t.urgency = p_urgency)), '[]'::jsonb);
end;
$$;

create or replace function it_reply(p_ticket bigint, p_body text) returns void
language plpgsql security definer as $$
declare v_it boolean := it_is_it();
begin
  perform it_require_staff();
  if coalesce(btrim(p_body), '') = '' then
    raise exception 'Write something before sending.';
  end if;
  if not exists (select 1 from it_tickets t where t.id = p_ticket
                   and (v_it or lower(t.opened_by) = lower(current_actor()))) then
    raise exception 'There is no such ticket.';
  end if;
  insert into it_ticket_messages (ticket_id, from_it, body)
  values (p_ticket, v_it, btrim(p_body));
  update it_tickets set updated_at = now() where id = p_ticket;
end;
$$;

create or replace function it_set_status(p_ticket bigint, p_status text) returns void
language plpgsql security definer as $$
begin
  perform it_require_it();
  if p_status not in ('pending','in_progress','resolved') then
    raise exception 'Unknown status.';
  end if;
  update it_tickets set status = p_status, updated_at = now() where id = p_ticket;
  if not found then raise exception 'There is no such ticket.'; end if;
end;
$$;

create or replace function it_waiting() returns int
language plpgsql stable security definer as $$
begin
  perform it_require_it();
  return (select count(*)::int from it_tickets where status = 'pending');
end;
$$;

create or replace function it_people() returns text[]
language plpgsql stable security definer as $$
begin
  perform it_require_it();
  return coalesce((select array_agg(name order by name) from employees
                    where ended_on is null), '{}');
end;
$$;

alter function it_is_it() set search_path = public, extensions;
alter function it_require_it() set search_path = public, extensions;
alter function it_queue(text, text) set search_path = public, extensions;
alter function it_reply(bigint, text) set search_path = public, extensions;
alter function it_set_status(bigint, text) set search_path = public, extensions;
alter function it_waiting() set search_path = public, extensions;
alter function it_people() set search_path = public, extensions;
grant execute on function it_is_it() to app_client;
grant execute on function it_require_it() to app_client;

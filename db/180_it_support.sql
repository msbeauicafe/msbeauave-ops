-- IT support: desktop support and hardware fixes.
--
-- One person does the IT here, and until now a broken printer reached them as
-- a shout across the floor or a message lost in a group chat. This is a queue
-- instead: anybody who works here writes the problem down once — who, which
-- department, which desk, what is wrong, how urgent — and follows the replies
-- on the same ticket. The IT side (the owner's sign-in) sees every ticket,
-- moves it Pending → In progress → Resolved, and answers on it.
--
-- Nobody reads these tables directly. Every read and write goes through a
-- function below that decides whose tickets the caller may see: their own,
-- or — for admin — all of them. A role that is not on the list is refused
-- past the router too, because a route list can be rewritten tomorrow.

create table it_tickets (
  id          bigint generated always as identity primary key,
  opened_by   text not null default current_actor(),
  name        text not null check (btrim(name) <> ''),
  department  text,
  desk        text,
  issue       text not null check (btrim(issue) <> ''),
  urgency     text not null default 'medium' check (urgency in ('low','medium','high')),
  status      text not null default 'pending'
                check (status in ('pending','in_progress','resolved')),
  opened_at   timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index it_tickets_by_opener on it_tickets (lower(opened_by));

create table it_ticket_messages (
  id         bigint generated always as identity primary key,
  ticket_id  bigint not null references it_tickets (id) on delete cascade,
  author     text not null default current_actor(),
  from_it    boolean not null default false,
  body       text not null check (btrim(body) <> ''),
  at         timestamptz not null default now()
);
create index it_ticket_messages_by_ticket on it_ticket_messages (ticket_id, at);

-- Locked to everybody; the functions are the only way in.
alter table it_tickets enable row level security;
alter table it_ticket_messages enable row level security;

-- Everybody who works here and signs in to the back office. Not a reseller,
-- not the door tablet, and not view-only.
create or replace function it_require_staff() returns void
language plpgsql stable as $$
begin
  perform require_role('admin','warehouse','cashier','supervisor','office',
                       'datacoord','orderdesk','hr','employee');
end;
$$;

-- One ticket with its conversation, oldest message first.
create or replace function it_ticket_json(t it_tickets) returns jsonb
language sql stable security definer as $$
  select to_jsonb(t) || jsonb_build_object('messages', coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', m.id, 'author', m.author, 'from_it', m.from_it,
             'body', m.body, 'at', m.at) order by m.at, m.id)
      from it_ticket_messages m where m.ticket_id = t.id), '[]'::jsonb));
$$;

create or replace function it_submit(
  p_name text, p_department text, p_desk text, p_issue text, p_urgency text
) returns bigint
language plpgsql security definer as $$
declare v_id bigint;
begin
  perform it_require_staff();
  if coalesce(btrim(p_issue), '') = '' then
    raise exception 'Say what is wrong before sending.';
  end if;
  if coalesce(p_urgency, '') not in ('low','medium','high') then
    raise exception 'Pick how urgent it is.';
  end if;
  insert into it_tickets (name, department, desk, issue, urgency)
  values (coalesce(nullif(btrim(p_name), ''), current_actor()),
          nullif(btrim(coalesce(p_department, '')), ''),
          nullif(btrim(coalesce(p_desk, '')), ''),
          btrim(p_issue), p_urgency)
  returning id into v_id;
  insert into it_ticket_messages (ticket_id, body) values (v_id, btrim(p_issue));
  return v_id;
end;
$$;

-- The caller's own tickets, newest first.
create or replace function it_my_tickets() returns jsonb
language plpgsql stable security definer as $$
begin
  perform it_require_staff();
  return coalesce((
    select jsonb_agg(it_ticket_json(t) order by t.updated_at desc, t.id desc)
      from it_tickets t where lower(t.opened_by) = lower(current_actor())), '[]'::jsonb);
end;
$$;

-- Everybody's, for IT. Filters are optional.
create or replace function it_queue(p_status text default null, p_urgency text default null)
returns jsonb
language plpgsql stable security definer as $$
begin
  perform require_role('admin');
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

-- A message on a ticket. IT may answer any ticket; anybody else only their own.
create or replace function it_reply(p_ticket bigint, p_body text) returns void
language plpgsql security definer as $$
declare v_it boolean := current_role_name() = 'admin';
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
  perform require_role('admin');
  if p_status not in ('pending','in_progress','resolved') then
    raise exception 'Unknown status.';
  end if;
  update it_tickets set status = p_status, updated_at = now() where id = p_ticket;
  if not found then raise exception 'There is no such ticket.'; end if;
end;
$$;

-- What the IT menu's badge counts: tickets nobody has started on yet.
create or replace function it_waiting() returns int
language plpgsql stable security definer as $$
begin
  perform require_role('admin');
  return (select count(*)::int from it_tickets where status = 'pending');
end;
$$;

alter function it_require_staff() set search_path = public, extensions;
alter function it_ticket_json(it_tickets) set search_path = public, extensions;
alter function it_submit(text, text, text, text, text) set search_path = public, extensions;
alter function it_my_tickets() set search_path = public, extensions;
alter function it_queue(text, text) set search_path = public, extensions;
alter function it_reply(bigint, text) set search_path = public, extensions;
alter function it_set_status(bigint, text) set search_path = public, extensions;
alter function it_waiting() set search_path = public, extensions;

revoke all on function it_ticket_json(it_tickets) from public;
revoke all on function it_submit(text, text, text, text, text) from public;
revoke all on function it_my_tickets() from public;
revoke all on function it_queue(text, text) from public;
revoke all on function it_reply(bigint, text) from public;
revoke all on function it_set_status(bigint, text) from public;
revoke all on function it_waiting() from public;

grant execute on function it_require_staff() to app_client;
grant execute on function it_submit(text, text, text, text, text) to app_client;
grant execute on function it_my_tickets() to app_client;
grant execute on function it_queue(text, text) to app_client;
grant execute on function it_reply(bigint, text) to app_client;
grant execute on function it_set_status(bigint, text) to app_client;
grant execute on function it_waiting() to app_client;

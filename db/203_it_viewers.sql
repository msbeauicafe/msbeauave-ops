-- IT support's dashboard and hardware assets, open to look at — not to
-- change — for admins the owner names. IT stays one person (db/182): the IT
-- sign-in alone moves tickets, answers as IT, and adds, assigns, checks or
-- removes anything. A viewer sees the same queue, masterlist, company
-- property and accountability forms, and nothing they press can write.
--
-- How it holds: every IT function already begins with it_require_it(). It
-- now also lets a viewer through — but only inside a read-only transaction,
-- which the server opens for a viewer's IT reads and never for a write. A
-- viewer's write therefore reaches the same check in an ordinary
-- transaction and is refused, function by function, past the router.

alter table app_users add column if not exists it_view boolean not null default false;

-- The owner's choice: Angelhita Laranang Labios may view IT support.
update app_users set it_view = true
 where role = 'admin'
   and (lower(display_name) like '%angelhita%' or lower(username) like '%angelhita%');

-- May I look at IT support? IT itself, or an admin marked as a viewer.
create or replace function it_can_view() returns boolean
language sql stable security definer as $$
  select current_role_name() = 'admin' and exists (
    select 1 from app_users u
     where lower(u.username) = lower(current_actor()) and u.active and (u.is_it or u.it_view));
$$;
alter function it_can_view() set search_path = public, extensions;

create or replace function it_require_it() returns void
language plpgsql stable security definer as $$
begin
  if it_is_it() then return; end if;
  -- A viewer, reading: the transaction itself cannot write.
  if it_can_view() and current_setting('transaction_read_only') = 'on' then return; end if;
  raise exception 'FORBIDDEN: only IT may do that' using errcode = '42501';
end;
$$;
alter function it_require_it() set search_path = public, extensions;

revoke all on function it_can_view() from public;
grant execute on function it_can_view() to app_client;

-- IT support's view-only access (db/203) was for admins; the owner's pick,
-- Angelhita Laranang Labios, signs in as HR / Operations. A viewer may now be
-- an admin or an HR sign-in — still only one the owner has marked, still able
-- to look and never to change: the read-only transaction is the only door
-- (db/203), and IT itself stays the one IT sign-in.

update app_users set it_view = true
 where role in ('admin', 'hr')
   and (lower(display_name) like '%angelhita%' or lower(username) like '%angelhita%');

create or replace function it_can_view() returns boolean
language sql stable security definer as $$
  select (current_role_name() = 'admin' and exists (
            select 1 from app_users u
             where lower(u.username) = lower(current_actor()) and u.active and (u.is_it or u.it_view)))
      or (current_role_name() = 'hr' and exists (
            select 1 from app_users u
             where lower(u.username) = lower(current_actor()) and u.active and u.it_view));
$$;
alter function it_can_view() set search_path = public, extensions;

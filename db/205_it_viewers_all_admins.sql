-- Every admin may now look at IT support — the owner's sign-in (Ms Beau) and
-- the other admins — not only those marked one by one (db/203). Still view
-- only: the read-only transaction is the only door a viewer has, and IT is
-- still the one IT sign-in. HR sign-ins still need the owner's mark (db/204).

create or replace function it_can_view() returns boolean
language sql stable security definer as $$
  select (current_role_name() = 'admin' and exists (
            select 1 from app_users u
             where lower(u.username) = lower(current_actor()) and u.active))
      or (current_role_name() = 'hr' and exists (
            select 1 from app_users u
             where lower(u.username) = lower(current_actor()) and u.active and u.it_view));
$$;
alter function it_can_view() set search_path = public, extensions;

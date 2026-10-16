-- Company property gets a fourth kind: office supplies and tools — the
-- staplers, scissors, punchers and tape dispensers each desk is given. A
-- shredder or laminator stays an appliance. Same register, same rooms, same
-- history (db/196); only the list of kinds grows.

alter table it_property drop constraint if exists it_property_category_check;
alter table it_property add constraint it_property_category_check
  check (category in ('device', 'appliance', 'furniture', 'supplies'));

-- Employees work at two branches, so IT's by-employee lists group people
-- under their branch: each current employee's name with their branch's.
create or replace function it_people_branches() returns jsonb
language plpgsql stable security definer as $$
begin
  perform it_require_it();
  return coalesce((select jsonb_agg(jsonb_build_object('name', e.name, 'branch', b.name) order by e.name)
                     from employees e left join branches b on b.id = e.branch_id
                    where e.ended_on is null), '[]'::jsonb);
end;
$$;
alter function it_people_branches() set search_path = public, extensions;
revoke all on function it_people_branches() from public;
grant execute on function it_people_branches() to app_client;

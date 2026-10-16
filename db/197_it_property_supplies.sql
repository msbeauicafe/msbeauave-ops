-- Company property gets a fourth kind: office supplies and tools — the
-- staplers, scissors, punchers and tape dispensers each desk is given. A
-- shredder or laminator stays an appliance. Same register, same rooms, same
-- history (db/196); only the list of kinds grows.

alter table it_property drop constraint if exists it_property_category_check;
alter table it_property add constraint it_property_category_check
  check (category in ('device', 'appliance', 'furniture', 'supplies'));

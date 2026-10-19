-- Company property's kinds grow by two: desktops and laptops kept as company
-- property in a room — the hallway's shared PC, the meeting room's laptop —
-- with their own tag series (MSBA-DSK-001, MSBA-LPT-001), filter and count,
-- alongside devices, appliances, furniture and office supplies.

alter table it_property drop constraint if exists it_property_category_check;
alter table it_property add constraint it_property_category_check
  check (category in ('device', 'appliance', 'furniture', 'supplies', 'desktop', 'laptop'));

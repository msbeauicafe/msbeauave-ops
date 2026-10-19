-- Company property is the same register as the masterlist, room by room, so
-- its kinds now follow the masterlist's hardware types: printers, monitors,
-- smartphones, iPhones and peripherals join desktops and laptops, each with
-- its own tag series (MSBA-PRT-001, MSBA-MNT-001 …), filter and count.

alter table it_property drop constraint if exists it_property_category_check;
alter table it_property add constraint it_property_category_check
  check (category in ('device', 'appliance', 'furniture', 'supplies', 'desktop', 'laptop',
                      'printer', 'monitor', 'smartphone', 'iphone', 'peripheral'));

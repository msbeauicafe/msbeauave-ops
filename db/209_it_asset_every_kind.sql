-- The masterlist's hardware types take every kind Company property has:
-- devices, appliances, furniture and office supplies join the computers,
-- phones, monitors, printers and peripherals, each with its own tag series
-- (MSBA-DVC-001, MSBA-APL-001, MSBA-FRN-001, MSBA-OFS-001). The two lists
-- are one register, so a unit logged here shows under the same kind there.

alter table it_assets drop constraint if exists it_assets_kind_check;
alter table it_assets add constraint it_assets_kind_check
  check (kind in ('laptop', 'desktop', 'imac', 'smartphone', 'iphone', 'monitor', 'printer', 'peripheral',
                  'device', 'appliance', 'furniture', 'supplies'));

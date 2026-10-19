-- The masterlist's hardware types gain the printer, with its own tag series
-- (MSBA-PRN-001), filter and icon — a unit IT receives, tags, assigns and
-- checks like any other.

alter table it_assets drop constraint if exists it_assets_kind_check;
alter table it_assets add constraint it_assets_kind_check
  check (kind in ('laptop', 'desktop', 'imac', 'smartphone', 'iphone', 'monitor', 'printer', 'peripheral'));

-- The masterlist's hardware types grow by two the shop actually buys: the
-- iPhone and the iMac, each with its own tag series (MSBA-IPH-001,
-- MSBA-IMAC-001) and filter, rather than filed as "Smartphone" or "Desktop".

alter table it_assets drop constraint if exists it_assets_kind_check;
alter table it_assets add constraint it_assets_kind_check
  check (kind in ('laptop', 'desktop', 'imac', 'smartphone', 'iphone', 'monitor', 'peripheral'));

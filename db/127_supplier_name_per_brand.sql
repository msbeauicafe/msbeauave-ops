-- ============================================================================
-- MS BEAU AVE — one person, several brands, several supplier rows
--
-- The same person supplies more than one brand — Adolfo, Blessy Ann sells
-- both Cris Cosmetics Glam Beauty and whatever else she carries — and each
-- brand is its own account: its own orders, its own billing, its own
-- standing. The unique index on name alone made that impossible without a
-- typo or a trailing space to slip past it, which is how "DAGASDAS, KATHLYN"
-- and "DAGASDAS, KATHLYN S." ended up as two rows for the same reason a
-- clean second row should have been enough.
--
-- The name repeats now; the name and the brand together do not.
-- ============================================================================

drop index if exists suppliers_by_name;
create unique index if not exists suppliers_by_name_brand
  on suppliers (lower(name), lower(coalesce(brand_name, '')));

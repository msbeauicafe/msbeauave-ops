-- ============================================================================
-- MS BEAU AVE — what the reseller list asks, and how it finds it
--
-- The list asks four questions of every account, every time it draws: what
-- they owe, whether anything is past due, how often they have paid on time,
-- and — since the list now leads with whoever was invoiced most recently —
-- which of their invoices is the newest one still open.
--
-- Two of those had nothing to look them up by. Every draw read the whole
-- invoice table and the whole event log once per reseller, two hundred and
-- forty-two times over, for answers of two rows and none. It cost 63ms and
-- would have grown with the business rather than with the question.
--
-- 17ms now, with the extra question added on top. The open-invoice lookup
-- already had invoices_outstanding to use, which is why leading with the
-- newest invoice was cheap to ask for.
-- ============================================================================

create index if not exists invoices_settled_by_reseller
  on invoices (reseller_id) where status = 'paid';

-- Covering, so the ninety-day count is answered out of the index without
-- reading the rows at all.
create index if not exists reseller_events_by_reseller_kind
  on reseller_events (reseller_id, kind, at desc);

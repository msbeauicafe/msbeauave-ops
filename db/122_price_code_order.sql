-- ============================================================================
-- MS BEAU AVE — the price list's own order, not the order codes were added in
--
-- STOCKLIST, LEADERS, BUSINESS LEADER, BUSINESS and DEPOT each landed on the
-- price list the day somebody typed add_price_code for it, so they sorted in
-- the order they were asked for rather than the order the shop actually
-- reaches for them. That put DEPOT — a price hardly anything is sold at —
-- sitting directly in front of SRP, with BUSINESS and BUSINESS LEADER on the
-- wrong sides of LEADERS and STOCKLIST out of the ladder somebody actually
-- climbs it in.
--
-- RD, SUB RD, PD, CD, DD and RS keep the sort they were given at the start.
-- What moves is everything after RS: DEPOT first, then BUSINESS, BUSINESS
-- LEADER, LEADERS, STOCKLIST — SRP is still not a row here (it is the
-- product's own column, not a price_codes entry) and stays wherever the
-- screen that reads it already puts it: last.
-- ============================================================================

update price_codes set sort = v.sort
  from (values
    ('DEPOT',           71),
    ('BUSINESS',        72),
    ('BUSINESS LEADER', 73),
    ('LEADERS',         74),
    ('STOCKLIST',       75)
  ) v(code, sort)
 where price_codes.code = v.code;

-- ============================================================================
-- Credit does not disappear once it has nowhere open to sit
--
-- ar_ageing lists a reseller by joining to their open invoices — which is
-- right for a report about what is owed, but it means a reseller who has
-- only ever been in credit, with no invoice currently open, is invisible to
-- it. Money the shop is holding that belongs to somebody else should not be
-- a fact only visible one account at a time, on that one account's own page.
-- ============================================================================
create or replace view ar_credit_holders as
select r.id as reseller_id, r.name, r.tier, reseller_credit_balance(r.id) as credit
  from resellers r
 where reseller_credit_balance(r.id) > 0
 order by credit desc;

-- db/003_views_and_access.sql granted select on "all tables in schema
-- public" once, against what existed that day. A view created here needs
-- its own line, the same lesson db/047 already paid for.
grant select on ar_credit_holders to app_client;

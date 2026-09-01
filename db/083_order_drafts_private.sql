-- ============================================================================
-- MS BEAU AVE — a saved draft is the taker's own
--
-- Drafts began as the desk's shared shelf: admin and the order desk could see
-- every parked basket. In practice each order-taker wants only their own —
-- somebody else's half-finished order in your list is noise, and reopening it
-- by mistake puts you on the wrong customer. So a draft is now private to
-- whoever saved it. Still the desk's job, still closed to everyone else; only
-- now closed to the rest of the desk too, each to their own.
-- ============================================================================

drop policy if exists desk_order_drafts on order_drafts;
create policy desk_order_drafts on order_drafts for all
  using (current_role_name() in ('admin', 'orderdesk')
         and saved_by = current_actor())
  with check (current_role_name() in ('admin', 'orderdesk')
              and saved_by = current_actor());

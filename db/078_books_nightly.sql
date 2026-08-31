-- ============================================================================
-- MS BEAU AVE — Books: the nightly sweep
--
-- Auto-posting (Phase 5) runs when the owner opens the Books, and on the button.
-- This is the same sweep run for them while they sleep: a job the database
-- itself fires once a night, so the books are current every morning whether or
-- not anyone opened the app.
--
-- The sweep is guarded by require_role('admin'), which reads the app.role the
-- web request sets. A scheduled job has no web request and no sign-in, so this
-- wrapper puts on the owner's hat for the length of one transaction and runs it,
-- attributing the postings to 'nightly'. It is SECURITY DEFINER and executable
-- by nobody but its owner and the scheduler — no route calls it, and it is
-- revoked from the app's role — so it cannot become a back door around the
-- sign-in gate.
--
-- The pg_cron schedule that calls this lives in db/ops/nightly_cron.sql, applied
-- to the production database only (the throwaway test cluster has no pg_cron).
-- Everything here is plain SQL that the test suite runs like any other function.
-- ============================================================================

create or replace function run_book_sync_job() returns jsonb
language plpgsql security definer as $$
declare j jsonb;
begin
  -- The owner's hat, for this transaction only.
  perform set_config('app.role',  'admin',   true);
  perform set_config('app.actor', 'nightly', true);
  j := sync_books();
  return j;
end;
$$;
alter function run_book_sync_job() set search_path = public, extensions;

-- No one but the owner (postgres) and the scheduler runs it.
revoke all on function run_book_sync_job() from public;

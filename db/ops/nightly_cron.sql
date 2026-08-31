-- ============================================================================
-- MS BEAU AVE — Books: the nightly schedule (PRODUCTION ONLY)
--
-- This file is deliberately NOT under db/0*.sql, so the test harness (which
-- loads db/0*.sql into a throwaway Postgres cluster with no pg_cron) never runs
-- it. It is applied to the production Supabase database by hand.
--
-- It turns on pg_cron and schedules run_book_sync_job() (db/078_books_nightly.sql)
-- to sweep the day's trading into the books every night. The time is 18:00 UTC,
-- which is 02:00 the next day in Manila (UTC+8) — a quiet hour, after the day's
-- selling is done, so every morning opens with the books already current.
-- ============================================================================

create extension if not exists pg_cron;

-- Idempotent: drop a prior job of this name before scheduling, so re-applying
-- this file does not stack duplicate jobs.
select cron.unschedule('books-nightly-sync')
 where exists (select 1 from cron.job where jobname = 'books-nightly-sync');

select cron.schedule('books-nightly-sync', '0 18 * * *', $$ select run_book_sync_job(); $$);

-- To see it:        select jobid, schedule, jobname, active from cron.job where jobname='books-nightly-sync';
-- To see its runs:  select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname='books-nightly-sync') order by start_time desc limit 10;
-- To stop it:       select cron.unschedule('books-nightly-sync');

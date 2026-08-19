-- ============================================================================
-- MS BEAU AVE — the times on the door board
--
-- The board already knew who was on shift; it did not know when they arrived,
-- and the moment somebody clocked out it forgot they had been in at all.
-- Standing at the door, that is the question people actually ask: what time
-- did I come in, and what time did I go.
--
-- Today's most recent stretch, not the day summed. Somebody who clocks out at
-- lunch and back in again should see the stretch they are in now, not an
-- arrival from four hours ago paired with a departure that has already been
-- superseded. It also keeps these two columns agreeing with `since`, which is
-- the open shift and nothing else.
--
-- Appended at the end of `team` rather than slotted in among its columns:
-- create or replace view will add columns at the end and refuses anything
-- else. Everything else about the view is left exactly as it was, joins
-- included — a widened join here would quietly change who appears on a board
-- at a door.
-- ============================================================================
create or replace view team as
select e.id, e.name, e.position, e.phone, e.started_on, e.ended_on, e.note,
       (e.ended_on is null) as here,
       e.user_id, u.username, u.role as signs_in_as,
       (ph.employee_id is not null) as has_photo,
       (s.id is not null) as on_shift,
       s.started_at as since,
       coalesce((select sum(coalesce(sh.ended_at, now()) - sh.started_at)
                   from shifts sh
                  where sh.employee_id = e.id
                    and sh.business_date > (now() at time zone 'Asia/Manila')::date - 7),
                interval '0') as hours_this_week,
       (e.pin_hash is not null) as has_pin,
       e.branch_id, br.name as branch,
       (select sh.started_at from shifts sh
         where sh.employee_id = e.id
           and sh.business_date = (now() at time zone 'Asia/Manila')::date
         order by sh.started_at desc limit 1) as today_in,
       (select sh.ended_at from shifts sh
         where sh.employee_id = e.id
           and sh.business_date = (now() at time zone 'Asia/Manila')::date
         order by sh.started_at desc limit 1) as today_out
  from employees e
  left join app_users u on u.id = e.user_id
  left join employee_photos ph on ph.employee_id = e.id
  left join shifts s on s.employee_id = e.id and s.ended_at is null
  join branches br on br.id = e.branch_id
 order by (e.ended_on is null) desc, e.name;

grant select on team to app_client;

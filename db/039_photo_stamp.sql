-- ============================================================================
-- MS BEAU AVE — a photograph fetched once
--
-- The board at a door redraws every twenty seconds and each face is cached for
-- sixty, so a screen left running pulls every photograph on the wall down again
-- every minute — twenty-eight of them, through the agent, forever. Some lose
-- the race, and a face that fails to load is simply a blank circle: no error,
-- no retry, and a person who cannot find themselves on the board.
--
-- The fix is the one already used for product pictures: put the moment the
-- photograph was last changed in the address. A URL that changes only when the
-- picture changes can be cached for a day, so the board fetches each face once
-- and then stops asking.
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
         order by sh.started_at desc limit 1) as today_out,
       ph.updated_at as photo_at
  from employees e
  left join app_users u on u.id = e.user_id
  left join employee_photos ph on ph.employee_id = e.id
  left join shifts s on s.employee_id = e.id and s.ended_at is null
  join branches br on br.id = e.branch_id
 order by (e.ended_on is null) desc, e.name;

grant select on team to app_client;

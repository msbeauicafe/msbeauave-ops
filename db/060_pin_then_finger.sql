-- ============================================================================
-- MS BEAU AVE — the PIN first, then the finger
--
-- The two credentials have not changed. Their order has, and the order is the
-- whole point.
--
-- Finger-first meant the scanner was always listening, and a scanner that is
-- always listening answers a finger that was never offered on purpose: a hand
-- resting on the glass, somebody leaning past to reach a bag. Every one of
-- those opened a window with a name on it. Worse, the person could not tell
-- whether their press had registered — the door takes a second to answer — so
-- they pressed again, and the log from Beauty Obsession Ave has somebody in
-- and out four times inside a minute. That is not somebody testing a scanner.
-- It is somebody who could not tell whether it had worked.
--
-- PIN-first fixes both by making the press deliberate and the last thing that
-- happens. You say who you are and what you meant; the glass only confirms it.
-- A finger with no window open behind it now records nothing at all, which
-- means a hand on the glass is just a hand on the glass, and there is exactly
-- one press to make.
--
-- Nothing is installed at either door for this. The program there does what it
-- always did — tell the website who it recognised and let the website decide —
-- and it is the deciding that has moved.
--
-- The window itself is unchanged, and so is the table: open_clock_confirmation
-- already refused to open one for anybody with no finger enrolled, which under
-- the old order meant "the door cannot have matched you" and under the new one
-- means "you have nothing to confirm with, so your PIN stands alone". The same
-- check, still right, for the opposite reason.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Spending the window with a finger
--
-- The ticket is not passed through the door program and does not need to be.
-- The finger IS the second thing: the door matched it against templates it
-- holds for this shop, and what arrives here is a name to spend a window on.
-- So this is by employee rather than by ticket, and the newest open window is
-- the one meant — somebody who typed their PIN twice has two, and it is the
-- one they are standing in front of that counts.
--
-- Single-use, by used_at. That is what makes a second press harmless: the
-- window is gone, the finger records nothing, and nobody is clocked back out
-- by pressing again to check that the first press worked.
-- ---------------------------------------------------------------------------
create or replace function confirm_clock_by_finger(
  p_employee bigint, p_branch bigint default null)
returns bigint language plpgsql security definer as $$
declare v_id bigint;
begin
  perform require_role('admin', 'cashier', 'warehouse', 'timekeeper');

  update clock_confirmations c set used_at = now()
   where c.id = (
     select c2.id from clock_confirmations c2
      where c2.employee_id = p_employee
        and c2.used_at is null
        and c2.expires_at >= now()
        and (p_branch is null or c2.branch_id is null or c2.branch_id = p_branch)
      order by c2.created_at desc
      limit 1
      for update)
   returning c.id into v_id;

  -- One answer for a finger nobody was waiting on and a finger pressed twice.
  -- A screen by a door is not a place to learn who has just clocked on.
  if not found then
    raise exception 'Type your PIN first, then press your finger.'
      using errcode = 'P0009';
  end if;
  return v_id;
end;
$$;

-- Has this person got a finger to confirm with?
--
-- Asked before a window is opened, because somebody with no fingerprint on
-- file must not be sent to a scanner they can never satisfy. Their PIN is the
-- whole of their credential and always was.
create or replace function employee_has_finger(p_employee bigint)
returns boolean language sql stable security definer as $$
  select exists (select 1 from employee_fingers f where f.employee_id = p_employee);
$$;

alter function confirm_clock_by_finger(bigint, bigint) set search_path = public, extensions;
alter function employee_has_finger(bigint)             set search_path = public, extensions;
revoke all on function confirm_clock_by_finger(bigint, bigint) from public;
revoke all on function employee_has_finger(bigint)             from public;
grant execute on function confirm_clock_by_finger(bigint, bigint) to app_client;
grant execute on function employee_has_finger(bigint)             to app_client;

-- ---------------------------------------------------------------------------
-- Who has a finger to confirm with
--
-- The board at the door needs to know, because the pad it opens should say
-- what comes next and only some people have a next. Whether a template exists
-- — never the template. Appended to the end of the view, which is the only
-- place create-or-replace allows a column to go.
-- ---------------------------------------------------------------------------
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
       ph.updated_at as photo_at,
       exists (select 1 from employee_fingers f where f.employee_id = e.id) as has_finger
  from employees e
  left join app_users u on u.id = e.user_id
  left join employee_photos ph on ph.employee_id = e.id
  left join shifts s on s.employee_id = e.id and s.ended_at is null
  join branches br on br.id = e.branch_id
 order by (e.ended_on is null) desc, e.name;

grant select on team to app_client;

-- What the abandoned windows mean now.
--
-- The rows are the same rows and the report is the same report, but a window
-- with no finger after it used to read "a finger nobody could confirm" and now
-- reads "a PIN nobody stood behind". Both are worth seeing; only the sentence
-- underneath them on the HR screen changes, and that lives in the app.
comment on table clock_confirmations is
  'A clocking half-made: the PIN named somebody and opened a window, and the '
  'finger that confirms it has not arrived. Unused rows are kept on purpose.';

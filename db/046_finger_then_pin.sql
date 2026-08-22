-- ============================================================================
-- MS BEAU AVE — a finger, then a PIN
--
-- A fingerprint says who is standing at the door. It does not say that they
-- meant to clock, and it is the one credential nobody can change if it is ever
-- copied. So a match no longer records anything by itself: it opens a short
-- window in which that person, and only that person, may confirm with the PIN
-- only they know. Two things, one of which is a secret.
--
-- Nothing is installed at either door for this and nobody copies a file onto
-- the MBA door PC. The program there does not read the website's answer — it
-- hands whatever comes back to the screen, which is served from the web and
-- updates by itself. So the shape of that answer is ours to change: it used to
-- say "clocked in", and now it says "who this is, now ask them for the PIN".
--
-- What is deliberately kept: clock_by_finger, untouched and still able to
-- clock somebody straight in. The database is migrated before the API that
-- uses these functions is deployed, and during that gap the old API keeps
-- calling it and the doors keep working. It is also one line of API to fall
-- back to if the confirming step ever has to be switched off at six in the
-- morning with a queue at the door.
--
-- The rows here are not scratch. A match that was never confirmed is somebody
-- whose finger opened a window and who could not produce their PIN, which is
-- worth being able to look up later, so they are kept rather than cleaned out.
-- ============================================================================

create table if not exists clock_confirmations (
  id           bigint generated always as identity primary key,
  employee_id  bigint not null references employees (id),
  branch_id    bigint references branches (id),
  -- The ticket itself is never stored. What is written down cannot be used to
  -- confirm anybody, the same way a password is kept.
  ticket_hash  text not null unique,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  tries        int not null default 0,
  used_at      timestamptz,
  opened_by    text not null default current_actor()
);

create index if not exists clock_confirmations_open
  on clock_confirmations (expires_at) where used_at is null;

-- ---------------------------------------------------------------------------
-- Opening the window
--
-- The same checks clock_by_finger makes, because this now stands where it
-- stood: on the team, at this door, and with a finger actually enrolled.
-- Nothing about the person is returned that the door does not already know —
-- it matched them a moment ago.
-- ---------------------------------------------------------------------------
create or replace function open_clock_confirmation(
  p_employee bigint, p_branch bigint, p_hash text, p_seconds int default 90)
returns table (name text, expires_at timestamptz, has_pin boolean)
language plpgsql security definer as $$
declare v_name text; v_pin boolean; v_expires timestamptz;
begin
  perform require_role('admin', 'cashier', 'warehouse', 'timekeeper');
  if coalesce(p_hash, '') = '' then
    raise exception 'A confirmation needs a ticket.';
  end if;

  select e.name, e.pin_hash is not null into v_name, v_pin
    from employees e
   where e.id = p_employee
     and e.ended_on is null
     and (p_branch is null or e.branch_id = p_branch)
     and exists (select 1 from employee_fingers f where f.employee_id = e.id);

  if not found then
    raise exception 'That finger does not belong to anybody here.'
      using errcode = 'P0007';
  end if;

  v_expires := now() + make_interval(secs => greatest(least(p_seconds, 300), 15));
  insert into clock_confirmations (employee_id, branch_id, ticket_hash, expires_at)
  values (p_employee, p_branch, p_hash, v_expires);

  return query select v_name, v_expires, v_pin;
end;
$$;

-- ---------------------------------------------------------------------------
-- Spending it
--
-- Two steps, because the PIN is checked outside the database — scrypt is not
-- something SQL can do. This one says whose PIN to check and counts the try;
-- the next one is only reached if that PIN was right.
--
-- The try is counted here rather than after the check, so a wrong PIN costs an
-- attempt whatever happens next. Three of them and the ticket is dead, which
-- is what stops somebody holding a stranger's finger to the glass and then
-- working through four-digit numbers.
-- ---------------------------------------------------------------------------
create or replace function claim_clock_confirmation(p_hash text)
returns bigint language plpgsql security definer as $$
declare v_row clock_confirmations%rowtype;
begin
  perform require_role('admin', 'cashier', 'warehouse', 'timekeeper');

  select * into v_row from clock_confirmations
   where ticket_hash = p_hash for update;

  -- One answer for a ticket that never existed and one that has been spent.
  -- A screen by a door is not a place to learn which tickets are real.
  if not found or v_row.used_at is not null or v_row.expires_at < now()
     or v_row.tries >= 3 then
    raise exception 'That confirmation has expired. Press your finger again.'
      using errcode = 'P0008';
  end if;

  update clock_confirmations set tries = tries + 1 where id = v_row.id;
  return v_row.employee_id;
end;
$$;

create or replace function finish_clock_confirmation(p_hash text)
returns bigint language plpgsql security definer as $$
declare v_id bigint; v_employee bigint;
begin
  perform require_role('admin', 'cashier', 'warehouse', 'timekeeper');

  update clock_confirmations set used_at = now()
   where ticket_hash = p_hash and used_at is null and expires_at >= now()
   returning id, employee_id into v_id, v_employee;

  if not found then
    raise exception 'That confirmation has expired. Press your finger again.'
      using errcode = 'P0008';
  end if;
  return v_employee;
end;
$$;

-- Matches that were never confirmed. A finger opened a window and no PIN
-- followed it — worth being able to look at, which is why the rows stay.
create or replace function unconfirmed_matches(p_day date default null)
returns table (name text, branch text, at timestamptz, tries int)
language plpgsql stable security definer as $$
declare v_day date := coalesce(p_day, (now() at time zone 'Asia/Manila')::date);
begin
  perform require_role('admin', 'observer');
  return query
  select e.name, b.name, c.created_at, c.tries
    from clock_confirmations c
    join employees e on e.id = c.employee_id
    left join branches b on b.id = c.branch_id
   where c.used_at is null
     and (c.created_at at time zone 'Asia/Manila')::date = v_day
   order by c.created_at desc;
end;
$$;

alter table clock_confirmations enable row level security;
drop policy if exists admin_reads_confirmations on clock_confirmations;
create policy admin_reads_confirmations on clock_confirmations for select
  to app_client using (current_setting('app.role', true) in ('admin', 'observer'));

grant select on clock_confirmations to app_client;
grant execute on function open_clock_confirmation(bigint, bigint, text, int) to app_client;
grant execute on function claim_clock_confirmation(text) to app_client;
grant execute on function finish_clock_confirmation(text) to app_client;
grant execute on function unconfirmed_matches(date) to app_client;
revoke all on function open_clock_confirmation(bigint, bigint, text, int) from public;
revoke all on function claim_clock_confirmation(text) from public;
revoke all on function finish_clock_confirmation(text) from public;
revoke all on function unconfirmed_matches(date) from public;

alter function open_clock_confirmation(bigint, bigint, text, int)
  set search_path = public, extensions;
alter function claim_clock_confirmation(text)   set search_path = public, extensions;
alter function finish_clock_confirmation(text)  set search_path = public, extensions;
alter function unconfirmed_matches(date)        set search_path = public, extensions;

-- ============================================================================
-- MS BEAU AVE — the workspace
--
-- The part of the system that is about the team rather than the stock: what
-- everyone is telling each other, and what everyone has been asked to do.
--
-- Both tables are staff-only. A reseller signs in to the same application but
-- must never see an internal note or a task, so the policies below name the
-- three staff roles explicitly rather than excluding 'reseller' — a role added
-- later should have to be granted sight of this, not inherit it by omission.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- The feed
-- ---------------------------------------------------------------------------
create table posts (
  id        bigint generated always as identity primary key,
  author    text not null default current_actor(),
  body      text not null check (length(btrim(body)) > 0),
  posted_at timestamptz not null default now()
);
create index posts_recent on posts (posted_at desc);

-- ---------------------------------------------------------------------------
-- The task board
--
-- Three columns, because a board with more than three is a report. `assignee`
-- is nullable on purpose: a job nobody has picked up yet is a normal state and
-- should be visible as one, not hidden behind a placeholder owner.
-- ---------------------------------------------------------------------------
create table tasks (
  id         bigint generated always as identity primary key,
  title      text not null check (length(btrim(title)) > 0),
  detail     text,
  assignee   text,
  due_on     date,
  priority   text not null default 'normal' check (priority in ('normal','high')),
  status     text not null default 'todo' check (status in ('todo','doing','done')),
  raised_by  text not null default current_actor(),
  raised_at  timestamptz not null default now(),
  done_at    timestamptz,
  -- A task is done exactly when it carries the time it was finished. Letting
  -- those two disagree would make "what did we close last week" unanswerable.
  constraint done_has_a_time check ((status = 'done') = (done_at is not null))
);
create index tasks_board on tasks (status, priority desc, due_on);
create trigger tasks_audit after insert or update or delete on tasks
  for each row execute function write_audit();

-- ---------------------------------------------------------------------------
-- Writing
--
-- Same discipline as the rest of the engine: the application calls a function,
-- never an INSERT, so the rules hold no matter who is connected.
-- ---------------------------------------------------------------------------
create or replace function post_update(p_body text) returns bigint
language plpgsql security definer as $$
declare new_id bigint;
begin
  if current_role_name() not in ('admin', 'warehouse', 'cashier') then
    raise exception 'Only the team can post to the feed.';
  end if;
  insert into posts (body) values (btrim(p_body)) returning id into new_id;
  return new_id;
end;
$$;

create or replace function add_task(
  p_title text, p_assignee text default null,
  p_due date default null, p_priority text default 'normal',
  p_detail text default null) returns bigint
language plpgsql security definer as $$
declare new_id bigint;
begin
  if current_role_name() not in ('admin', 'warehouse', 'cashier') then
    raise exception 'Only the team can raise tasks.';
  end if;
  if p_assignee is not null
     and not exists (select 1 from app_users
                      where username = p_assignee and active
                        and role in ('admin', 'warehouse', 'cashier')) then
    raise exception 'There is no active team member called %.', p_assignee;
  end if;

  insert into tasks (title, detail, assignee, due_on, priority)
  values (btrim(p_title), nullif(btrim(coalesce(p_detail, '')), ''),
          p_assignee, p_due, p_priority)
  returning id into new_id;
  return new_id;
end;
$$;

-- Moving a card is the only edit the board needs, and it owns done_at so the
-- constraint above cannot be violated by a caller that forgot to set it.
create or replace function move_task(p_id bigint, p_status text) returns void
language plpgsql security definer as $$
begin
  if current_role_name() not in ('admin', 'warehouse', 'cashier') then
    raise exception 'Only the team can move tasks.';
  end if;
  if p_status not in ('todo', 'doing', 'done') then
    raise exception 'A task is either to do, in progress, or done.';
  end if;

  update tasks
     set status = p_status,
         done_at = case when p_status = 'done' then coalesce(done_at, now()) end
   where id = p_id;

  if not found then
    raise exception 'That task no longer exists.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reading
--
-- The feed and the board both want the person's name rather than their login,
-- so the join happens here instead of in every caller.
-- ---------------------------------------------------------------------------
create or replace view team_feed as
select p.id, p.body, p.posted_at, p.author,
       coalesce(u.display_name, p.author) as author_name
  from posts p left join app_users u on u.username = p.author
 order by p.posted_at desc;

create or replace view task_board as
select t.id, t.title, t.detail, t.status, t.priority, t.due_on,
       t.assignee, coalesce(u.display_name, t.assignee) as assignee_name,
       t.raised_by, t.raised_at, t.done_at,
       t.due_on is not null and t.due_on < current_date and t.status <> 'done' as overdue
  from tasks t left join app_users u on u.username = t.assignee
 order by t.priority desc, t.due_on nulls last, t.id;

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------
alter table posts enable row level security;
alter table tasks enable row level security;

create policy team_reads_posts on posts for select
  using (current_role_name() in ('admin', 'warehouse', 'cashier'));
create policy team_reads_tasks on tasks for select
  using (current_role_name() in ('admin', 'warehouse', 'cashier'));

grant select on posts, tasks, team_feed, task_board to app_client;
grant execute on function post_update(text) to app_client;
grant execute on function add_task(text, text, date, text, text) to app_client;
grant execute on function move_task(bigint, text) to app_client;

-- 004_hosting.sql pins search_path on every function and takes EXECUTE off
-- PUBLIC. These three arrived afterwards, so they get the same treatment here
-- rather than depending on that file being re-run.
alter function post_update(text) set search_path = public, extensions;
alter function add_task(text, text, date, text, text) set search_path = public, extensions;
alter function move_task(bigint, text) set search_path = public, extensions;
revoke all on function post_update(text) from public;
revoke all on function add_task(text, text, date, text, text) from public;
revoke all on function move_task(bigint, text) from public;

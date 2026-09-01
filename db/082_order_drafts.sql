-- ============================================================================
-- MS BEAU AVE — saved chat-order drafts
--
-- An order taken off a Messenger chat is not always finished in one sitting —
-- the customer is still deciding, or another chat comes in first. This gives
-- the desk a place to park a basket and come back to it: a draft is a reseller
-- and the lines picked so far, saved by whoever took it, reopened from the
-- Drafts button beside the filter. It is not an order — nothing is committed,
-- no stock is held — until it is placed.
--
-- The desk's, like the order-taking it belongs to: admin and the order desk.
-- ============================================================================

create table if not exists order_drafts (
  id          bigint generated always as identity primary key,
  reseller_id bigint not null references resellers (id) on delete cascade,
  lines       jsonb  not null default '[]'::jsonb,
  saved_by    text   not null default current_actor(),
  updated_at  timestamptz not null default now(),
  created_at  timestamptz not null default now()
);
create index if not exists order_drafts_recent on order_drafts (updated_at desc);

alter table order_drafts enable row level security;
drop policy if exists desk_order_drafts on order_drafts;
create policy desk_order_drafts on order_drafts for all
  using (current_role_name() in ('admin', 'orderdesk'))
  with check (current_role_name() in ('admin', 'orderdesk'));
grant select, insert, update, delete on order_drafts to app_client;

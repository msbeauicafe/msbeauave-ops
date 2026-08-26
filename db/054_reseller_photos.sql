-- ============================================================================
-- MS BEAU AVE — a face on the reseller's card
--
-- The order screen is a wall of cards now, the way the time clock is a wall of
-- faces, and it works for the same reason: somebody reading a name off a chat
-- window finds the right card by recognising it rather than by reading two
-- hundred and forty of them. Initials get part of the way there. A photograph
-- gets the rest.
--
-- Deliberately the same shape as employee_photos, including the lesson that
-- cost this company its egress allowance: the picture is shrunk once on the
-- way in, never on the way out. A card is 96px wide, so 240x320 is already
-- twice what any screen asks for, and it is what makes caching these for a
-- year cheap rather than a year spent serving a phone camera's original.
--
-- One row per account, replaced rather than accumulated. Nobody wants the
-- history of a shop's logo.
-- ============================================================================

create table if not exists reseller_photos (
  reseller_id bigint primary key references resellers (id) on delete cascade,
  mime        text        not null,
  bytes       bytea       not null,
  updated_at  timestamptz not null default now()
);

alter table reseller_photos enable row level security;

create or replace function set_reseller_photo(p_id bigint, p_mime text, p_bytes bytea)
returns void language plpgsql security definer as $$
begin
  perform require_role('admin');
  if not exists (select 1 from resellers where id = p_id) then
    raise exception 'There is no reseller with that number.';
  end if;
  insert into reseller_photos (reseller_id, mime, bytes)
  values (p_id, p_mime, p_bytes)
  on conflict (reseller_id) do update
    set mime = excluded.mime, bytes = excluded.bytes, updated_at = now();
end;
$$;

create or replace function clear_reseller_photo(p_id bigint)
returns void language plpgsql security definer as $$
begin
  perform require_role('admin');
  delete from reseller_photos where reseller_id = p_id;
end;
$$;

-- Reading the bytes goes through the route, which asks the row for them as
-- the signed-in staff member. A reseller's own portal has no business
-- listing other accounts' pictures, so the policy names the office only.
drop policy if exists staff_read_reseller_photos on reseller_photos;
create policy staff_read_reseller_photos on reseller_photos for select
  using (current_role_name() in ('admin','warehouse','cashier','supervisor','office'));

grant select on reseller_photos to app_client;
grant execute on function set_reseller_photo(bigint, text, bytea)  to app_client;
grant execute on function clear_reseller_photo(bigint)             to app_client;
alter function set_reseller_photo(bigint, text, bytea) set search_path = public, extensions;
alter function clear_reseller_photo(bigint)            set search_path = public, extensions;

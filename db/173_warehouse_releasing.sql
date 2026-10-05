-- MS BEAU AVE — a releasing form
--
-- Receiving already has its own form, its own numbering and its own screen
-- (receiving_forms / receiving_form_lines, reached from Warehouse receiving).
-- Releasing has nothing: stock leaving the warehouse for a branch, outside a
-- customer order, had nowhere to be written down. This is a paper trail
-- only — what left, how much, where to, who signed for it — not a stock
-- movement. The pools (b2b/shop/reserve) and the real on-hand figures stay
-- exactly what Stockroom's own "Move stock between pools" makes them; this
-- never touches batches, stock or movements.

create table if not exists warehouse_releases (
  id          bigint generated always as identity primary key,
  sku         text   not null references products (sku),
  batch_no    text,
  qty         int    not null check (qty > 0),
  branch_id   bigint not null references branches (id),
  reason      text,
  released_by text   not null default current_actor(),
  released_at timestamptz not null default now()
);
create index if not exists warehouse_releases_by_date on warehouse_releases (released_at desc);

alter table warehouse_releases enable row level security;
drop policy if exists stock_reads_warehouse_releases on warehouse_releases;
create policy stock_reads_warehouse_releases on warehouse_releases for select
  using (current_role_name() in ('admin', 'warehouse', 'supervisor', 'office', 'datacoord'));
grant select on warehouse_releases to app_client;

create or replace function release_stock(
  p_sku text, p_batch_no text, p_qty int, p_branch bigint, p_reason text
) returns bigint
language plpgsql security definer as $$
declare v_id bigint; v_branch bigint;
begin
  perform require_role('admin', 'warehouse', 'datacoord');
  if p_qty <= 0 then
    raise exception 'released quantity must be more than zero';
  end if;
  if not exists (select 1 from products where sku = p_sku and active) then
    raise exception 'no active product with code %', p_sku;
  end if;

  -- The same fallback receive_stock already uses: a sign-in tied to one
  -- branch lands there regardless, an untied one (the owner, typically)
  -- takes what was picked or the first branch open when there was nothing
  -- to pick from — one branch alone draws no dropdown at all.
  v_branch := branch_or_default(p_branch);
  if not exists (select 1 from branches where id = v_branch and active) then
    raise exception 'That branch is not open.';
  end if;

  insert into warehouse_releases (sku, batch_no, qty, branch_id, reason)
  values (p_sku, nullif(btrim(coalesce(p_batch_no, '')), ''), p_qty, v_branch,
          nullif(btrim(coalesce(p_reason, '')), ''))
  returning id into v_id;
  return v_id;
end;
$$;
alter function release_stock(text, text, int, bigint, text) set search_path = public, extensions;
revoke all on function release_stock(text, text, int, bigint, text) from public;
grant execute on function release_stock(text, text, int, bigint, text) to app_client;

-- Every release, read back with the product's own name and the branch it
-- went to — a release row is a dead end on its own otherwise, the same
-- reason recent_receipts joins out to products and branches too.
create or replace view warehouse_release_rows as
select r.id, r.sku, p.name, r.batch_no, r.qty, r.branch_id, br.name as branch,
       r.reason, r.released_by, r.released_at
  from warehouse_releases r
  join products p on p.sku = r.sku
  join branches br on br.id = r.branch_id
 order by r.released_at desc;

grant select on warehouse_release_rows to app_client;

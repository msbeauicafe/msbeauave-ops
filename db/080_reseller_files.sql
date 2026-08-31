-- ============================================================================
-- MS BEAU AVE — files on an account: papers and proofs
--
-- Two things kept turning up as "a drive link or a file name" typed into a box,
-- when what everyone actually had was a photograph on their phone:
--
--   * The account's PAPERS — the BIR 2303, the business permit, the tax
--     certificate. Proof of who this account is.
--   * The PROOF OF A TRANSFER — the screenshot of the bank app showing the
--     money left. Proof that a payment happened.
--
-- This holds both, as the actual image, on the account's own record. One table,
-- a category to tell papers from proofs, and — like everything else on an
-- account — the name of whoever put it there and when. Managing them is the
-- owner's; the pictures are business papers and bank screenshots, not a
-- shopfront.
--
-- Same lesson as the reseller's card photo: the image is shrunk once on the way
-- in (by the route), never on the way out, so serving it stays cheap. Unlike
-- the card, these are kept full-shape and legible — a tax certificate cropped
-- to a square is no proof of anything — and there can be many per account.
-- ============================================================================

create table if not exists reseller_files (
  id           bigint generated always as identity primary key,
  reseller_id  bigint not null references resellers (id) on delete cascade,
  category     text   not null check (category in ('document', 'payment_proof')),
  label        text,
  mime         text   not null,
  bytes        bytea  not null,
  uploaded_by  text   not null default current_actor(),
  uploaded_at  timestamptz not null default now()
);
create index if not exists reseller_files_by_account on reseller_files (reseller_id, category);

alter table reseller_files enable row level security;

create or replace function add_reseller_file(
  p_reseller bigint, p_category text, p_label text, p_mime text, p_bytes bytea
) returns bigint
language plpgsql security definer as $$
declare v_id bigint;
begin
  perform require_role('admin');
  if not exists (select 1 from resellers where id = p_reseller) then
    raise exception 'There is no such account.';
  end if;
  if p_category not in ('document', 'payment_proof') then
    raise exception '% is not a kind of file kept here.', p_category;
  end if;
  insert into reseller_files (reseller_id, category, label, mime, bytes)
  values (p_reseller, p_category, nullif(btrim(coalesce(p_label, '')), ''), p_mime, p_bytes)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function remove_reseller_file(p_file bigint)
returns void language plpgsql security definer as $$
begin
  perform require_role('admin');
  delete from reseller_files where id = p_file;
  if not found then raise exception 'There is no such file.'; end if;
end;
$$;

-- The papers and the proofs are the owner's — tax certificates and bank
-- screenshots, read and managed by admin alone.
drop policy if exists admin_reseller_files on reseller_files;
create policy admin_reseller_files on reseller_files for all
  using (current_role_name() = 'admin') with check (current_role_name() = 'admin');

grant select, insert, update, delete on reseller_files to app_client;
grant execute on function add_reseller_file(bigint, text, text, text, bytea) to app_client;
grant execute on function remove_reseller_file(bigint)                       to app_client;
alter function add_reseller_file(bigint, text, text, text, bytea) set search_path = public, extensions;
alter function remove_reseller_file(bigint)                       set search_path = public, extensions;

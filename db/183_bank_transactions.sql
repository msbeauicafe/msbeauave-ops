-- Bank report → Bank: what the bank statement says.
--
-- One line per InstaPay, PESONet, over-the-counter cash deposit or check, on
-- one of the shop's accounts, with the bank's own reference number. This is
-- the statement's side only: it does not post to Books, so Cash position's
-- balances are not moved by it — a payment already recorded as a sale or an
-- expense would otherwise count twice. Matching these lines against Sales,
-- Purchases and Expenses comes later.
--
-- A reference already on file for the same account is refused, so the same
-- transfer cannot be entered twice. Owner's book: admin only, through the
-- functions below, refused past the router too.

create table bank_transactions (
  id           bigint generated always as identity primary key,
  txn_on       date not null,
  account      text not null check (account in
                 ('BDO', 'BPI', 'Security Bank', 'GCash', 'Bank', 'Cash on hand')),
  kind         text not null check (kind in ('instapay', 'pesonet', 'otc', 'check')),
  direction    text not null check (direction in ('in', 'out')),
  party        text not null check (btrim(party) <> ''),
  amount       numeric(14, 2) not null check (amount > 0),
  reference    text not null check (btrim(reference) <> ''),
  note         text,
  recorded_by  text not null default current_actor(),
  recorded_at  timestamptz not null default now()
);
create unique index bank_transactions_one_reference
  on bank_transactions (account, upper(btrim(reference)));
create index bank_transactions_by_day on bank_transactions (txn_on desc, id desc);

alter table bank_transactions enable row level security;

create or replace function bank_txn_list() returns jsonb
language plpgsql stable security definer as $$
begin
  perform require_role('admin');
  return coalesce((select jsonb_agg(to_jsonb(t) order by t.txn_on desc, t.id desc)
                     from bank_transactions t), '[]'::jsonb);
end;
$$;

create or replace function bank_txn_record(
  p_on date, p_account text, p_kind text, p_direction text,
  p_party text, p_amount numeric, p_reference text, p_note text
) returns bigint
language plpgsql security definer as $$
declare v_id bigint;
begin
  perform require_role('admin');
  if p_on is null then raise exception 'Pick the date.'; end if;
  if coalesce(p_account, '') not in ('BDO', 'BPI', 'Security Bank', 'GCash', 'Bank', 'Cash on hand') then
    raise exception 'Pick the account.';
  end if;
  if coalesce(p_kind, '') not in ('instapay', 'pesonet', 'otc', 'check') then
    raise exception 'Pick the type.';
  end if;
  if coalesce(p_direction, '') not in ('in', 'out') then
    raise exception 'Pick money in or money out.';
  end if;
  if coalesce(btrim(p_party), '') = '' then raise exception 'Say who it was from or to.'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'The amount must be more than zero.'; end if;
  if coalesce(btrim(p_reference), '') = '' then raise exception 'Enter the bank reference number.'; end if;
  begin
    insert into bank_transactions (txn_on, account, kind, direction, party, amount, reference, note)
    values (p_on, p_account, p_kind, p_direction, btrim(p_party), round(p_amount, 2),
            btrim(p_reference), nullif(btrim(coalesce(p_note, '')), ''))
    returning id into v_id;
  exception when unique_violation then
    raise exception 'Reference % is already on file for %.', btrim(p_reference), p_account;
  end;
  return v_id;
end;
$$;

alter function bank_txn_list() set search_path = public, extensions;
alter function bank_txn_record(date, text, text, text, text, numeric, text, text)
  set search_path = public, extensions;

revoke all on function bank_txn_list() from public;
revoke all on function bank_txn_record(date, text, text, text, text, numeric, text, text) from public;
grant execute on function bank_txn_list() to app_client;
grant execute on function bank_txn_record(date, text, text, text, text, numeric, text, text) to app_client;

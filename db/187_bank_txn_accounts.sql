-- Payment Management's Account list, kept rather than fixed.
--
-- The six accounts a bank line could be filed under were written into the
-- table's own check (db/183) and into the screen, so a new bank meant a code
-- change and a name could never be corrected. They are a list of their own
-- now: Payment Management adds a bank to it, or renames one, and the name is
-- still picked from that list, never typed against a line — no stray
-- "aaaaa" account from a slipped key.
--
-- A rename carries through to every line already filed under the old name:
-- the lines point at the list by name, and the name cascades. Books keeps
-- its own account names; this is the bank-statement side only (db/183).

create table if not exists bank_txn_accounts (
  id         bigint generated always as identity primary key,
  name       text not null check (btrim(name) <> '' and name = btrim(name)),
  created_at timestamptz not null default now(),
  created_by text not null default current_actor()
);
create unique index if not exists bank_txn_accounts_one_name on bank_txn_accounts (lower(name));
-- The foreign key below needs a plain unique on the column itself.
alter table bank_txn_accounts drop constraint if exists bank_txn_accounts_name_key;
alter table bank_txn_accounts add constraint bank_txn_accounts_name_key unique (name);

insert into bank_txn_accounts (name)
select v.name from (values ('BDO'), ('BPI'), ('Security Bank'), ('GCash'), ('Bank'), ('Cash on hand')) v(name)
 where not exists (select 1 from bank_txn_accounts a where lower(a.name) = lower(v.name));

-- Any account already used on a line, if somehow not one of the six.
insert into bank_txn_accounts (name)
select distinct t.account from bank_transactions t
 where not exists (select 1 from bank_txn_accounts a where a.name = t.account);

alter table bank_transactions drop constraint if exists bank_transactions_account_check;
alter table bank_transactions drop constraint if exists bank_transactions_account_fkey;
alter table bank_transactions add constraint bank_transactions_account_fkey
  foreign key (account) references bank_txn_accounts (name) on update cascade;

alter table bank_txn_accounts enable row level security;
revoke all on bank_txn_accounts from public;

create or replace function bank_acct_list() returns jsonb
language plpgsql stable security definer as $$
begin
  perform require_role('admin');
  -- A to Z, so a bank just added is found where its name says it is.
  return coalesce((select jsonb_agg(a.name order by lower(a.name)) from bank_txn_accounts a), '[]'::jsonb);
end;
$$;

create or replace function bank_acct_add(p_name text) returns text
language plpgsql security definer as $$
declare v_name text := btrim(coalesce(p_name, ''));
begin
  perform require_role('admin');
  if v_name = '' then raise exception 'Type the bank''s name.'; end if;
  if exists (select 1 from bank_txn_accounts where lower(name) = lower(v_name)) then
    raise exception '% is already on the list.', v_name;
  end if;
  insert into bank_txn_accounts (name) values (v_name);
  return v_name;
end;
$$;

create or replace function bank_acct_rename(p_from text, p_to text) returns text
language plpgsql security definer as $$
declare v_to text := btrim(coalesce(p_to, ''));
begin
  perform require_role('admin');
  if v_to = '' then raise exception 'Type the new name.'; end if;
  if not exists (select 1 from bank_txn_accounts where name = p_from) then
    raise exception 'There is no account called %.', p_from;
  end if;
  if exists (select 1 from bank_txn_accounts where lower(name) = lower(v_to) and name <> p_from) then
    raise exception '% is already on the list.', v_to;
  end if;
  update bank_txn_accounts set name = v_to where name = p_from;
  return v_to;
end;
$$;

-- Recording a line: the account must be one on the list, not one of six
-- names written into the function.
create or replace function bank_txn_record(
  p_on date, p_account text, p_kind text, p_direction text,
  p_party text, p_amount numeric, p_reference text, p_note text
) returns bigint
language plpgsql security definer as $$
declare v_id bigint;
begin
  perform require_role('admin');
  if p_on is null then raise exception 'Pick the date.'; end if;
  if not exists (select 1 from bank_txn_accounts where name = coalesce(p_account, '')) then
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

alter function bank_acct_list() set search_path = public, extensions;
alter function bank_acct_add(text) set search_path = public, extensions;
alter function bank_acct_rename(text, text) set search_path = public, extensions;
alter function bank_txn_record(date, text, text, text, text, numeric, text, text)
  set search_path = public, extensions;

revoke all on function bank_acct_list() from public;
revoke all on function bank_acct_add(text) from public;
revoke all on function bank_acct_rename(text, text) from public;
grant execute on function bank_acct_list() to app_client;
grant execute on function bank_acct_add(text) to app_client;
grant execute on function bank_acct_rename(text, text) to app_client;

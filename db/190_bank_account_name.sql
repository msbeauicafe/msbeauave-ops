-- MS BEAU AVE — each bank's account name, and the Customer order form's
-- Bank account details read off Payment Management's list
--
-- The Customer order form printed three banks written into the screen — BDO,
-- BPI, Security Bank, each "MS Beau Ave Enterprises OPC" and a number. They
-- come off Payment Management's list now (db/187–189): every bank there with
-- an account no., under the name it carries, its account name and its number.
-- A bank renamed, added or given a number there is on the next form drawn.
--
-- Payment Management's List of mode of payment also gets an ✕ per bank, to
-- remove one nothing has been recorded under (bank_acct_drop, below).
--
-- The three the form already printed are copied onto the list, where the list
-- has no number for them yet, so the form reads the same the day this runs.

alter table bank_txn_accounts add column if not exists account_name text;

update bank_txn_accounts a
   set account_no = coalesce(a.account_no, v.no),
       account_name = coalesce(a.account_name, 'MS Beau Ave Enterprises OPC')
  from (values ('BANCO DE ORO (BDO)', '010-338-012-751'),
               ('BPI', '317-378-3972'),
               ('SECURITY BANK', '000-006-567-3032')) v(alias, no)
 where v.alias = any(a.aliases) and (a.account_no is null or a.account_name is null);

-- One bank's account name and account no., as Payment Management saves them.
create or replace function bank_acct_set_details(p_name text, p_acct_name text, p_no text) returns void
language plpgsql security definer as $$
begin
  perform require_role('admin');
  update bank_txn_accounts
     set account_name = nullif(btrim(coalesce(p_acct_name, '')), ''),
         account_no   = nullif(btrim(coalesce(p_no, '')), '')
   where name = p_name;
  if not found then raise exception 'There is no account called %.', p_name; end if;
end;
$$;

create or replace function bank_acct_boxes() returns jsonb
language plpgsql stable security definer as $$
begin
  perform require_role('admin');
  return coalesce((select jsonb_agg(jsonb_build_object(
            'name', a.name, 'column', a.cash_column, 'is_bank', a.is_bank,
            'coa_code', a.coa_code, 'aliases', to_jsonb(a.aliases),
            'account_name', a.account_name, 'account_no', a.account_no)
            order by a.place nulls last, a.id)
           from bank_txn_accounts a), '[]'::jsonb);
end;
$$;

-- What the Customer order form prints under Bank account details: the banks
-- with an account no., in the list's order. Whoever can open an order can
-- draw its form, so whoever can open one reads this.
create or replace function co_bank_details() returns jsonb
language plpgsql stable security definer as $$
begin
  perform require_role('admin', 'warehouse', 'cashier', 'supervisor', 'office',
                       'datacoord', 'orderdesk', 'observer');
  return coalesce((select jsonb_agg(jsonb_build_object(
            'name', a.name, 'account_name', a.account_name, 'account_no', a.account_no)
            order by a.place nulls last, a.id)
           from bank_txn_accounts a
          where a.is_bank and a.account_no is not null), '[]'::jsonb);
end;
$$;

-- Removing a bank from the list — the ✕ on Payment Management's List of mode
-- of payment. Only a bank nothing has been recorded under: no bank line, no
-- customer or supplier payment, no Books entry on its account. Anything with
-- history keeps it, and is refused in plain words instead. Its own Books
-- account goes with it when that account was never used.
create or replace function bank_acct_drop(p_name text) returns void
language plpgsql security definer as $$
declare a bank_txn_accounts;
begin
  perform require_role('admin');
  select * into a from bank_txn_accounts where name = p_name;
  if not found then raise exception 'There is no account called %.', p_name; end if;
  if not a.is_bank then
    raise exception '% is not a bank on the Mode of payment list.', p_name;
  end if;
  if exists (select 1 from bank_transactions where account = a.name) then
    raise exception '% has bank lines recorded under it, so it stays.', a.name;
  end if;
  if exists (select 1 from payments where lower(btrim(method)) = lower(a.name))
     or exists (select 1 from purchase_order_bill_payments where lower(btrim(method)) = lower(a.name)) then
    raise exception 'Payments were made through %, so it stays.', a.name;
  end if;
  if a.coa_code is not null and exists (select 1 from journal_lines where account = a.coa_code) then
    raise exception 'Books has entries on %, so it stays.', a.name;
  end if;
  delete from bank_txn_accounts where id = a.id;
  if a.coa_code is not null and a.coa_code not in ('102', '103') then
    begin
      delete from coa_accounts where code = a.coa_code;
    exception when foreign_key_violation then null;
    end;
  end if;
end;
$$;

alter function bank_acct_drop(text) set search_path = public, extensions;
revoke all on function bank_acct_drop(text) from public;
grant execute on function bank_acct_drop(text) to app_client;

alter function bank_acct_set_details(text, text, text) set search_path = public, extensions;
alter function bank_acct_boxes() set search_path = public, extensions;
alter function co_bank_details() set search_path = public, extensions;
revoke all on function bank_acct_set_details(text, text, text) from public;
revoke all on function co_bank_details() from public;
grant execute on function bank_acct_set_details(text, text, text) to app_client;
grant execute on function co_bank_details() to app_client;

-- What the form will print, for whoever runs this to read back.
select name, account_name, account_no from bank_txn_accounts
 where is_bank order by place nulls last, id;

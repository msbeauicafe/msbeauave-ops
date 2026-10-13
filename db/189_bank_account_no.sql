-- MS BEAU AVE — each bank on Payment Management's list keeps its account no.
--
-- Payment Management (Bank report → Bank) shows the shop's banks with the
-- account number each one is — BDO 0000-0001, BPI 0010-0014 — under the
-- Account and Account no. boxes, so the number a payment should go to is on
-- the same screen as the bank's name. Kept on the list itself (db/187, 188),
-- optional, typed as the bank prints it.

alter table bank_txn_accounts add column if not exists account_no text;

create or replace function bank_acct_set_no(p_name text, p_no text) returns text
language plpgsql security definer as $$
declare v_no text := nullif(btrim(coalesce(p_no, '')), '');
begin
  perform require_role('admin');
  update bank_txn_accounts set account_no = v_no where name = p_name;
  if not found then raise exception 'There is no account called %.', p_name; end if;
  return v_no;
end;
$$;

-- Cash position's boxes, now with the account no. Payment Management lists.
create or replace function bank_acct_boxes() returns jsonb
language plpgsql stable security definer as $$
begin
  perform require_role('admin');
  return coalesce((select jsonb_agg(jsonb_build_object(
            'name', a.name, 'column', a.cash_column, 'is_bank', a.is_bank,
            'coa_code', a.coa_code, 'aliases', to_jsonb(a.aliases),
            'account_no', a.account_no) order by a.place nulls last, a.id)
           from bank_txn_accounts a), '[]'::jsonb);
end;
$$;

alter function bank_acct_set_no(text, text) set search_path = public, extensions;
alter function bank_acct_boxes() set search_path = public, extensions;
revoke all on function bank_acct_set_no(text, text) from public;
grant execute on function bank_acct_set_no(text, text) to app_client;

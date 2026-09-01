-- ============================================================================
-- MS BEAU AVE — where a reseller's paperwork gets sent
--
-- Every reseller is talked to in one place — a Messenger chat or a group chat —
-- and their customer order form and invoice are pasted straight into it. That
-- link was carried in somebody's head. Kept on the account now, it becomes a
-- button on the form: open the chat, drop the picture in.
--
-- It rides on order_board so an order already carries the account's link, the
-- same way it carries the tax block, and edit_reseller learns to set it so it
-- is changed and recorded where the rest of the account's details are.
-- ============================================================================

alter table resellers add column if not exists chat_link text;

-- order_board, as db/070 left it, with the account's chat link appended.
create or replace view order_board as
select o.id, o.channel, o.status, o.total, o.placed_at, o.placed_by, o.delivered_at,
       o.reseller_id, r.name as reseller, r.tier,
       i.id as invoice_id, i.status as invoice_status, i.due_on,
       i.status = 'open' and i.due_on < current_date as invoice_overdue,
       case when current_role_name() in ('admin','orderdesk')
            then (i.amount - i.paid - i.discount) end as balance,
       r.tax_type, r.trade_name, r.taxpayer_name, r.tin, r.business_address,
       o.co_no, o.pl_no, i.si_no,
       o.shipping, o.others, o.subtotal,
       o.drop_ship, r.chat_link
  from orders o
  left join resellers r on r.id = o.reseller_id
  left join invoices i on i.order_id = o.id
 where current_role_name() in ('admin','warehouse','orderdesk');

-- edit_reseller, as db/079 left it, now also setting and recording the chat
-- link. Signature grows a parameter, so the old four-argument form is dropped.
drop function if exists edit_reseller(bigint, text, text, text);
create or replace function edit_reseller(
  p_id bigint, p_name text, p_contact text, p_email text, p_chat text
) returns void
language plpgsql security definer as $$
declare v_old resellers%rowtype;
        v_chat text := nullif(btrim(coalesce(p_chat, '')), '');
begin
  perform require_role('admin');
  select * into v_old from resellers where id = p_id;
  if not found then raise exception 'There is no such account.'; end if;
  if length(btrim(coalesce(p_name, ''))) = 0 then
    raise exception 'An account needs a name.';
  end if;

  update resellers set
    name      = btrim(p_name),
    contact   = nullif(btrim(coalesce(p_contact, '')), ''),
    email     = nullif(btrim(coalesce(p_email,   '')), ''),
    chat_link = v_chat
  where id = p_id;

  if v_old.name is distinct from btrim(p_name)
     or v_old.contact is distinct from nullif(btrim(coalesce(p_contact, '')), '')
     or v_old.email   is distinct from nullif(btrim(coalesce(p_email,   '')), '')
     or v_old.chat_link is distinct from v_chat then
    insert into reseller_events (reseller_id, kind, detail)
    values (p_id, 'details_changed', jsonb_build_object(
      'from', jsonb_build_object('name', v_old.name, 'contact', v_old.contact,
                                 'email', v_old.email, 'chat_link', v_old.chat_link),
      'to',   jsonb_build_object('name', btrim(p_name),
                                 'contact', nullif(btrim(coalesce(p_contact, '')), ''),
                                 'email',   nullif(btrim(coalesce(p_email,   '')), ''),
                                 'chat_link', v_chat)));
  end if;
end;
$$;
alter function edit_reseller(bigint, text, text, text, text) set search_path = public, extensions;
revoke all on function edit_reseller(bigint, text, text, text, text) from public;
grant execute on function edit_reseller(bigint, text, text, text, text) to app_client;

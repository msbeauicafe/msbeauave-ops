-- ============================================================================
-- MS BEAU AVE — a reseller's own particulars
--
-- The account carried the name it is known by on Messenger and how to reach it,
-- and little else about the person behind it. This adds the rest of who they
-- are: their full name (the one on Messenger is rarely their real one), their
-- birthday, a real address, and a contact number — kept for the record the same
-- way the name and email are, and edited in the same one place with the same
-- history stamped against them.
-- ============================================================================

alter table resellers add column if not exists full_name      text;
alter table resellers add column if not exists birthday       date;
alter table resellers add column if not exists real_address   text;
alter table resellers add column if not exists contact_number text;

drop function if exists edit_reseller(bigint, text, text, text, text);
create or replace function edit_reseller(
  p_id bigint, p_name text, p_contact text, p_email text, p_chat text,
  p_full text, p_birthday text, p_address text, p_phone text
) returns void
language plpgsql security definer as $$
declare v_old   resellers%rowtype;
        v_chat  text := nullif(btrim(coalesce(p_chat, '')), '');
        v_full  text := nullif(btrim(coalesce(p_full, '')), '');
        v_addr  text := nullif(btrim(coalesce(p_address, '')), '');
        v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
        v_bday  date := nullif(btrim(coalesce(p_birthday, '')), '')::date;
begin
  perform require_role('admin');
  select * into v_old from resellers where id = p_id;
  if not found then raise exception 'There is no such account.'; end if;
  if length(btrim(coalesce(p_name, ''))) = 0 then
    raise exception 'An account needs a name.';
  end if;

  update resellers set
    name           = btrim(p_name),
    contact        = nullif(btrim(coalesce(p_contact, '')), ''),
    email          = nullif(btrim(coalesce(p_email,   '')), ''),
    chat_link      = v_chat,
    full_name      = v_full,
    birthday       = v_bday,
    real_address   = v_addr,
    contact_number = v_phone
  where id = p_id;

  if v_old.name is distinct from btrim(p_name)
     or v_old.contact is distinct from nullif(btrim(coalesce(p_contact, '')), '')
     or v_old.email   is distinct from nullif(btrim(coalesce(p_email,   '')), '')
     or v_old.chat_link is distinct from v_chat
     or v_old.full_name is distinct from v_full
     or v_old.birthday is distinct from v_bday
     or v_old.real_address is distinct from v_addr
     or v_old.contact_number is distinct from v_phone then
    insert into reseller_events (reseller_id, kind, detail)
    values (p_id, 'details_changed', jsonb_build_object(
      'from', jsonb_build_object('name', v_old.name, 'contact', v_old.contact,
        'email', v_old.email, 'chat_link', v_old.chat_link, 'full_name', v_old.full_name,
        'birthday', v_old.birthday, 'real_address', v_old.real_address,
        'contact_number', v_old.contact_number),
      'to', jsonb_build_object('name', btrim(p_name),
        'contact', nullif(btrim(coalesce(p_contact, '')), ''),
        'email', nullif(btrim(coalesce(p_email, '')), ''),
        'chat_link', v_chat, 'full_name', v_full, 'birthday', v_bday,
        'real_address', v_addr, 'contact_number', v_phone)));
  end if;
end;
$$;
alter function edit_reseller(bigint,text,text,text,text,text,text,text,text) set search_path = public, extensions;
revoke all on function edit_reseller(bigint,text,text,text,text,text,text,text,text) from public;
grant execute on function edit_reseller(bigint,text,text,text,text,text,text,text,text) to app_client;

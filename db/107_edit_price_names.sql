-- ============================================================================
-- MS BEAU AVE — a price name, once added, can be changed
--
-- Adding a name was one-way: a typo, or a name the shop later says differently,
-- was on the dropdown for good. Renaming carries the prices and the sold lines
-- with it, so nothing is orphaned; removing is refused for a name anything has
-- ever been sold at, because that is the record of what was charged.
-- ============================================================================

create or replace function rename_price_code(p_from text, p_to text) returns text
language plpgsql security definer as $$
declare v_to text; v_sort int;
begin
  perform require_role('admin', 'office');
  v_to := upper(btrim(coalesce(p_to, '')));
  if length(v_to) = 0 then raise exception 'A price needs a name.'; end if;
  if length(v_to) > 24 then raise exception 'That name is too long for a price list column.'; end if;
  if v_to = p_from then return v_to; end if;
  if exists (select 1 from price_codes where code = v_to) then
    raise exception '% is already a price name.', v_to;
  end if;
  if not exists (select 1 from price_codes where code = p_from and base_code is null) then
    raise exception 'There is no price name called %.', p_from;
  end if;
  if exists (select 1 from price_codes where base_code = p_from) then
    raise exception '% has adjusted codes hanging off it and cannot be renamed.', p_from;
  end if;

  select sort into v_sort from price_codes where code = p_from;
  insert into price_codes (code, base_code, adjust, sort) values (v_to, null, 0, v_sort);
  update product_prices set code = v_to where code = p_from;
  update order_lines    set price_code = v_to where price_code = p_from;
  delete from price_codes where code = p_from;
  return v_to;
end;
$$;

create or replace function remove_price_code(p_code text) returns void
language plpgsql security definer as $$
begin
  perform require_role('admin', 'office');
  if exists (select 1 from order_lines where price_code = p_code) then
    raise exception 'REMOVE_BLOCKED: % has been sold at and stays on the record. It can be renamed but not removed.', p_code;
  end if;
  if exists (select 1 from price_codes where base_code = p_code) then
    raise exception 'REMOVE_BLOCKED: % has adjusted codes hanging off it.', p_code;
  end if;
  delete from product_prices where code = p_code;
  delete from price_codes where code = p_code and base_code is null;
  if not found then raise exception 'There is no price name called %.', p_code; end if;
end;
$$;

alter function rename_price_code(text, text) set search_path = public, extensions;
alter function remove_price_code(text)       set search_path = public, extensions;
grant execute on function rename_price_code(text, text) to app_client;
grant execute on function remove_price_code(text)       to app_client;

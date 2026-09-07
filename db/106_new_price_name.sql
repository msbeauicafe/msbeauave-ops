-- ============================================================================
-- MS BEAU AVE — a price name the shop can add itself
--
-- The price list was fixed at what the owner listed once: RD, PD, CD, DD, RS
-- and the rest. A new tier now means a migration, which means waiting for
-- somebody who writes migrations — so a shop that agrees a new price on a
-- Tuesday keeps it in a notebook until then, which is how a notebook becomes
-- the real price list.
--
-- This lets the office add one. A base code only: an adjustment hangs off a
-- base and is the owner's to set, but a name to price under is the shop's own
-- business.
-- ============================================================================

create or replace function add_price_code(p_code text) returns text
language plpgsql security definer as $$
declare v_code text; v_next int;
begin
  perform require_role('admin', 'office');
  v_code := upper(btrim(coalesce(p_code, '')));
  if length(v_code) = 0 then
    raise exception 'A price needs a name.';
  end if;
  if length(v_code) > 24 then
    raise exception 'That name is too long for a price list column.';
  end if;
  if exists (select 1 from price_codes where code = v_code) then
    -- Already there, perhaps switched off. Bringing it back is what was meant.
    update price_codes set active = true where code = v_code;
    return v_code;
  end if;
  select coalesce(max(sort), 0) + 10 into v_next from price_codes;
  insert into price_codes (code, base_code, adjust, sort) values (v_code, null, 0, v_next);
  return v_code;
end;
$$;

alter function add_price_code(text) set search_path = public, extensions;
grant execute on function add_price_code(text) to app_client;

-- Pricing a product is the office's work as much as the owner's — it is the
-- same person who types the product in.
create or replace function set_price(p_sku text, p_code text, p_price numeric)
returns void language plpgsql security definer as $$
begin
  perform require_role('admin', 'office');
  if not exists (select 1 from price_codes where code = p_code and base_code is null) then
    raise exception '% is not a code that carries a price list. Price the base it comes from.', p_code;
  end if;
  insert into product_prices (sku, code, price)
  values (p_sku, p_code, p_price)
  on conflict (sku, code) do update set price = excluded.price, set_at = now();
end;
$$;

alter function set_price(text, text, numeric) set search_path = public, extensions;
grant execute on function set_price(text, text, numeric) to app_client;

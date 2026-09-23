-- Pending customer order's own list of orders put a PCODE picker on an
-- existing line, something the shared order dialog never offered — its own
-- line editor only ever let a price be typed. Nothing has ever saved a
-- price_code onto an order line after it was first placed, so the picker
-- had nowhere to write to. This is that write, on its own — the price
-- itself keeps going through revise_invoice exactly as it always has.

create or replace function set_line_price_codes(p_order bigint, p_lines jsonb default '[]'::jsonb)
returns void language plpgsql security definer as $$
declare o orders%rowtype; bad text;
begin
  perform require_role('admin', 'office');

  select * into o from orders where id = p_order for update;
  if o.id is null then raise exception 'No such order.'; end if;
  if o.status = 'cancelled' then
    raise exception 'That order was cancelled. Nothing on it can be corrected.';
  end if;

  select x ->> 'code' into bad
    from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) x
   where nullif(x ->> 'code', '') is not null
     and not exists (select 1 from price_codes c
                       where c.code = x ->> 'code' and c.active)
   limit 1;
  if bad is not null then
    raise exception 'PCODE_NOT_FOUND: % is not an agreed price code.', bad;
  end if;

  update order_lines l
     set price_code = nullif(x ->> 'code', '')
    from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) x
   where l.id = (x ->> 'id')::bigint
     and l.order_id = p_order;
end;
$$;
alter function set_line_price_codes(bigint, jsonb) set search_path = public, extensions;
revoke all on function set_line_price_codes(bigint, jsonb) from public;
grant execute on function set_line_price_codes(bigint, jsonb) to app_client;

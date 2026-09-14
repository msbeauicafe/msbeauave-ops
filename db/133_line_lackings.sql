-- ============================================================================
-- MS BEAU AVE — how short a line came up
--
-- receive_po_line already answers "how many arrived" for a delivery that
-- matches the order. Lackings is the other half: a number typed straight
-- onto the order's own line, on the spot, when a delivery falls short and
-- nobody is filling out the full receiving form for it right there.
--
-- A column on the line rather than a table of its own — there is one current
-- shortage per line worth knowing, not a history of them, and it is
-- overwritten the next time the line is looked at, the same way a correction
-- would be.
-- ============================================================================

alter table purchase_order_lines
  add column lackings int not null default 0;
alter table purchase_order_lines
  add constraint purchase_order_lines_lackings_check check (lackings >= 0);

create or replace function record_line_lackings(p_line bigint, p_qty int)
returns purchase_order_lines
language plpgsql security definer as $$
declare v_line purchase_order_lines%rowtype;
begin
  perform require_role('admin', 'warehouse');
  if p_qty is null or p_qty < 0 then raise exception 'How many short?'; end if;

  update purchase_order_lines set lackings = p_qty
   where id = p_line returning * into v_line;
  if not found then raise exception 'There is no such line on any purchase order.'; end if;

  return v_line;
end;
$$;

alter function record_line_lackings(bigint, int) set search_path = public, extensions;
grant execute on function record_line_lackings(bigint, int) to app_client;

-- What a line is called on the paper, when the catalogue's name is not it.
--
-- The name on a document has been the product's name, and mostly that is
-- right. But the sheet is what a reseller reads and agrees to, and there are
-- lines it cannot say properly: a set going out with something substituted in
-- it, a bundle sold as one thing, two of a shade written as the shade rather
-- than as the product code the warehouse knows it by. Until now the only way
-- to write that was to rename the product, which changes it for every order
-- ever placed and every one still to come.
--
-- So a line may carry a description of its own. Null means the product's name,
-- which is what nearly every line will always mean; a description set here is
-- this line on this order and nothing else.
--
-- It is what the line is called, not what the line is. The sku still says what
-- comes off the shelf, the batch still says which one, and the stock still
-- moves against the product — so a description can never make the paperwork
-- disagree with the warehouse about what is in the box, only about what to
-- call it.
alter table order_lines add column if not exists description text;

comment on column order_lines.description is
  'What this line is called on the documents. Null means the product''s own name.';

create or replace function set_line_notes(p_order bigint, p_lines jsonb)
returns jsonb language plpgsql security definer as $$
declare o orders%rowtype; v_changed int;
begin
  perform require_role('admin', 'office');

  select * into o from orders where id = p_order for update;
  if o.id is null then raise exception 'No such order.'; end if;

  -- Only while the goods are still here, for the same reason a quantity is:
  -- once the box has gone, the paper that went with it is what the reseller
  -- holds, and a sheet that reprints differently afterwards is a sheet nobody
  -- can reconcile against theirs.
  if o.status not in ('placed', 'picking') then
    raise exception 'ALREADY_GONE: that order is % — the paper has gone with the goods.', o.status;
  end if;

  -- Blank means back to the product's own name rather than a line with no name
  -- on it at all.
  update order_lines l
     set description = nullif(btrim(coalesce(x ->> 'description', '')), '')
    from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) x
   where l.id = (x ->> 'id')::bigint
     and l.order_id = p_order;
  get diagnostics v_changed = row_count;

  return jsonb_build_object('order_id', p_order, 'lines', v_changed);
end $$;

alter function set_line_notes(bigint, jsonb) set search_path = public, extensions;
revoke all on function set_line_notes(bigint, jsonb) from public;
grant execute on function set_line_notes(bigint, jsonb) to app_client;

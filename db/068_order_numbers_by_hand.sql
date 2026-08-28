-- The customer order and packing list numbers, typed.
--
-- 067 did this for the invoice and gave the reasons: a counter only ever goes
-- forwards, so a number quoted before the month rolled over, or a gap left by
-- a cancelled order, cannot be reached by cancelling and re-raising. The same
-- is true of the other two documents, and for the same reason a reseller
-- holding CO26_08_012 in a chat window is holding the only copy of it.
--
-- Both at once rather than a function each. They are two columns of one row
-- and they are looked at together — lining a series back up means moving both,
-- and moving one and being refused the other would leave a pair that does not
-- match. Null leaves a number alone; a blank string is refused, because a
-- document with no number is worse than one with the wrong number.
--
-- Two update statements rather than one, so the refusal can name which of the
-- two is already taken. Both indexes were put there by 062.
create or replace function set_order_no(
  p_order bigint, p_co_no text default null, p_pl_no text default null)
returns jsonb language plpgsql security definer as $$
declare
  o orders%rowtype;
  v_co text; v_pl text;
  v_was jsonb; v_now jsonb;
begin
  perform require_role('admin', 'office');

  select * into o from orders where id = p_order for update;
  if o.id is null then raise exception 'No such order.'; end if;
  -- A counter sale is not a customer order and has no packing list. It has a
  -- receipt, numbered by the till's own counter, which is not this.
  if o.channel <> 'b2b' then
    raise exception 'NOT_WHOLESALE: a counter sale has a receipt, not a customer order.';
  end if;

  v_co := nullif(upper(btrim(coalesce(p_co_no, ''))), '');
  v_pl := nullif(upper(btrim(coalesce(p_pl_no, ''))), '');
  if p_co_no is not null and v_co is null then
    raise exception 'NO_DOC_NO: a customer order has to carry a number.';
  end if;
  if p_pl_no is not null and v_pl is null then
    raise exception 'NO_DOC_NO: a packing list has to carry a number.';
  end if;

  v_was := jsonb_build_object('co_no', o.co_no, 'pl_no', o.pl_no);

  if v_co is not null and v_co is distinct from o.co_no then
    begin
      update orders set co_no = v_co where id = p_order;
    exception when unique_violation then
      raise exception 'DUPLICATE_DOC_NO: % is already on another customer order.', v_co;
    end;
  end if;

  if v_pl is not null and v_pl is distinct from o.pl_no then
    begin
      update orders set pl_no = v_pl where id = p_order;
    exception when unique_violation then
      raise exception 'DUPLICATE_DOC_NO: % is already on another packing list.', v_pl;
    end;
  end if;

  select jsonb_build_object('co_no', co_no, 'pl_no', pl_no) into v_now
    from orders where id = p_order;

  if o.reseller_id is not null and v_now is distinct from v_was then
    insert into reseller_events (reseller_id, kind, detail)
    values (o.reseller_id, 'order_renumbered',
            jsonb_build_object('order_id', p_order, 'from', v_was, 'to', v_now));
  end if;

  return v_now;
end $$;

alter function set_order_no(bigint, text, text) set search_path = public, extensions;
revoke all on function set_order_no(bigint, text, text) from public;
grant execute on function set_order_no(bigint, text, text) to app_client;

-- Pressing Invoice was only reading "newest" among the numbers the counter
-- itself hands out — so once a number was written by hand near the top, any
-- ordinary press capped out one slot below it, forever, no matter how many
-- times it was pressed again. Whoever presses last gets the newest number
-- there is, full stop, hand-written or not: a written number still never
-- moves, but it is no longer a ceiling nobody else can climb past. Pressing
-- Invoice on an order below it now builds a fresh number one past it
-- instead, and closes up whatever sat between its old spot and the counter's
-- own top exactly as before.
--
-- A hand-written number can end up sitting in the middle of that close-up,
-- once enough presses have piled numbers up past it — so each slot a press
-- is about to hand out is checked against what already exists first, and
-- steps one further down when something is already there, rather than
-- colliding with it.

create or replace function bump_invoice_number(p_order bigint) returns void
language plpgsql security definer as $$
declare
  v_invoice invoices%rowtype;
  v_prefix text;
  v_old_n int;
  v_nonmanual_max_n int;
  v_global_max_n int;
  v_target int;
  v_ids bigint[];
  v_ns int[];
  v_new_n int;
  i int;
begin
  select * into v_invoice from invoices where order_id = p_order for update;
  if v_invoice.id is null or v_invoice.si_no_manual then
    return;
  end if;

  v_prefix := substring(v_invoice.si_no from '^SI\d\d_\d\d_');
  if v_prefix is null then
    return;
  end if;

  perform pg_advisory_xact_lock(hashtext('bump_si:' || v_prefix));

  v_old_n := (substring(v_invoice.si_no from '\d+$'))::int;

  select max((substring(si_no from '\d+$'))::int) into v_nonmanual_max_n
    from invoices
   where si_no_manual = false and si_no ~ ('^' || v_prefix || '\d{3}$');

  select max((substring(si_no from '\d+$'))::int) into v_global_max_n
    from invoices
   where si_no ~ ('^' || v_prefix || '\d{3}$');

  -- Already the newest number there is, hand-written or not. Nothing to move.
  if v_global_max_n is null or v_old_n >= v_global_max_n then
    return;
  end if;

  -- Nothing hand-written sits above the counter's own top: reuse that slot,
  -- exactly as before. Something does: a hand-written number is never
  -- reused, only ever built past.
  v_target := case when v_nonmanual_max_n is not null and v_nonmanual_max_n = v_global_max_n
    then v_nonmanual_max_n else v_global_max_n + 1 end;

  select array_agg(id order by n), array_agg(n order by n)
    into v_ids, v_ns
    from (
      select id, (substring(si_no from '\d+$'))::int as n
        from invoices
       where si_no_manual = false and si_no ~ ('^' || v_prefix || '\d{3}$')
         and (substring(si_no from '\d+$'))::int > v_old_n
    ) x;

  -- Cleared first: reassigning in the new order would otherwise ask an
  -- early row to take a number a later row, not yet touched, is still
  -- holding. si_no is nullable and only uniquely constrained while it is
  -- not null, which is what makes clearing it first safe.
  update invoices set si_no = null where id = any(v_ids) or id = v_invoice.id;

  if v_ids is not null then
    for i in 1 .. array_length(v_ids, 1) loop
      v_new_n := v_ns[i] - 1;
      while exists (
        select 1 from invoices where si_no = v_prefix || lpad(v_new_n::text, 3, '0')
      ) loop
        v_new_n := v_new_n - 1;
      end loop;
      update invoices set si_no = v_prefix || lpad(v_new_n::text, 3, '0')
       where id = v_ids[i];
    end loop;
  end if;

  update invoices set si_no = v_prefix || lpad(v_target::text, 3, '0')
   where id = v_invoice.id;
end;
$$;
alter function bump_invoice_number(bigint) set search_path = public, extensions;

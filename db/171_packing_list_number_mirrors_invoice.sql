-- The packing list's own number used to be stamped the moment an order was
-- placed — its own counter, next_pl_no, running alongside the customer
-- order's. An invoice is raised later, often out of order with placement
-- (db/157), on its own separate counter — so CO26_10_005 could carry
-- PL26_10_005 while its invoice came out SI26_10_006, two numbers that
-- looked like they should match and never quite did.
--
-- The owner asked for the packing list's number to mirror its invoice's
-- instead — same suffix, 'PL' standing in for 'SI' — so PL26_10_006 for
-- SI26_10_006, always. That means it can no longer be assigned at
-- placement, before an invoice exists at all: it is assigned the moment
-- the invoice is, and kept in step with it from then on, including a
-- fresh press moving it (160). An order with no invoice yet simply has no
-- packing list number yet — every screen that shows one already falls
-- back to the order's own id, or to "SALES ORDER NO." in place of
-- "PACKING LIST NO.", when it is null.

create or replace function stamp_order_numbers() returns trigger
language plpgsql as $$
begin
  if new.channel = 'b2b' then
    if new.co_no is null then new.co_no := next_co_no(); end if;
  end if;
  return new;
end $$;

-- Fires on the invoice's own insert (first raised) and on any later change
-- to si_no — a fresh press moving it (160), or a hand-typed correction
-- (067) — so the packing list's number never has the chance to go stale
-- the way the old, separately-counted one could.
--
-- A hand-typed number (067) is a promise about a piece of paper already
-- printed — a BIR booklet page, most often — with no "SI" prefix or
-- suffix shaped like the counter's own to mirror at all. Leaving the
-- packing list holding whatever it had before turns out to be its own
-- bug, not a safe default: that stale number sits there forever, since
-- nothing will ever change this invoice's si_no back to something that
-- would naturally overwrite it, and it permanently blocks any other
-- order's invoice from ever legitimately landing on that same number
-- later — orders_pl_no_once catches the later one as a plain collision,
-- against a packing list number that has not meant this invoice for a
-- long time. So the packing list number is cleared instead, same as when
-- there is no invoice at all: nothing sensible to mirror is the same
-- situation as nothing to mirror yet.
--
-- bump_invoice_number (162) reshuffles several invoices' si_no at once the
-- same way: cleared to null first, then reassigned one at a time, which is
-- exactly the discipline that keeps two rows from ever holding the same
-- si_no even for an instant. Clearing pl_no on a null si_no keeps it in
-- that same step rather than trailing a beat behind with a stale value of
-- its own to collide with whatever the reshuffle assigns next.
create or replace function sync_packing_list_number() returns trigger
language plpgsql security definer as $$
begin
  if new.si_no ~ '^SI\d\d_\d\d_\d{3}$' then
    update orders set pl_no = 'PL' || substring(new.si_no from 3)
     where id = new.order_id;
  else
    update orders set pl_no = null where id = new.order_id;
  end if;
  return new;
end $$;

drop trigger if exists invoices_sync_pl_no on invoices;
create trigger invoices_sync_pl_no after insert or update of si_no on invoices
  for each row execute function sync_packing_list_number();

alter function stamp_order_numbers()       set search_path = public, extensions;
alter function sync_packing_list_number()  set search_path = public, extensions;

-- Every order already invoiced, brought into line with the rule from here
-- on — the same correction the trigger above now keeps current by itself.
-- A hand-typed invoice number clears the packing list number rather than
-- leaving whatever stale value it already carried.
update orders o set pl_no =
    case when i.si_no ~ '^SI\d\d_\d\d_\d{3}$'
         then 'PL' || substring(i.si_no from 3) else null end
  from invoices i
 where i.order_id = o.id
   and o.pl_no is distinct from (
     case when i.si_no ~ '^SI\d\d_\d\d_\d{3}$'
          then 'PL' || substring(i.si_no from 3) else null end);

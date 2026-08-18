-- ============================================================================
-- MS BEAU AVE — clearing out the people who were never here
--
-- The whole system was built against invented staff: Grace Lim, Jomar Ramos,
-- sixty-four names typed in so there was something to click on. On 18 August
-- 2026 the real personnel went in from the printed lists, and the invented
-- ones were dated as having left — which is the right treatment for somebody
-- who actually worked here and stopped, and the wrong one for somebody who
-- never existed at all. It leaves people who are not people on the HR list, in
-- the hours report, and in every count the owner reads.
--
-- 021_remove_employee.sql refuses to delete anybody with a shift against them,
-- and it is right to: shifts are hours the shop owes or has paid for, and a
-- payroll period that quietly stops adding up is the worst kind of wrong. That
-- guard is about real hours. These 284 shifts were generated to demonstrate a
-- clock; nobody was paid for one of them.
--
-- So this file goes around the guard, once, by hand, and deliberately leaves
-- no reusable way to do it again. A `purge_employee()` function sitting in the
-- schema would be a loaded gun — one call away from erasing a real person's
-- year. The exception is written down here instead, where it can be read.
--
-- What it will not touch: the three people who stayed through the changeover
-- (Sonny Corsiga Lorica, Sara Mariano Barrinuevo, Adona Marie Leonador Belen),
-- their 35 real shifts, and their enrolled fingerprints. They are identified
-- by having no leaving date, which is the same thing as being on the team.
-- ============================================================================

do $$
declare
  v_people int;
  v_shifts int;
begin
  select count(*) into v_people from employees where ended_on is not null;

  -- A count, not a date or an id range. If this file is ever run a second
  -- time, or against a database where somebody has genuinely left, the number
  -- will not be 64 and nothing happens. The alternative — deleting whoever
  -- happens to carry a leaving date — is how a real leaver's hours vanish.
  if v_people <> 64 then
    raise notice
      'Skipped: expected the 64 invented people, found %. Nothing was deleted.',
      v_people;
    return;
  end if;

  select count(*) into v_shifts from shifts
   where employee_id in (select id from employees where ended_on is not null);

  -- Shifts first: the foreign key is deliberately NO ACTION, so a person
  -- cannot be deleted out from under their own hours by accident.
  delete from shifts
   where employee_id in (select id from employees where ended_on is not null);

  -- Photographs and fingerprints cascade with the row they belong to.
  delete from employees where ended_on is not null;

  raise notice 'Cleared % invented people and % demonstration shifts.',
    v_people, v_shifts;
end;
$$;

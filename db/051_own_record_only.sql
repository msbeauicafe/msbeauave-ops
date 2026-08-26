-- ============================================================================
-- MS BEAU AVE — everybody sees their own record, and five people see the rest
--
-- Sixteen sign-ins held the view-only tier: the whole company, read but not
-- written — stock, orders, resellers, the reports, and every colleague's HR
-- file down to their performance reviews. It was built for managers who
-- needed to watch the business run. The owner has decided that is not how the
-- company should work: full access belongs to the five who administer it, and
-- everybody else has their own record and nothing else.
--
-- So the tier is emptied. Fifteen of those sixteen are people with a record
-- of their own, and they move to that tier — their hours, their leave, their
-- payslip, the noticeboard, and the ability to ask for leave, which the
-- view-only tier never had. On this change they gain something as well as
-- lose something.
--
-- The sixteenth is not a person. It was made to check what the view-only tier
-- could see, has no employee behind it, and would land on a My-record screen
-- with no record to show. It is switched off instead.
--
-- Two sign-ins are deliberately left alone, because neither is a person: the
-- door tablet, which is how everybody clocks in, and the shared warehouse
-- login, which is how stock is received and orders are picked. Demoting
-- either stops work rather than closing a door.
--
-- Every one of these sign-ins is signed out. The role is carried in the
-- session cookie, so without this a person keeps the access they had until
-- their cookie happens to expire — which is not a change of access, it is a
-- delay. They sign in again and come back as themselves.
-- ============================================================================

-- The fifteen with a record of their own.
update app_users u
   set role          = 'employee',
       sessions_from = now()
 where u.role = 'observer'
   and exists (select 1 from employees e
                where e.user_id = u.id and e.ended_on is null);

-- Whatever the first statement did not move is, by definition, a view-only
-- sign-in with nobody behind it. It does not stay one.
update app_users
   set active        = false,
       sessions_from = now()
 where role = 'observer';

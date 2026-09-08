-- ============================================================================
-- MS BEAU AVE — where SRP sits on the form
--
-- Every other price on the product form is a row on the price list and carries
-- the box it was typed in. SRP is not: it is a column on the product itself,
-- for the good reason that the till, the shop window and the MAP rule all read
-- it. So it had nowhere to keep a position, and the form put it back at the top
-- every time — move it to the bottom, save, and it was first again.
--
-- One number fixes that. It is a fact about the form rather than about the
-- price, which is why it sits here rather than being made into a price code:
-- SRP is not a tier, and making it one to solve a layout problem would put a
-- price the whole shop depends on into a table it can be deleted from.
-- ============================================================================

alter table products add column if not exists srp_position int;

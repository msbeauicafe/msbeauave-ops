-- ============================================================================
-- MS BEAU AVE — who the customer is for tax
--
-- Five lines print at the top of every invoice, order form and packing list:
-- Tax Type, Business Trade Name, Taxpayer Name, TIN Number, Business Address.
-- On the paper pad they are filled in by hand. In the app they have been
-- blank on every document ever printed, because there was nowhere to put
-- them — a reseller had a name, a contact and an email, and nothing that
-- says who they are to the BIR.
--
-- A trade name is not a company name and a taxpayer name is neither: an
-- account trades as one thing, is registered as another, and pays as a third.
-- So they are three columns rather than one clever one.
--
-- Nothing is required. Most accounts are small resellers with no registration
-- to give, and a form that refuses to save until a TIN is typed would be a
-- form somebody types zeros into. A blank line prints blank, exactly as the
-- paper does today.
--
-- The TIN is stored as typed, less surrounding space. Philippine TINs run to
-- nine digits or twelve with a branch code, written with dashes or without,
-- and a format check here would reject somebody's real number on a document
-- they need. What the app must not do is invent one, and it cannot.
-- ============================================================================

alter table resellers add column if not exists tax_type         text;
alter table resellers add column if not exists trade_name       text;
alter table resellers add column if not exists taxpayer_name    text;
alter table resellers add column if not exists tin              text;
alter table resellers add column if not exists business_address text;

comment on column resellers.tax_type is
  'VAT or Non-VAT, as the account is registered. Free text rather than a
   check constraint: the two the company uses today are not a promise that a
   third never turns up.';
comment on column resellers.tin is
  'As typed, less surrounding space. Nine digits or twelve with a branch
   code, dashed or not — a format check would reject a real number.';

-- ---------------------------------------------------------------------------
-- Setting them
--
-- One function for all five, because they are one block on one form and are
-- read off one certificate. Recorded in reseller_events like every other
-- change to an account: what a customer is registered as is the sort of thing
-- that is later disputed.
-- ---------------------------------------------------------------------------
create or replace function set_reseller_tax(
  p_id bigint, p_tax_type text, p_trade_name text,
  p_taxpayer text, p_tin text, p_address text
) returns void
language plpgsql security definer as $$
declare v_before jsonb;
begin
  perform require_role('admin');

  select jsonb_build_object('tax_type', tax_type, 'trade_name', trade_name,
                            'taxpayer_name', taxpayer_name, 'tin', tin,
                            'business_address', business_address)
    into v_before from resellers where id = p_id;
  if not found then
    raise exception 'There is no reseller with that number.';
  end if;

  update resellers
     set tax_type         = nullif(btrim(coalesce(p_tax_type, '')), ''),
         trade_name       = nullif(btrim(coalesce(p_trade_name, '')), ''),
         taxpayer_name    = nullif(btrim(coalesce(p_taxpayer, '')), ''),
         tin              = nullif(btrim(coalesce(p_tin, '')), ''),
         business_address = nullif(btrim(coalesce(p_address, '')), '')
   where id = p_id;

  insert into reseller_events (reseller_id, kind, detail)
  select p_id, 'tax_details_changed',
         jsonb_build_object('from', v_before, 'to',
           jsonb_build_object('tax_type', tax_type, 'trade_name', trade_name,
                              'taxpayer_name', taxpayer_name, 'tin', tin,
                              'business_address', business_address))
    from resellers where id = p_id;
end;
$$;

grant execute on function set_reseller_tax(bigint, text, text, text, text, text)
  to app_client;
alter function set_reseller_tax(bigint, text, text, text, text, text)
  set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- The order board carries them, so a document reopened months later prints
-- the same block the customer signed rather than a screenful of blank lines.
--
-- Appended at the end, because create-or-replace can only add a column there.
-- ---------------------------------------------------------------------------
create or replace view order_board as
select o.id, o.channel, o.status, o.total, o.placed_at, o.placed_by, o.delivered_at,
       o.reseller_id, r.name as reseller, r.tier,
       i.id as invoice_id, i.status as invoice_status, i.due_on,
       i.status = 'open' and i.due_on < current_date as invoice_overdue,
       case when current_role_name() = 'admin'
            then (i.amount - i.paid - i.discount) end as balance,
       r.tax_type, r.trade_name, r.taxpayer_name, r.tin, r.business_address
  from orders o
  left join resellers r on r.id = o.reseller_id
  left join invoices i on i.order_id = o.id
 where current_role_name() in ('admin','warehouse');

grant select on order_board to app_client;

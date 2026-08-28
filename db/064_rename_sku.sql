-- A product code can be corrected.
--
-- The code is the product's name in every conversation that matters: it is on
-- the purchase order, on the packing list, in the supplier's email, and read
-- out over the phone. So a typo in one is not cosmetic — it is a product
-- nobody can find — and until now the only fix was to create a second product
-- under the right code and hide the first, which splits its stock and its
-- history across two rows for ever.
--
-- Twelve tables point at products.sku, every one of them ON UPDATE NO ACTION,
-- so a rename simply failed. They cascade now. The delete rules are left
-- exactly as they were: a product with stock against it still cannot be
-- deleted, and that is right.
alter table batches              drop constraint batches_sku_fkey,
  add constraint batches_sku_fkey foreign key (sku) references products (sku) on update cascade;
alter table order_lines          drop constraint order_lines_sku_fkey,
  add constraint order_lines_sku_fkey foreign key (sku) references products (sku) on update cascade;
alter table product_photos       drop constraint product_photos_sku_fkey,
  add constraint product_photos_sku_fkey foreign key (sku) references products (sku) on delete cascade on update cascade;
alter table product_prices       drop constraint product_prices_sku_fkey,
  add constraint product_prices_sku_fkey foreign key (sku) references products (sku) on delete cascade on update cascade;
alter table promos               drop constraint promos_sku_fkey,
  add constraint promos_sku_fkey foreign key (sku) references products (sku) on update cascade;
alter table purchase_order_lines drop constraint purchase_order_lines_sku_fkey,
  add constraint purchase_order_lines_sku_fkey foreign key (sku) references products (sku) on update cascade;
alter table receiving_form_lines drop constraint receiving_form_lines_sku_fkey,
  add constraint receiving_form_lines_sku_fkey foreign key (sku) references products (sku) on update cascade;
alter table reorder_points       drop constraint reorder_points_sku_fkey,
  add constraint reorder_points_sku_fkey foreign key (sku) references products (sku) on update cascade;
alter table restock_tasks        drop constraint restock_tasks_sku_fkey,
  add constraint restock_tasks_sku_fkey foreign key (sku) references products (sku) on update cascade;
alter table returns              drop constraint returns_sku_fkey,
  add constraint returns_sku_fkey foreign key (sku) references products (sku) on update cascade;
alter table shrinkage            drop constraint shrinkage_sku_fkey,
  add constraint shrinkage_sku_fkey foreign key (sku) references products (sku) on update cascade;
alter table stock_counts         drop constraint stock_counts_sku_fkey,
  add constraint stock_counts_sku_fkey foreign key (sku) references products (sku) on update cascade;

-- ---------------------------------------------------------------------------
-- The rename itself.
--
-- Trimmed and upper-cased, because a code typed in lower case is the same code
-- and nobody should have to know that. Refused if something already holds it:
-- two products under one code is worse than the typo, and the unique index
-- would only say "duplicate key" long after the moment anybody could act on it.
-- ---------------------------------------------------------------------------
create or replace function rename_sku(p_old text, p_new text)
returns text language plpgsql security definer as $$
declare v_new text;
begin
  perform require_role('admin');
  v_new := upper(btrim(coalesce(p_new, '')));

  if v_new = '' then raise exception 'A product needs a code.'; end if;
  if length(v_new) > 40 then raise exception 'That code is too long.'; end if;
  if v_new !~ '^[A-Z0-9][A-Z0-9 _.-]*$' then
    raise exception 'A code is letters, digits, and - . _ — not %.', p_new;
  end if;
  if not exists (select 1 from products where sku = p_old) then
    raise exception 'No product has the code %.', p_old;
  end if;
  if v_new = p_old then return v_new; end if;
  if exists (select 1 from products where sku = v_new) then
    raise exception 'DUPLICATE_SKU: % already belongs to another product.', v_new;
  end if;

  update products set sku = v_new where sku = p_old;
  return v_new;
end $$;

alter function rename_sku(text, text) set search_path = public, extensions;
revoke all on function rename_sku(text, text) from public;
grant execute on function rename_sku(text, text) to app_client;

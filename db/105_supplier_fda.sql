-- ============================================================================
-- MS BEAU AVE — the FDA registration
--
-- A supplier's papers were all one heap: a valid ID, a BIR 2303, a permit. The
-- FDA registration is not one of those. It is the one paper that says the goods
-- may legally be sold at all, it is asked for by name, and it expires — so it
-- is kept as its own kind rather than as another card in the pile, and the form
-- gives it its own place to be scanned into.
-- ============================================================================

alter table supplier_files drop constraint if exists supplier_files_category_check;
alter table supplier_files add constraint supplier_files_category_check
  check (category in ('document', 'fda'));

create or replace function add_supplier_file(
  p_supplier bigint, p_label text, p_mime text, p_bytes bytea, p_category text
) returns bigint
language plpgsql security definer as $$
declare v_id bigint;
begin
  perform require_role('admin', 'warehouse', 'office');
  if coalesce(p_category, 'document') not in ('document', 'fda') then
    raise exception 'A supplier file is a paper or an FDA registration.';
  end if;
  if not exists (select 1 from suppliers where id = p_supplier) then
    raise exception 'There is no supplier with that number.';
  end if;
  insert into supplier_files (supplier_id, category, label, mime, bytes)
  values (p_supplier, coalesce(p_category, 'document'),
          nullif(btrim(coalesce(p_label, '')), ''), p_mime, p_bytes)
  returning id into v_id;
  return v_id;
end;
$$;

alter function add_supplier_file(bigint, text, text, bytea, text)
  set search_path = public, extensions;
grant execute on function add_supplier_file(bigint, text, text, bytea, text) to app_client;

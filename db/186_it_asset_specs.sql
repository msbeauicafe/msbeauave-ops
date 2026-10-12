-- Intake asked for a purchase order ID nobody had to hand at the box; what IT
-- actually writes down at unboxing is what the unit is — processor, memory,
-- storage, screen, what came in the box. So the form's last box is now Specs
-- and description. po_ref stays on the table, unused, rather than dropped:
-- a column with nothing in it costs nothing, and dropping one is not undone.

alter table it_assets add column if not exists specs text;

create or replace function it_asset_add(p jsonb) returns bigint
language plpgsql security definer as $$
declare v_id bigint; v_tag text := upper(btrim(coalesce(p ->> 'tag', '')));
begin
  perform it_require_it();
  if v_tag = '' then raise exception 'Give it an asset tag first.'; end if;
  if coalesce(btrim(p ->> 'brand'), '') = '' then raise exception 'Which brand is it?'; end if;
  if exists (select 1 from it_assets where upper(btrim(tag)) = v_tag) then
    raise exception 'Asset tag % is already on the masterlist.', v_tag;
  end if;
  if coalesce(btrim(p ->> 'serial_no'), '') <> '' and exists (
       select 1 from it_assets where upper(btrim(serial_no)) = upper(btrim(p ->> 'serial_no'))) then
    raise exception 'Serial number % is already logged.', btrim(p ->> 'serial_no');
  end if;

  insert into it_assets (tag, kind, brand, model, serial_no, supplier, po_ref, specs, condition)
  values (v_tag, p ->> 'kind', btrim(p ->> 'brand'),
          nullif(btrim(p ->> 'model'), ''), nullif(btrim(p ->> 'serial_no'), ''),
          nullif(btrim(p ->> 'supplier'), ''), nullif(btrim(p ->> 'po_ref'), ''),
          nullif(btrim(p ->> 'specs'), ''),
          coalesce(array(select jsonb_array_elements_text(p -> 'condition')), '{}'))
  returning id into v_id;
  return v_id;
end;
$$;
alter function it_asset_add(jsonb) set search_path = public, extensions;

create or replace function it_asset_json(a it_assets) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'id', a.id, 'tag', a.tag, 'kind', a.kind, 'brand', a.brand, 'model', a.model,
    'serial_no', a.serial_no, 'supplier', a.supplier, 'po_ref', a.po_ref, 'specs', a.specs,
    'condition', to_jsonb(a.condition), 'status', a.status,
    'assigned_to', a.assigned_to, 'department', a.department,
    'deployed_on', a.deployed_on, 'notes', a.notes,
    'logged_at', a.logged_at, 'logged_by', a.logged_by, 'updated_at', a.updated_at,
    'files', coalesce((select jsonb_agg(jsonb_build_object(
                         'id', f.id, 'kind', f.kind, 'uploaded_at', f.uploaded_at)
                         order by f.kind, f.id)
                         from it_asset_files f where f.asset_id = a.id), '[]'::jsonb));
$$;
alter function it_asset_json(it_assets) set search_path = public, extensions;

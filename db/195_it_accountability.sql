-- IT's employee accountability forms: the paper the shop already uses — who
-- was given what (laptop, AIO PC, keyboard, mouse, charger, phone…), its
-- model and serial, when it went out and when it came back — kept here so
-- IT can see at a glance who still holds which unit, and download the form
-- as a Word file to print and sign.
--
-- One form per employee hand-over; each line on it is one piece of equipment.
-- A line may point at a unit on the hardware masterlist (db/184): while that
-- line is out the unit reads as assigned to the employee, and when it is
-- marked returned the unit goes back into storage. A line need not point at
-- one — a calculator or a phone stand is on the form without an asset tag.
--
-- IT's alone, like the masterlist: nothing on the tables is granted, every
-- read and write goes through the functions below, which check first.

create table if not exists it_accountability (
  id            bigint generated always as identity primary key,
  employee      text not null check (length(btrim(employee)) > 0),
  employee_no   text,
  superior      text,
  department    text,
  released_by   text,
  form_date     date not null default current_date,
  notes         text,
  logged_at     timestamptz not null default now(),
  logged_by     text not null default current_actor(),
  updated_at    timestamptz not null default now()
);

create table if not exists it_accountability_items (
  id            bigint generated always as identity primary key,
  form_id       bigint not null references it_accountability (id) on delete cascade,
  line_no       int not null default 1,
  asset_id      bigint references it_assets (id) on delete set null,
  qty           int not null default 1 check (qty > 0),
  equipment     text not null check (length(btrim(equipment)) > 0),
  model_no      text,
  serial_no     text,
  specs         text,
  issued_on     date,
  returned_on   date,
  return_note   text,
  constraint it_acc_returned_after_issued check (
    returned_on is null or issued_on is null or returned_on >= issued_on)
);
create index if not exists it_acc_items_form on it_accountability_items (form_id, line_no);
create index if not exists it_acc_items_asset on it_accountability_items (asset_id) where asset_id is not null;

alter table it_accountability enable row level security;
alter table it_accountability_items enable row level security;
revoke all on it_accountability from public;
revoke all on it_accountability_items from public;

-- Every form, newest first, each with its lines in their order.
create or replace function it_acc_all() returns jsonb
language plpgsql stable security definer as $$
begin
  perform it_require_it();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
        'id', f.id, 'employee', f.employee, 'employee_no', f.employee_no,
        'superior', f.superior, 'department', f.department, 'released_by', f.released_by,
        'form_date', f.form_date, 'notes', f.notes,
        'logged_at', f.logged_at, 'logged_by', f.logged_by, 'updated_at', f.updated_at,
        'items', coalesce((
          select jsonb_agg(jsonb_build_object(
              'id', i.id, 'asset_id', i.asset_id, 'asset_tag', a.tag, 'qty', i.qty,
              'equipment', i.equipment, 'model_no', i.model_no, 'serial_no', i.serial_no,
              'specs', i.specs, 'issued_on', i.issued_on, 'returned_on', i.returned_on,
              'return_note', i.return_note) order by i.line_no, i.id)
            from it_accountability_items i left join it_assets a on a.id = i.asset_id
           where i.form_id = f.id), '[]'::jsonb))
      order by f.form_date desc, f.id desc)
    from it_accountability f), '[]'::jsonb);
end;
$$;
alter function it_acc_all() set search_path = public, extensions;

-- Save a form whole: its header and every line as the form now has them.
-- New when it has no id. A linked unit follows its line — out to the
-- employee, or back into storage once returned or taken off the form.
create or replace function it_acc_save(p jsonb) returns bigint
language plpgsql security definer as $$
declare
  v_id bigint := nullif(p ->> 'id', '')::bigint;
  v_emp text := btrim(coalesce(p ->> 'employee', ''));
  v_dept text := nullif(btrim(p ->> 'department'), '');
  v_before bigint[];
  v_line jsonb;
  v_n int := 0;
begin
  perform it_require_it();
  if v_emp = '' then raise exception 'Pick the employee first.'; end if;
  if jsonb_typeof(coalesce(p -> 'items', '[]'::jsonb)) <> 'array' then
    raise exception 'The equipment list is not readable.';
  end if;
  -- A unit can be out on one line at a time, across every form.
  if exists (
      select 1 from jsonb_array_elements(coalesce(p -> 'items', '[]'::jsonb)) x
       where nullif(x ->> 'asset_id', '') is not null and nullif(x ->> 'returned_on', '') is null
       group by x ->> 'asset_id' having count(*) > 1) then
    raise exception 'The same unit is on this form twice.';
  end if;
  if exists (
      select 1 from jsonb_array_elements(coalesce(p -> 'items', '[]'::jsonb)) x
        join it_accountability_items i on i.asset_id = (x ->> 'asset_id')::bigint
       where nullif(x ->> 'asset_id', '') is not null and nullif(x ->> 'returned_on', '') is null
         and i.returned_on is null and i.form_id is distinct from v_id) then
    raise exception 'One of those units is still out on another employee''s form.';
  end if;

  if v_id is null then
    insert into it_accountability (employee, employee_no, superior, department, released_by, form_date, notes)
    values (v_emp, nullif(btrim(p ->> 'employee_no'), ''), nullif(btrim(p ->> 'superior'), ''), v_dept,
            nullif(btrim(p ->> 'released_by'), ''),
            coalesce(nullif(p ->> 'form_date', '')::date, current_date), nullif(btrim(p ->> 'notes'), ''))
    returning id into v_id;
    v_before := '{}';
  else
    update it_accountability set
      employee = v_emp, employee_no = nullif(btrim(p ->> 'employee_no'), ''),
      superior = nullif(btrim(p ->> 'superior'), ''), department = v_dept,
      released_by = nullif(btrim(p ->> 'released_by'), ''),
      form_date = coalesce(nullif(p ->> 'form_date', '')::date, form_date),
      notes = nullif(btrim(p ->> 'notes'), ''), updated_at = now()
    where id = v_id;
    if not found then raise exception 'There is no such form.'; end if;
    select coalesce(array_agg(asset_id), '{}') into v_before
      from it_accountability_items where form_id = v_id and asset_id is not null and returned_on is null;
    delete from it_accountability_items where form_id = v_id;
  end if;

  for v_line in select * from jsonb_array_elements(coalesce(p -> 'items', '[]'::jsonb)) loop
    -- A blank line on the form is left off, not refused.
    continue when coalesce(btrim(v_line ->> 'equipment'), '') = '' and nullif(v_line ->> 'asset_id', '') is null;
    v_n := v_n + 1;
    if nullif(v_line ->> 'returned_on', '')::date < nullif(v_line ->> 'issued_on', '')::date then
      raise exception '% is marked returned before it was issued.',
        coalesce(nullif(btrim(v_line ->> 'equipment'), ''), 'A line');
    end if;
    insert into it_accountability_items
      (form_id, line_no, asset_id, qty, equipment, model_no, serial_no, specs, issued_on, returned_on, return_note)
    values (v_id, v_n, nullif(v_line ->> 'asset_id', '')::bigint,
            greatest(coalesce(nullif(v_line ->> 'qty', '')::int, 1), 1),
            coalesce(nullif(btrim(v_line ->> 'equipment'), ''), 'Equipment'),
            nullif(btrim(v_line ->> 'model_no'), ''), nullif(btrim(v_line ->> 'serial_no'), ''),
            nullif(btrim(v_line ->> 'specs'), ''),
            nullif(v_line ->> 'issued_on', '')::date, nullif(v_line ->> 'returned_on', '')::date,
            nullif(btrim(v_line ->> 'return_note'), ''));
  end loop;

  -- Out on this form: the unit is the employee's.
  update it_assets a set status = 'assigned', assigned_to = v_emp, department = v_dept,
         deployed_on = coalesce(i.issued_on, a.deployed_on, current_date), updated_at = now()
    from it_accountability_items i
   where i.form_id = v_id and i.asset_id = a.id and i.returned_on is null and a.status <> 'retired';
  -- Back, or off the form: into storage, if it was still this employee's.
  update it_assets a set status = 'storage', assigned_to = null, department = null,
         deployed_on = null, updated_at = now()
   where a.status = 'assigned' and a.assigned_to = v_emp
     and (a.id = any(v_before) or exists (
           select 1 from it_accountability_items i
            where i.form_id = v_id and i.asset_id = a.id and i.returned_on is not null))
     and not exists (select 1 from it_accountability_items i
                      where i.asset_id = a.id and i.returned_on is null);
  return v_id;
end;
$$;
alter function it_acc_save(jsonb) set search_path = public, extensions;

-- A form written in error. Any unit still out on it goes back into storage.
create or replace function it_acc_delete(p_id bigint) returns void
language plpgsql security definer as $$
declare v_emp text; v_out bigint[];
begin
  perform it_require_it();
  select employee into v_emp from it_accountability where id = p_id;
  if not found then raise exception 'There is no such form.'; end if;
  select coalesce(array_agg(asset_id), '{}') into v_out
    from it_accountability_items where form_id = p_id and asset_id is not null and returned_on is null;
  delete from it_accountability where id = p_id;
  update it_assets set status = 'storage', assigned_to = null, department = null,
         deployed_on = null, updated_at = now()
   where id = any(v_out) and status = 'assigned' and assigned_to = v_emp;
end;
$$;
alter function it_acc_delete(bigint) set search_path = public, extensions;

revoke all on function it_acc_all() from public;
revoke all on function it_acc_save(jsonb) from public;
revoke all on function it_acc_delete(bigint) from public;
grant execute on function it_acc_all() to app_client;
grant execute on function it_acc_save(jsonb) to app_client;
grant execute on function it_acc_delete(bigint) to app_client;

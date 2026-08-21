-- ============================================================================
-- MS BEAU AVE — a person's own face
--
-- The staff workspace showed a broken image where somebody's photograph should
-- be, on a record that said it had one. Both were right. `has_photo` comes from
-- my_profile(), which is a security-definer function and can see the table; the
-- picture itself was fetched by a route reading employee_photos directly, and an
-- employee sign-in has no policy on that table — deliberately, because that is
-- the whole design. The row-level rules did exactly what they were written to
-- do and the query came back empty.
--
-- So the picture comes through a function like everything else they are allowed
-- to see. Nothing about the boundary changes: it still resolves the person from
-- the session rather than from anything the browser sent, so there is no number
-- to alter into somebody else's face.
-- ============================================================================
create or replace function my_photo()
returns table (mime text, bytes bytea, updated_at timestamptz)
language plpgsql stable security definer as $$
declare v_me bigint := current_employee();
begin
  perform require_role('admin','employee');
  if v_me is null then
    raise exception 'That sign-in does not belong to anybody on the team.';
  end if;
  return query
  select p.mime, p.bytes, p.updated_at
    from employee_photos p where p.employee_id = v_me;
end;
$$;

grant execute on function my_photo() to app_client;
alter function my_photo() set search_path = public, extensions;

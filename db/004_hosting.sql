-- ============================================================================
-- MS BEAU AVE — hardening for a hosted database
--
-- Apply this after 001–003 on any managed Postgres (Supabase and the like).
-- It is separate because it deals with roles those platforms create, which do
-- not exist on a plain local Postgres — running it there is harmless, it
-- simply finds nothing to revoke.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- A SECURITY DEFINER function with a mutable search_path can be pointed at a
-- schema the caller controls and made to run their code with the definer's
-- rights. Pinning it closes that off.
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as signature
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
  loop
    execute format('alter function %s set search_path = public, extensions', r.signature);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Close the REST surface.
--
-- The application reaches this database over a direct connection, never
-- through PostgREST. Supabase still exposes everything in `public` to its
-- `anon` and `authenticated` roles, which means the publishable key that ships
-- inside any browser could otherwise call these functions — `create_login` and
-- `sell` among them — at /rest/v1/rpc/….
--
-- Note that EXECUTE has to come off PUBLIC, not off those two roles by name:
-- Postgres grants it to PUBLIC on every new function, and the platform roles
-- inherit it from there, so revoking by name changes nothing.
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as signature
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
  loop
    execute format('revoke all on function %s from public', r.signature);
    execute format('grant execute on function %s to app_client', r.signature);
  end loop;
end $$;

do $$
begin
  execute 'revoke all on all tables in schema public from anon, authenticated';
  execute 'revoke all on all sequences in schema public from anon, authenticated';
  execute 'revoke usage on schema public from anon, authenticated';
  execute 'alter default privileges in schema public revoke all on tables from anon, authenticated';
  execute 'alter default privileges in schema public revoke all on sequences from anon, authenticated';
exception when undefined_object then
  raise notice 'no anon/authenticated roles here — nothing to close off';
end $$;

alter default privileges in schema public revoke execute on functions from public;

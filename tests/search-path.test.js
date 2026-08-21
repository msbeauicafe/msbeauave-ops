// Every security-definer function keeps its search_path pinned.
//
// A security-definer function runs with its owner's rights. If it does not pin
// its search_path, the caller's takes effect, and a caller who can create a
// schema of their own can put a table or an operator in front of the real one
// and have owner-level code use it instead. That is the standard way these
// functions are turned inside out, and the whole permission model here is built
// out of them.
//
// This test exists because of a specific mistake rather than a theory. Six
// functions were rewritten with `create or replace` to widen a role, which
// silently wipes a function's stored settings — the pinned search_path
// included. Nothing warns. Nothing fails. The functions keep working, with the
// protection quietly gone, and the only sign is a column in a catalogue table
// nobody looks at.
//
// So it is read off the live schema rather than off the files: the question is
// what the database ended up with, not what any one migration meant to say.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 });
test.after(() => db.end());

test('no security-definer function is left with an unpinned search_path', async () => {
  const { rows } = await db.query(`
    select p.proname, pg_get_function_identity_arguments(p.oid) as args
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prosecdef
       and (p.proconfig is null
            or not exists (select 1 from unnest(p.proconfig) c
                            where c like 'search\\_path=%'))
     order by p.proname`);

  const loose = rows.map((r) => `${r.proname}(${r.args})`);
  assert.deepEqual(loose, [],
    `these run as their owner with the caller's search_path: ${loose.join(', ')}`);
});

test('and there are plenty of them, so the check is checking something', async () => {
  // A query that matched nothing at all would pass the test above for the
  // wrong reason — a renamed catalogue column, a schema that moved.
  const { rows } = await db.query(`
    select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prosecdef`);
  assert.ok(rows[0].n > 50,
    `expected the schema to be full of definer functions, found ${rows[0].n}`);
});

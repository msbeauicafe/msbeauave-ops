// The database connection, and the rule that every request runs inside one
// transaction as the limited `app_client` role with the caller's identity set.
//
// Nothing in the API is allowed to talk to Postgres any other way, which is
// what makes the row-level security policies meaningful rather than decorative.
import pg from 'pg';

const DSN = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL;

export const configError = DSN ? null
  : 'This deployment has no database yet. Set DATABASE_URL (and SESSION_SECRET) '
  + 'in the hosting environment.';

export const pool = DSN
  ? new pg.Pool({
      connectionString: DSN,
      max: Number(process.env.DB_POOL_MAX || 5),
      // Serverless containers are recycled without warning; holding idle
      // connections open just exhausts the database's connection budget.
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    })
  : null;

pool?.on('error', (e) => console.error('idle database client error:', e.message));

/**
 * Run a handler inside a transaction, as `app_client`, with the caller's role
 * and identity set for the row-level security policies.
 *
 * The role is re-read from app_users on every request rather than trusted from
 * the cookie. The cookie is signed so it cannot be forged, but it can be
 * stale: switching someone off has to end their open session now, not in
 * twelve hours when their cookie happens to expire.
 */
export async function asUser(session, handler) {
  const client = await pool.connect();
  // The identity is a number from a signed cookie, but it is about to be
  // written into SQL text rather than bound, so it is checked as a number
  // here and not merely assumed to be one.
  const id = Number(session.id);
  if (!Number.isInteger(id) || id <= 0) {
    const error = new Error('Sign in again.');
    error.status = 401;
    throw error;
  }
  try {
    // Opening the transaction, reading the row and setting the identity used
    // to be four exchanges with the database. Over a link to another country
    // that is four times the latency before the request has done anything at
    // all, on every request — the reason a screen took a second to draw when
    // the queries behind it take forty milliseconds.
    //
    // They are one exchange now. It is safe to send them together because
    // nothing here is a parameter: the id is checked as an integer above, and
    // the actor is read from the row rather than taken from the cookie, which
    // is both shorter and stricter than what it replaces. Every set_config is
    // transaction-local, so a row that turns out to be switched off leaves
    // nothing behind when the rollback below throws it away.
    const batch = await client.query(`begin;
      select role, reseller_id, branch_id, active, display_name, sessions_from,
             set_config('app.role',        coalesce(role, ''),               true),
             set_config('app.actor',       coalesce(username, ''),           true),
             set_config('app.reseller_id', coalesce(reseller_id::text, ''),  true),
             set_config('app.branch_id',   coalesce(branch_id::text, ''),    true)
        from app_users where id = ${id};
      set local role app_client;`);

    const live = batch[1];
    const user = live.rows[0];
    if (!user || !user.active) {
      const error = new Error('Your access has been switched off. Check with the owner.');
      error.status = 401;
      throw error;
    }
    // Signed out from somewhere else. The cookie is still valid and still
    // signed; it is simply older than the line the owner drew.
    if (user.sessions_from && Number(session.issued || 0) < user.sessions_from.getTime()) {
      const error = new Error('This device was signed out by the owner. Sign in again.');
      error.status = 401;
      throw error;
    }

    // The branch came from the row above, never from the request: a sign-in
    // tied to one shop cannot be talked out of it by anything the browser
    // sends.
    const result = await handler(client, {
      ...session,
      role: user.role,
      name: user.display_name,
      resellerId: user.reseller_id == null ? null : Number(user.reseller_id),
      branchId: user.branch_id == null ? null : Number(user.branch_id),
    });
    await client.query('commit');
    return result;
  } catch (e) {
    try { await client.query('rollback'); } catch { /* connection already gone */ }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Several queries on one client, in sequence.
 *
 * A pooled client runs strictly one query at a time; handing pg overlapping
 * queries on the same connection is deprecated and stops working in pg 9.
 */
export async function queryAll(client, statements) {
  const out = [];
  for (const [sql, params] of statements) out.push(await client.query(sql, params));
  return out;
}

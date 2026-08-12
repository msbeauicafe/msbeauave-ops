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
  try {
    await client.query('begin');

    const live = await client.query(
      'select role, reseller_id, branch_id, active, display_name from app_users where id = $1',
      [session.id]);
    const user = live.rows[0];
    if (!user || !user.active) {
      const error = new Error('Your access has been switched off. Check with the owner.');
      error.status = 401;
      throw error;
    }

    // The branch comes from the row, never from the request. A sign-in tied to
    // one shop cannot be talked out of it by anything the browser sends.
    await client.query(
      `select set_config('app.role', $1, true),
              set_config('app.actor', $2, true),
              set_config('app.reseller_id', $3, true),
              set_config('app.branch_id', $4, true)`,
      [user.role, session.username,
       user.reseller_id == null ? '' : String(user.reseller_id),
       user.branch_id == null ? '' : String(user.branch_id)]);
    await client.query('set local role app_client');

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

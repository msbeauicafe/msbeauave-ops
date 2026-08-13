// A small router: match a method and path, check the role, run the handler
// inside a transaction, and only then send the response.
//
// The response is staged rather than written, and flushed after the commit.
// A cashier must never be shown a receipt — and hand over the goods — for a
// sale that then failed to commit.
import { asUser, configError } from './db.js';
import { explain } from './errors.js';
import { readSession } from './auth.js';

export const ANYONE = 'anyone';                       // no sign-in required
export const ADMIN = ['admin'];
// A supervisor covers a shop floor, so they appear wherever a cashier or a
// stockroom person does — and nowhere an owner does. The database enforces the
// same rule in require_role; this is only so the router refuses early, with a
// clearer message than a permission error from three layers down.
export const STOCK = ['admin', 'warehouse', 'supervisor', 'office'];
export const TILL = ['admin', 'cashier', 'supervisor', 'office'];
export const STAFF = ['admin', 'warehouse', 'cashier', 'supervisor', 'office'];
// The day their own shop had: takings, shifts, what is short on the shelf.
// Never the company's money, and never another branch's.
export const SUPER = ['admin', 'supervisor'];
// The door tablet's own sign-in. It is on exactly four routes — who is on the
// team, which shops exist, and the two ways of clocking — and nowhere else.
// Adding it to a fifth should feel like a decision, which is why it is its own
// list rather than a member of STAFF.
export const CLOCKDEV = ['admin', 'warehouse', 'cashier', 'supervisor', 'office', 'timekeeper'];
export const RESELLER = ['reseller'];

const routes = [];

export function on(method, pattern, roles, handler) {
  routes.push({
    method,
    roles,
    handler,
    keys: [...pattern.matchAll(/:(\w+)/g)].map((m) => m[1]),
    pattern: new RegExp(`^${pattern.replace(/:(\w+)/g, '([^/]+)')}$`),
  });
}

export const send = (res, status, body) => { res.staged = { status, body }; };
export const ok = (res, body) => send(res, 200, body);
export const fail = (res, status, message) => send(res, status, { error: message });

function flush(res, fallback) {
  if (res.headersSent) return;
  const { status, body } = res.staged ?? fallback ?? { status: 204, body: null };
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body === null ? '' : JSON.stringify(body));
}

function readBody(req) {
  // Serverless platforms parse JSON before the handler runs and leave the
  // stream drained; reading it again would hang until the request timed out.
  if (req.body !== undefined) {
    if (typeof req.body === 'string') {
      try { return Promise.resolve(req.body ? JSON.parse(req.body) : {}); }
      catch { return Promise.reject(new Error('That request was not valid JSON.')); }
    }
    return Promise.resolve(req.body ?? {});
  }
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(new Error('That request was not valid JSON.')); }
    });
    req.on('error', reject);
  });
}

export async function handle(req, res) {
  const url = new URL(req.url, 'http://internal');
  const path = decodeURIComponent(url.pathname).replace(/\/+$/, '') || '/';

  const matching = routes.filter((r) => r.pattern.test(path));
  const route = matching.find((r) => r.method === req.method);
  if (!route) {
    return flush(res, matching.length
      ? { status: 405, body: { error: 'That is not something you can do here.' } }
      : { status: 404, body: { error: 'No such endpoint.' } });
  }

  if (configError) {
    return flush(res, { status: 503, body: { error: configError } });
  }

  const params = {};
  route.pattern.exec(path).slice(1).forEach((v, i) => { params[route.keys[i]] = v; });
  const query = Object.fromEntries(url.searchParams);

  try {
    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};

    if (route.roles === ANYONE) {
      await route.handler({ req, res, body, params, query });
    } else {
      const session = readSession(req);
      if (!session) {
        fail(res, 401, 'Please sign in.');
      } else if (!route.roles.includes(session.role)) {
        fail(res, 403, 'Your sign-in does not allow that.');
      } else {
        await asUser(session, (db, user) =>
          route.handler({ req, res, db, user, body, params, query }));
      }
    }
    flush(res);
  } catch (e) {
    res.staged = null;                    // never emit a half-finished result
    flush(res, { status: e.status ?? 400, body: { error: explain(e) } });
  }
}

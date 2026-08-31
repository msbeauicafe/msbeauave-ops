// A small router: match a method and path, check the role, run the handler
// inside a transaction, and only then send the response.
//
// The response is staged rather than written, and flushed after the commit.
// A cashier must never be shown a receipt — and hand over the goods — for a
// sale that then failed to commit.
import { asUser, configError } from './db.js';
import { explain } from './errors.js';
import { readSession, needsRenewing, sessionCookie } from './auth.js';

export const ANYONE = 'anyone';                       // no sign-in required
export const ADMIN = ['admin'];
// A supervisor covers a shop floor, so they appear wherever a cashier or a
// stockroom person does — and nowhere an owner does. The database enforces the
// same rule in require_role; this is only so the router refuses early, with a
// clearer message than a permission error from three layers down.
// The data coordinator keeps the catalogue and the stock records: it reaches
// the stockroom's routes (STOCK) and the staff reads (STAFF) like the
// warehouse, and its own record like any member of staff. What it may actually
// change is named in db/073 — the stock functions, and adding a product;
// never a selling price, the till, or a customer order.
export const STOCK = ['admin', 'warehouse', 'supervisor', 'office', 'datacoord'];
export const TILL = ['admin', 'cashier', 'supervisor', 'office'];
export const STAFF = ['admin', 'warehouse', 'cashier', 'supervisor', 'office', 'datacoord'];
// The day their own shop had: takings, shifts, what is short on the shelf.
// Never the company's money, and never another branch's.
export const SUPER = ['admin', 'supervisor'];
// The door tablet's own sign-in. It is on exactly four routes — who is on the
// team, which shops exist, and the two ways of clocking — and nowhere else.
// Adding it to a fifth should feel like a decision, which is why it is its own
// list rather than a member of STAFF.
export const CLOCKDEV = ['admin', 'warehouse', 'cashier', 'supervisor', 'office', 'timekeeper'];
export const RESELLER = ['reseller'];
// Somebody who may look and not touch. Fifteen managers who need to see how
// the company is running without being able to change any of it.
//
// This list is only on GET routes, and only on the ones that are a management
// report. It is not the mechanism — require_role in the database is, and it
// never accepts an observer, so a function added next year refuses one without
// anybody remembering to make it. This is what gives them a clear refusal at
// the door instead of a permission error from three layers down.
export const OBSERVE = ['admin', 'observer'];
// The order desk: an owner inside Customer order, and a member of staff
// everywhere a member of staff is — their own record, their leave, the
// noticeboard, their own password. It was left off those four lists when the
// role was added, so the menu offered screens that then refused them; a role
// is not only what it is allowed to do that is special, it is also everything
// ordinary that everybody who works here can already do.
// It is not a union of roles that already exist — it is a slice of the owner —
// so unlike a supervisor or an office sign-in it inherits nothing, and every
// route it may reach names it. The database says the same thing in the
// sixteen functions that screen calls, and refuses it everywhere else; this
// list is so the refusal arrives at the door rather than three layers down.
export const ORDERDESK = ['admin', 'orderdesk'];
// The same, plus whoever already worked an order: the packing list and the
// order behind it are read by the bench and the stockroom too.
export const ORDERWORK = ['admin', 'warehouse', 'supervisor', 'office', 'orderdesk'];
// Somebody asking about themselves. Every route on this list resolves the
// person inside the database, from the session's own actor, so it is not
// possible to ask one of them about somebody else — which is what makes it
// safe for two roles to share the routes at all.
export const PERSON = ['admin', 'employee', 'orderdesk', 'datacoord'];
// The same, plus somebody who may look and not touch — because looking at
// their own record is looking. Split from PERSON rather than added to it so
// that asking for leave and withdrawing it, which write, keep the shorter
// list: the difference between the two names is the whole rule.
export const OWN_RECORD = ['admin', 'employee', 'observer', 'orderdesk', 'datacoord'];
// The noticeboard: the one thing everybody reads the same copy of. Which is
// the reason somebody who may look and not touch is on it — a notice pinned up
// for the whole company is pinned up for them too.
export const NOTICEBOARD =
  ['admin', 'warehouse', 'cashier', 'supervisor', 'office', 'employee', 'observer',
   'orderdesk', 'datacoord'];
// Anybody who is a person rather than a device. Somebody who may only look is
// on it, because their own password is not part of what they may not change.
// The timekeeper is not: it is a tablet on a wall, and whoever is standing in
// front of it is not the tablet.
export const OWN_ACCOUNT =
  ['admin', 'warehouse', 'cashier', 'supervisor', 'office', 'employee',
   'observer', 'reseller', 'orderdesk', 'datacoord'];

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
        await asUser(session, (db, user) => {
          // A sign-in that is being used stays signed in. Done here, before
          // the handler, because some replies are written straight to the
          // socket and there would be no headers left to add to afterwards.
          // The live row is used rather than the cookie, so somebody whose
          // role changed this morning carries the new one from now on.
          if (needsRenewing(session)) {
            res.setHeader('Set-Cookie', sessionCookie({
              id: session.id, username: session.username,
              display_name: user.display_name, role: user.role,
              reseller_id: user.reseller_id,
            }, req));
          }
          return route.handler({ req, res, db, user, body, params, query });
        });
      }
    }
    flush(res);
  } catch (e) {
    res.staged = null;                    // never emit a half-finished result
    flush(res, { status: e.status ?? 400, body: { error: explain(e) } });
  }
}

// Passwords and sessions.
//
// Passwords are scrypt digests — the database only ever stores the digest.
// Sessions are signed cookies rather than server-side records, so there is no
// session store to lose when a serverless container is recycled.
import crypto from 'node:crypto';

const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const HOURS = 12;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function checkPassword(password, stored) {
  const [scheme, salt, digest] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !salt || !digest) return false;
  const want = Buffer.from(digest, 'base64');
  const got = crypto.scryptSync(password, Buffer.from(salt, 'base64'), want.length);
  return crypto.timingSafeEqual(want, got);
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function unsign(token) {
  const [body, mac] = String(token || '').split('.');
  if (!body || !mac) return null;
  const want = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (mac.length !== want.length
      || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
  try {
    const session = JSON.parse(Buffer.from(body, 'base64url').toString());
    return session.expires > Date.now() ? session : null;
  } catch {
    return null;
  }
}

export function readSession(req) {
  const jar = Object.fromEntries(
    (req.headers.cookie || '').split(';')
      .map((c) => c.trim().split('='))
      .filter(([k]) => k)
      .map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
  return unsign(jar.session);
}

export function sessionCookie(user, req) {
  const session = {
    id: Number(user.id), username: user.username, name: user.display_name,
    role: user.role, resellerId: user.reseller_id == null ? null : Number(user.reseller_id),
    expires: Date.now() + HOURS * 3600e3,
  };
  // SameSite=Lax already blocks the cross-site POSTs a CSRF attack needs.
  // Secure is added whenever the request arrived over TLS, directly or through
  // a proxy, so the cookie never travels in the clear in production.
  const secure = req.socket?.encrypted || req.headers['x-forwarded-proto'] === 'https';
  return `session=${sign(session)}; HttpOnly; SameSite=Lax; Path=/;`
       + `${secure ? ' Secure;' : ''} Max-Age=${HOURS * 3600}`;
}

export const clearedCookie = 'session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0';

export const publicUser = (s) => ({
  username: s.username, name: s.name, role: s.role, resellerId: s.resellerId,
});

// ---------------------------------------------------------------------------
// Shoppers
//
// A customer's session is a different cookie from a staff session, and the two
// never mix: signing in at the counter must not sign you in to the shop, and a
// shopper must never hold something the router could mistake for a role.
// ---------------------------------------------------------------------------
const SHOPPER_DAYS = 60;

export function shopperCookie(customer, req) {
  const session = {
    cid: Number(customer.id),
    name: customer.name,
    expires: Date.now() + SHOPPER_DAYS * 86400e3,
  };
  const secure = req.socket?.encrypted || req.headers['x-forwarded-proto'] === 'https';
  return `shopper=${sign(session)}; HttpOnly; SameSite=Lax; Path=/;`
       + `${secure ? ' Secure;' : ''} Max-Age=${SHOPPER_DAYS * 86400}`;
}

export function readShopper(req) {
  const jar = Object.fromEntries(
    (req.headers.cookie || '').split(';')
      .map((c) => c.trim().split('='))
      .filter(([k]) => k)
      .map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
  const session = unsign(jar.shopper);
  return session && session.cid ? session : null;
}

export const clearedShopper = 'shopper=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0';

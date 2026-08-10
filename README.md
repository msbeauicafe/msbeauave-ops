# MS BEAU AVE — stock, till and reseller operations

One stock pool across the warehouse, the shop counter and the reseller
network. A sale at the till and an order from a reseller move the same units,
tracked by batch and expiry, so neither channel can sell what the other has
already promised.

```bash
npm install
npm run dev          # a throwaway database, demo data, and the app on :4000
```

Then open <http://localhost:4000>. Every demo password is `msbeauave`:

| Sign in as | What they see |
|---|---|
| `admin` | Everything: the dashboard, products, receiving, wholesale orders, resellers, returns, reordering, reports, sign-ins |
| `warehouse` | Picking and sending, receiving, moving stock, shelf tasks |
| `cashier` | The till, returns, the close of day |
| `reseller` | The wholesale portal for an account in good standing |
| `blocked` | The same portal for an account that is past due, so you can see the block |

`npm run dev` throws the database away when you stop it. To keep the data,
point it at a real Postgres:

```bash
export DATABASE_URL='postgres://…'
export SESSION_SECRET='any long random string'
for f in db/0*.sql; do psql "$DATABASE_URL" -f "$f"; done
npm run seed          # optional demo data
npm run serve
```

## A five-minute tour

1. **Sign in as `admin`.** The dashboard leads with today's takings, then only
   the things that need a decision: what to reorder, who is past due, which
   batches are close to expiry, and whether too much of the money owed rests
   on one account. Radiance Vitamin C Serum shows a reorder point of **1,125**
   — worked out by the database, not typed in.
2. **Receive a delivery.** Any product, a batch number, an expiry, 100 units.
   It splits **70 / 20 / 10** between the reseller pool, the shop shelf and the
   reserve. Change that split per product under Products.
3. **Sign in as `cashier`.** Search or scan, tap to build a basket, take cash,
   and get a receipt naming the batches that actually left the shelf — always
   the ones expiring soonest. Sell a product down to nothing and a task appears
   on the warehouse screen without anyone raising it.
4. **Close of day** asks for the drawer count *before* it will say what the
   till expected. Submit, and the difference is recorded; anyone who is
   repeatedly out shows up on the owner's dashboard.
5. **Sign in as `blocked`.** The portal says exactly why ordering is refused
   and exactly what to pay. Sign in as `reseller` and place a real order —
   stock is held the moment it goes through, and the warehouse sees it with a
   pick list in expiry order.

## Where the rules live

In the database, not the application. Pools, expiry order, holding stock
against an order, the credit gate, and the blind cash count are functions and
constraints in `db/`. The API only ever calls them, so a future mobile app, an
integration, or someone at a psql prompt all get the same answers as the web
pages — and none of them can work around a rule.

| Path | What it is |
|---|---|
| `db/001_schema.sql` | Tables, and the constraints that hold regardless of who is writing |
| `db/002_rules.sql` | The rules: allocation, expiry-order picking, holding stock, credit, the till, payments, reorder points |
| `db/003_views_and_access.sql` | What each screen reads, and the row-level security under it |
| `db/004_hosting.sql` | Extra hardening for a hosted database (see below) |
| `db/900_demo_data.sql` | Optional demo shop, built by calling the rules above |
| `api/[[...route]].js` | The whole API, as one serverless function |
| `lib/` | Router, database access, sessions, plain-language errors |
| `public/` | The pages — three files, no build step |
| `tests/acceptance.test.js` | 29 tests against a real Postgres over real HTTP |

```bash
npm test
```

## What the tests actually check

Not that the code runs — that the shop is safe. A delivery splitting 70/20/10
without losing a unit to rounding. Two resellers going for the last five units
at the same moment, with exactly one winning and the other told what is left.
Short-dated stock never reaching a reseller, but still clearing through the
shop. The reorder arithmetic. A new account unable to have goods dispatched
before paying, a past-due account stopped with the amount named, and an
override that cannot happen without a reason on the record. The last unit on
the shelf raising its own restock task. The till total staying hidden until
the drawer has been counted.

## Deploying

The pages are static and the API is one function, so this fits Vercel's
default layout with no build configuration.

1. Push this repository to GitHub.
2. On Vercel, **Add New → Project**, import the repository, and deploy.
3. In **Settings → Environment Variables**, add:

   | Name | Value |
   |---|---|
   | `DATABASE_URL` | Supabase → Project Settings → Database → Connection string → **Transaction pooler** (put your real password in place of `[YOUR-PASSWORD]`) |
   | `SESSION_SECRET` | any long random string — without it, everyone is signed out on each deployment |

4. Redeploy so the variables are picked up.

Use the **transaction pooler** connection string rather than the direct one:
serverless functions come and go constantly, and the pooler is what keeps that
from exhausting the database's connections.

On a database with no sign-ins yet, create the first owner with:

```sql
select create_login('admin', 'Owner', '<scrypt digest>', 'admin');
```

…or load `db/900_demo_data.sql` and change the demo passwords afterwards.

### Hosted databases

Run `db/004_hosting.sql` as well. Supabase exposes everything in the `public`
schema to its `anon` and `authenticated` roles, which means the publishable key
inside any browser could otherwise call these functions over REST. That file
closes the REST surface and pins each function's search path. It is harmless on
a local Postgres, where those roles do not exist.

## Not in this version

Payroll and staff records, purchase orders beyond knowing what to reorder,
card and e-wallet processing (the method is recorded; the money is taken the
way it always was), text and email alerts, tax filing, and more than one
warehouse.

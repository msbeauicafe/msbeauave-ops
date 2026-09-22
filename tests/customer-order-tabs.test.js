// One job, one menu.
//
// The customer order, the invoice and the packing list were three entries in
// a column of two dozen, sitting apart from each other. They are not three
// parts of the system — they are moments of one job: somebody messages, the
// order is taken, the bench packs it. Holding one while looking at another
// meant leaving the screen and finding it again.
//
// The account the order is taken from is not one of those moments, so it is
// not one of those tabs: it lives under Customers, beside the loyalty list,
// because both answer the same question about a different kind of buyer.
//
// This reads the real source rather than a copy of it, because the failure it
// guards against is somebody adding a screen and quietly restoring a
// top-level menu entry beside it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = fs.readFileSync(path.join(here, '..', 'public/app.js'), 'utf8');
const css = fs.readFileSync(path.join(here, '..', 'public/styles.css'), 'utf8');

// The admin menu, from `admin: [` to the `]` that closes it.
const adminMenu = (() => {
  const at = app.indexOf('  admin: [');
  return app.slice(at, app.indexOf('\n  ],', at));
})();

test('an owner has one Customer order menu, not three', () => {
  const entries = [...adminMenu.matchAll(/\['([a-z]+)',\s*'[^']*',\s*'([^']+)'\]/g)]
    .map((m) => ({ id: m[1], label: m[2] }));

  const named = entries.filter((e) => e.label === 'Customer order');
  assert.equal(named.length, 1, 'exactly one entry is called Customer order');
  assert.equal(named[0].id, 'customerorder');

  for (const gone of ['Packing list', 'Invoice']) {
    assert.equal(entries.filter((e) => e.label === gone).length, 0,
      `${gone} is a panel inside Customer order now, not a menu of its own`);
  }
});

test('the panels are the four documents, in the order the work happens', () => {
  const at = app.indexOf('SCREENS.customerorder = async');
  assert.ok(at > 0, 'there is a Customer order screen');
  const screen = app.slice(at, app.indexOf('\n};', at));

  const panels = [...screen.matchAll(/\['([a-z]+)',\s*'([^']+)'\]/g)].map((m) => m[1]);
  assert.deepEqual(panels, ['chatorders', 'draftorders', 'pendingorders', 'coinvoices', 'orders'],
    'somebody messages, it is taken (or set aside), the account is invoiced, the bench packs it');

  assert.match(screen, /SCREENS\[orderPanel\]/,
    'the panel is drawn by the screen it names, not by a copy of it');
});

test('Customers carries the reseller account beside the shop list', () => {
  const at = app.indexOf('SCREENS.customers = async');
  assert.ok(at > 0, 'there is a Customers screen');
  const screen = app.slice(at, app.indexOf('\n};', at));

  const panels = [...screen.matchAll(/\['([a-z]+)',\s*'([^']+)'\]/g)].map((m) => m[1]);
  assert.deepEqual(panels,
    ['reselleraccounts', 'distributoraccounts', 'retaileraccounts', 'crm', 'birthdays'],
    'the wholesale accounts split by tier first, because this company is a '
    + 'distributor, then the shop’s own loyalty list, then this month’s birthdays');
  assert.match(screen, /SCREENS\[customerPanel\]/,
    'the panel is drawn by the screen it names, not by a copy of it');
  assert.match(app, /let customerPanel = 'reselleraccounts';/,
    'which panel is open is kept outside the screen function');

  const entries = [...adminMenu.matchAll(/\['([a-z]+)',\s*'[^']*',\s*'([^']+)'\]/g)]
    .map((m) => ({ id: m[1], label: m[2] }));
  const named = entries.filter((e) => e.label === 'Customers');
  assert.equal(named.length, 1, 'exactly one entry is called Customers');
  assert.equal(named[0].id, 'customers');
  assert.equal(entries.filter((e) => e.id === 'resellers').length, 0,
    'Resellers is a panel, not a menu of its own');
});

// Who they are and what they owe are two jobs. The dialog is one function
// drawing whichever half it was opened for, so a section cannot end up in
// both halves or in neither.
test('the account splits into the half you came for', () => {
  const at = app.indexOf('async function openReseller');
  assert.ok(at > 0, 'there is one reseller dialog');
  const fn = app.slice(at, app.indexOf('\n}\n', at));

  assert.match(fn, /const acct = part === 'account';/);
  assert.match(fn, /const money = part === 'money';/);

  // Every heading in the dialog, and which half it is inside.
  const halves = {};
  let half = null;
  for (const line of fn.split('\n')) {
    if (/\$\{acct \? `/.test(line)) half = 'acct';
    else if (/\$\{money \? `/.test(line)) half = 'money';
    else if (/^\s*` : ''\}/.test(line)) half = null;
    const h = line.match(/<h3 class="mt">([^<$]+)<\/h3>/);
    if (h) halves[h[1].trim()] = half;
  }

  assert.deepEqual(halves, {
    'Account details': 'acct',
    Tier: 'acct',
    'Profile picture': 'acct',
    'Business details': 'acct',
    'Where to reach them': 'acct',
    'Remove this account': 'acct',
    'Confirm the bank payment': 'money',
    'Bank transfer proofs': 'money',
    'Issue the receipt': 'money',
    Invoices: 'money',
    History: 'acct',
    'Credit ledger': 'acct',
  }, 'the account under Customers, the money in Customer order');

  // The list is drawn once and told which half it opens.
  assert.match(app, /SCREENS\.resellers = resellerList\('money'\);/);
  assert.match(app, /SCREENS\.reselleraccounts = resellerList\('account', 1\);/);
  assert.match(app, /SCREENS\.distributoraccounts = resellerList\('account', 2\);/);
  assert.match(app, /SCREENS\.retaileraccounts = resellerList\('account', 3\);/);
  assert.match(app, /openReseller\(\+b\.dataset\.open, load, part\)/,
    'the row opens the half its screen is for');
});

test('which panel is open survives a redraw', () => {
  assert.match(app, /let orderPanel = 'chatorders';/,
    'the open panel is kept outside the screen function');
  const at = app.indexOf('SCREENS.customerorder = async');
  const screen = app.slice(at, app.indexOf('\n};', at));
  assert.match(screen, /orderPanel = b\.dataset\.panel/,
    'clicking a tab records which one, so raising an invoice does not bounce '
    + 'somebody back to the first tab');
});

test('the pending list is what is waiting, not everything ever ordered', () => {
  const at = app.indexOf('SCREENS.pendingorders = async');
  assert.ok(at > 0, 'there is a Pending customer order screen');
  const screen = app.slice(at, app.indexOf('\n};', at));

  assert.match(screen, /o\.status === 'placed' \|\| o\.status === 'picking'/,
    'a delivered order drops off the list by itself');
  assert.match(screen, /data-open="\$\{o\.id\}"/, 'every row opens');
});

// Invoice and packing-list numbers moved off this row — they are one Open
// away, on the order itself, and are not why somebody opens this list.
test('the pending row is the number, when it was placed, who it is for, and what it is worth', () => {
  const at = app.indexOf('SCREENS.pendingorders = async');
  const screen = app.slice(at, app.indexOf('\n};', at));

  const heads = [...screen.matchAll(/head: '([^']*)'/g)].map((m) => m[1]);
  assert.deepEqual(heads, ['Customer order', 'Placed', 'Reseller', 'Stage', 'Total', ''],
    'in the order the owner asked for');
  assert.ok(screen.includes('o.co_no'), 'the customer order number is what a reseller quotes');
  for (const gone of ['si_no', 'pl_no']) {
    assert.ok(!screen.includes(`o.${gone}`),
      `${gone} is a panel away now, not a column of this list`);
  }
});

// A row sitting on Pending for more than two days is not wrong, only stalled
// — the Draft button next to Placed is the way it is set aside, and it only
// shows once it has actually been sitting that long.
test('a stale row offers Draft; a fresh one does not', () => {
  const at = app.indexOf('SCREENS.pendingorders = async');
  const screen = app.slice(at, app.indexOf('\n};', at));
  assert.match(screen, /PENDING_STALE_MS/, 'the two-day threshold is named, not a bare number');
  assert.match(screen, /data-park="\$\{o\.id\}"/, 'the button parks this row');
  assert.match(screen, /!o\.parked_at/, 'a parked order drops off Pending by itself');
});

test('Draft is its own tab, and Restore is the only way back', () => {
  const at = app.indexOf('SCREENS.draftorders = async');
  assert.ok(at > 0, 'there is a Draft screen');
  const screen = app.slice(at, app.indexOf('\n};', at));
  assert.match(screen, /o\.parked_at/, 'Draft shows only what was set aside');
  assert.match(screen, /data-restore="\$\{o\.id\}"/, 'and can be brought back');
  assert.match(screen, /\/unpark/, 'by clearing the very thing that put it here');
});

// One row per invoice, not one row per reseller — that account-level list
// stays exactly where it was, resellerList('money'), untouched and unbranched.
test('the Invoice tab is its own screen, eight columns, built apart from the reseller account list', () => {
  const at = app.indexOf('SCREENS.coinvoices = async');
  assert.ok(at > 0, 'there is an Invoice screen of its own');
  const screen = app.slice(at, app.indexOf('\n};', at));

  const heads = [...screen.matchAll(/head: '([^']*)'/g)].map((m) => m[1]);
  assert.deepEqual(heads, ['Customer order no.', 'Invoice no.', 'Reseller', 'Tier',
    'Issued', 'Standing', 'Amount', 'Bal', ''], 'in the order the owner asked for');

  assert.doesNotMatch(screen, /resellerList/,
    'built fresh rather than branched off the shared account list');

  for (const btn of [/data-invpay=/, /data-invbill=/, /data-invco=/]) {
    assert.match(screen, btn, `${btn} is one of the row's three buttons`);
  }
});

test('the three invoice-row buttons do their own three things', () => {
  const at = app.indexOf('SCREENS.coinvoices = async');
  const screen = app.slice(at, app.indexOf('\n};', at));

  assert.match(screen, /recordInvoicePayment\(/, 'Record payment opens its own form');
  assert.match(screen, /showInvoiceDoc\(/, 'Billing statement prints the invoice');
  assert.match(screen, /openOrder\(b\.dataset\.invco, load\)/, 'Customer order opens the order');

  // Record payment only where there is something to pay — a paid or void
  // invoice has nothing to record against.
  assert.match(screen, /o\.invoice_status === 'open' \? `<button/,
    'the button is there only while the invoice is still open');
});

test('Record payment is its own duplicated form, not the reseller account\'s or a bill\'s', () => {
  const at = app.indexOf('async function recordInvoicePayment');
  assert.ok(at > 0, 'there is a payment form of its own');
  const fn = app.slice(at, app.indexOf('\n}\n', at));
  assert.match(fn, /\/api\/invoices\/\$\{invoiceId\}\/payments/,
    'it posts to the same invoice-payments endpoint the account dialog uses');
  assert.doesNotMatch(fn, /openReseller|\br\.name\b/,
    'built apart from the reseller dialog, not a branch of it');
  assert.doesNotMatch(fn, /purchase-order-bill/,
    'built apart from the bill payment form too, not a branch of it');

  // Same shape as the Purchase order Billing statement's own dialog: what
  // has already landed, five rows to record more, and a promise of what
  // hasn't landed yet.
  assert.match(fn, /Payments on file/);
  assert.match(fn, /class="ci_file" type="file"/, 'each row can carry a proof photo');
  assert.match(fn, /Pending payment/);
  assert.match(fn, /\/api\/invoices\/\$\{invoiceId\}\/pending-payments/,
    'the promise is this invoice\'s own, not a purchase order bill\'s');
});

test('the packing list screen leads with its own number, not a database id', () => {
  const at = app.indexOf('SCREENS.orders = async');
  const screen = app.slice(at, app.indexOf('\n};', at));
  assert.match(screen, /head: 'Packing list', cell: \(o\) => `<b>\$\{esc\(o\.pl_no/,
    'the bench is holding a sheet with PL26_08_004 on it, not #41');
});

test('the panel tabs are plainly subordinate to the menu', () => {
  assert.match(css, /\.subtabs\s*\{/, 'the panel tabs are styled');
  const block = css.slice(css.indexOf('.subtabs {'), css.indexOf('.subtabs {') + 900);
  assert.match(block, /font-size:\s*\.8\d+rem/,
    'a size down from the menu, so the eye reads the column on the left first');
  assert.match(block, /border-bottom/,
    'an underline for the open one rather than a tinted bar of its own');
});

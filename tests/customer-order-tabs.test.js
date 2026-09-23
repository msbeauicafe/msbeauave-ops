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
  assert.deepEqual(panels, ['chatorders', 'draftorders', 'pendingorders', 'coinvoices', 'copacking'],
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

// Draft sits beside Open, but only on a row still awaiting payment — an
// order already Committed or further along is not somebody's to set aside
// unfinished any more. The stale flag names the actual day count now, not
// a flat "2+ days" that read the same at day 2 and day 9.
test('Draft only offers on a row still awaiting payment; the stale tag names the day', () => {
  const before = app.slice(0, app.indexOf('SCREENS.pendingorders = async'));
  assert.match(before, /const pendingAwaitingPayment = \(o\) =>/,
    "Pending customer order's own check, not a branch of the shared orderTag");
  assert.match(before, /o\.status === 'placed' && o\.tier === 1 && o\.invoice_status === 'open'/,
    'the same reading "Awaiting payment" is drawn from, kept in step by hand');

  const at = app.indexOf('SCREENS.pendingorders = async');
  const screen = app.slice(at, app.indexOf('\n};', at));
  assert.match(screen, /PENDING_STALE_MS/, 'the two-day threshold is still named, not a bare number');
  assert.doesNotMatch(screen, /tag\('2\+ days', 'amber'\)/,
    'the flat "2+ days" wording is gone');
  assert.match(screen, /tag\(`\$\{count\(days\)\} days`, 'amber'\)/,
    'a row past the threshold says how many days, not just that it is stale');
  assert.match(screen, /data-open="\$\{o\.id\}"[\s\S]{0,120}pendingAwaitingPayment\(o\)[\s\S]{0,80}data-park="\$\{o\.id\}"/,
    'Draft sits beside Open, but only for a row awaiting payment');
  assert.match(screen, /!o\.parked_at/, 'a parked order drops off Pending by itself');
});

// Pending customer order's own Invoice button commits an order — it can say
// Committed from then on even while orderTag, reading payment alone, would
// still call a tier-1 order Awaiting payment. Every other screen that shows
// a stage still calls orderTag straight, unmoved by anything in this file.
test("Pending customer order's own Stage tells Committed once Invoice has been pushed", () => {
  const before = app.slice(0, app.indexOf('SCREENS.pendingorders = async'));
  assert.match(before, /const pendingStageTag = \(o\) => \{/,
    "its own reading of Stage, not a branch of the shared orderTag");
  assert.match(before, /if \(!o\.committed_at && o\.status === 'placed' && o\.tier === 1[\s\S]{0,40}\)/,
    'Awaiting payment only holds while nothing has committed the order yet');
  assert.match(before, /placed: tag\('Committed', 'pink'\)/,
    'falling through to Committed the same way orderTag does for every other placed order');

  const at = app.indexOf('SCREENS.pendingorders = async');
  const screen = app.slice(at, app.indexOf('\n};', at));
  assert.match(screen, /head: 'Stage', cell: \(o\) => pendingStageTag\(o\)/,
    'the Stage column reads its own tag, not the shared one');
  assert.doesNotMatch(screen, /cell: \(o\) => orderTag\(o\)/,
    'orderTag itself is not called from this screen any more');

  // orderTag is untouched — every other screen that shows a stage still
  // reads payment status straight.
  const shared = app.slice(app.indexOf('function orderTag'), app.indexOf('function table('));
  assert.doesNotMatch(shared, /committed_at/,
    'the shared tag does not know about committed_at at all');
});

test('Draft is its own tab, and Restore is the only way back', () => {
  const at = app.indexOf('SCREENS.draftorders = async');
  assert.ok(at > 0, 'there is a Draft screen');
  const screen = app.slice(at, app.indexOf('\n};', at));
  assert.match(screen, /o\.parked_at/, 'Draft shows only what was set aside');
  assert.match(screen, /data-restore="\$\{o\.id\}"/, 'and can be brought back');
  assert.match(screen, /\/unpark/, 'by clearing the very thing that put it here');
});

// Chat order's own saved baskets are a different kind of draft — never
// placed at all, rather than placed and set aside — but they sit on the
// same list, since that is what was actually asked for: see those people
// here. Its own read of order_drafts either way, not a share of Chat
// order's own Drafts dialog.
test('Draft also lists what Chat order has saved, without reaching into it', () => {
  const at = app.indexOf('SCREENS.draftorders = async');
  const screen = app.slice(at, app.indexOf('\n};', at));

  assert.match(screen, /GET\('\/api\/order-drafts'\)/, 'its own fetch of the same data');
  assert.match(screen, /\[\.\.\.parked, \.\.\.chatDrafts\]/, 'the two kinds sit on one list');
  assert.match(screen, /data-dropchat="\$\{o\.id\}"/, 'its own Discard button');
  assert.match(screen, /DELETE\(`\/api\/order-drafts\/\$\{b\.dataset\.dropchat\}`\)/,
    'and its own delete call');
  assert.doesNotMatch(screen, /openDraftsList|reopenDraft/,
    'Chat order\'s own dialog and basket-reopening logic are untouched');
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
  assert.match(screen, /showInvoiceBillingStatement\(/, 'Billing statement prints the yellow ledger, not the blue invoice');
  assert.doesNotMatch(screen, /showInvoiceDoc\(/, 'not the blue INVOICE document');
  assert.match(screen, /openOrder\(b\.dataset\.invco, load\)/, 'Customer order opens the order');

  // Record payment shows on every row, paid or void included — the owner
  // asked for it there regardless, not only while something is still owed.
  assert.doesNotMatch(screen, /invoice_status === 'open' \? `<button/,
    'the button no longer waits on the invoice still being open');
  assert.match(screen, /data-invpay="\$\{o\.invoice_id\}"/,
    'and is on the row unconditionally');
});

// The same bones as the yellow sheet (.doc.po) a purchase order bill
// prints, in blue instead — its own colour class, not the shared orange,
// and built fresh rather than calling Purchase order's own function: the
// bill's version bills MS Beau Ave; this one bills the reseller, so
// BILLED TO has to read the other way round.
test('the billing statement is its own function, blue, billing the reseller not MS Beau Ave', () => {
  const at = app.indexOf('function showInvoiceBillingStatement');
  assert.ok(at > 0, 'there is a billing statement of its own for the Invoice tab');
  const fn = app.slice(at, app.indexOf('\n}\n', at));

  assert.match(fn, /doc po invoice-doc civbill/, 'the same sheet bones, its own colour class');
  assert.doesNotMatch(fn, /billInvoiceDoc\(|showBillInvoice\(/,
    'Purchase order\'s own billing-statement function is not called from here');
  assert.match(fn, /BILLED TO/, 'billed to');
  assert.match(fn, /field\('RESELLER:', order\.reseller\)/,
    'the reseller is who is billed, not MS Beau Ave');
  assert.doesNotMatch(fn, /MS BEAU AVE/, 'MS Beau Ave is not printed as the one being billed');
});

test('civbill is blue, not the shared orange, and does not touch the purchase order colours', () => {
  const at = css.indexOf('.doc.po.civbill');
  assert.ok(at > 0, 'the Invoice tab\'s billing statement has its own colour rules');
  const block = css.slice(at, css.indexOf('\n\n', at));
  assert.match(block, /#2f5fa8/, 'blue, the same shade the INVOICE title already uses');
  assert.doesNotMatch(block, /#f5a623|#2e7d4f/,
    'not the orange purchase-order colour, and not the green receiving-form one either');

  const rfBlock = css.slice(css.indexOf('.doc.po.rf'), css.indexOf('.doc.po.civbill'));
  assert.doesNotMatch(rfBlock, /#2f5fa8/,
    'the receiving form\'s own green rules are untouched by this addition');
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

// One reseller's invoices land wherever their own dates put them on the
// main list, next to nobody else's — this is where they are gathered.
test('Record payment shows the whole account\'s invoice log, below Pending payment', () => {
  const at = app.indexOf('async function recordInvoicePayment');
  const fn = app.slice(at, app.indexOf('\n}\n', at));

  assert.match(fn, /Invoice log/);
  assert.match(fn, /GET\(`\/api\/resellers\/\$\{resellerId\}`\)/,
    'the whole account, not just this one invoice');

  const pendingAt = fn.indexOf('Pending payment');
  const logAt = fn.indexOf('Invoice log');
  assert.ok(pendingAt > 0 && logAt > pendingAt, 'the log sits below Pending payment');
});

// The account's invoices, added up, so the total is read here rather than
// worked out by hand off the rows above.
test('the invoice log totals its own Amount and Bal columns', () => {
  const at = app.indexOf('async function recordInvoicePayment');
  const fn = app.slice(at, app.indexOf('\n}\n', at));
  const logAt = fn.indexOf('const paintLog');
  const log = fn.slice(logAt, fn.indexOf('await paintLog();', logAt));

  assert.match(log, /reduce\(\(s, i\) => s \+ Number\(i\[f\]/, 'the rows are added up');
  assert.match(log, /sum\('amount'\)/, 'the Amount column is summed');
  assert.match(log, /sum\('balance'\)/, 'the Bal column is summed too');

  assert.match(fn, /id="ci_accttotal"/,
    'the account-wide total is the one figure at the top of the dialog');
  assert.doesNotMatch(fn, /id="ci_owed"/,
    'this one invoice\'s own balance is not what heads the dialog');
  assert.match(log, /totalBox\.textContent = acct\.invoices\.length \? peso\(sum\('amount'\)\) : ''/,
    'just the figure, bold and big — no other words in the header');
});

// The button is a door, not a shortcut — it lands on the tab where the
// order already sits and leaves opening it to whoever gets there. But
// Packing list only shows what is paid, so a payment typed into the form
// and left unsaved would make the order look like it never happened —
// the button saves that on the way out rather than stranding it.
test('Record payment has a Packing list button beside Done, and it saves on the way out', () => {
  const at = app.indexOf('async function recordInvoicePayment');
  const fn = app.slice(at, app.indexOf('\n}\n', at));

  const doneAt = fn.indexOf('id="ci_done"');
  const packAt = fn.indexOf('id="ci_pack"');
  assert.ok(doneAt > 0 && packAt > 0 && Math.abs(packAt - doneAt) < 120,
    'Packing list sits right beside Done, not off elsewhere in the dialog');

  const packHandler = fn.slice(fn.indexOf("$('#ci_pack').addEventListener"));
  assert.match(packHandler, /await save\(\);/,
    'a payment left filled in the form is saved before leaving');
  assert.match(packHandler, /\$\('\[data-panel="copacking"\]'\)\?\.click\(\)/,
    'clicking it switches to the Packing list tab');
  assert.doesNotMatch(fn, /showPackingList\(/,
    'it does not open the document itself — that is opened by hand from the tab');
});

test('the packing list screen leads with its own number, not a database id', () => {
  const at = app.indexOf('SCREENS.copacking = async');
  const screen = app.slice(at, app.indexOf('\n};', at));
  assert.match(screen, /head: 'Packing list', cell: \(o\) => `<b>\$\{esc\(o\.pl_no/,
    'the bench is holding a sheet with PL26_08_004 on it, not #41');
});

// The tab shows only what has cleared payment. The warehouse's own Pick &
// send, and the observer's Wholesale, still need every committed order
// whether or not it is paid — so this is its own screen, not a filter bolted
// onto the shared one, the same lesson PRs #531-535 already paid for once.
test('the tab is its own screen, paid orders only — the shared board stays untouched', () => {
  const at = app.indexOf('SCREENS.copacking = async');
  const screen = app.slice(at, app.indexOf('\n};', at));
  assert.match(screen, /\.filter\(\(o\) => o\.invoice_status === 'paid'\)/,
    'only invoices marked fully paid show here');
  assert.doesNotMatch(screen, /user\.role === 'warehouse'/,
    'this copy never speaks for Pick & send — it does not know that heading exists');

  const shared = app.slice(app.indexOf('SCREENS.orders = async'),
                            app.indexOf('/**\n * One order, opened.'));
  assert.doesNotMatch(shared, /\.filter\(\(o\) => o\.invoice_status === 'paid'\)/,
    'Pick & send and Wholesale still show every committed order, paid or not');
});

test('the panel tabs are plainly subordinate to the menu', () => {
  assert.match(css, /\.subtabs\s*\{/, 'the panel tabs are styled');
  const block = css.slice(css.indexOf('.subtabs {'), css.indexOf('.subtabs {') + 900);
  assert.match(block, /font-size:\s*\.8\d+rem/,
    'a size down from the menu, so the eye reads the column on the left first');
  assert.match(block, /border-bottom/,
    'an underline for the open one rather than a tinted bar of its own');
});

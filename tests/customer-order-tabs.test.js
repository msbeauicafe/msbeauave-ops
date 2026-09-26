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

// Used to read "a delivered order drops off the list by itself" — the owner
// reversed that: a dispatched row now stays right here too, Stage reading
// Completed (see the pendingStageTag tests above), so this only checks what
// still never belongs: a cancelled order, which still leaves.
test('the pending list keeps a dispatched row, but not a cancelled one', () => {
  const at = app.indexOf('SCREENS.pendingorders = async');
  assert.ok(at > 0, 'there is a Pending customer order screen');
  const screen = app.slice(at, app.indexOf('\n};', at));

  assert.match(screen, /\['placed', 'picking', 'fulfilled'\]\.includes\(o\.status\)/,
    'a dispatched order stays, not just placed or picking');
  assert.doesNotMatch(screen, /'cancelled'/,
    'a cancelled order is still not one of the statuses kept');
  assert.match(screen, /data-open="\$\{o\.id\}"/, 'every row opens');
});

// Which resellers also have a given product on a waiting order — its own
// search against its own endpoint, placed right after the header the owner
// pointed at, not a filter borrowed from anywhere else on the list.
test('a product search sits after the header and finds it through its own endpoint', () => {
  const at = app.indexOf('SCREENS.pendingorders = async');
  const screen = app.slice(at, app.indexOf('\n};', at));

  const headEnd = screen.indexOf('id="pending_count"></span></div>');
  const inputAt = screen.indexOf('id="pending_product"');
  assert.ok(headEnd > 0 && inputAt > headEnd, 'the search box comes after the header block');

  assert.match(screen, /GET\(`\/api\/pending-orders\/by-product\?q=\$\{encodeURIComponent\(term\)\}`\)/,
    'its own dedicated endpoint, not a new filter on the shared /api/orders list');
  assert.match(screen, /matchedIds = new Set\(ids\.map\(String\)\)/,
    'ids kept as strings, the way a bigint id already arrives off Postgres');
  assert.match(screen, /rows\.filter\(\(o\) => matchedIds\.has\(String\(o\.id\)\)\)/,
    'the table itself narrows to what matched');
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
});

// A pressed Draft used to take the row off this list entirely, onto Draft
// tab and nowhere else — the owner asked for the opposite: the row stays
// right here, Stage reads Draft in place, and it also still shows on Draft
// tab exactly as it did before. Nothing about that tab's own copy changes.
test('a marked Draft row stays on Pending customer order, Stage reading Draft', () => {
  const before = app.slice(0, app.indexOf('SCREENS.pendingorders = async'));
  assert.match(before, /&& !o\.parked_at;/,
    'once marked, the button itself stops offering — one press is what it takes');
  assert.match(before, /if \(o\.parked_at\) return tag\('Draft', 'grey'\);/,
    "Stage reads Draft ahead of Committed or Awaiting payment, Pending customer order's own reading");

  const at = app.indexOf('SCREENS.pendingorders = async');
  const screen = app.slice(at, app.indexOf('\n};', at));
  assert.doesNotMatch(screen, /!o\.parked_at/,
    'the list itself no longer drops a parked row — only the button\'s own check does that now');
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

// A committed order does not fall back to reading Picking off raw status —
// the warehouse can start picking the same order on Pick & send without this
// screen's own Stage moving off Committed. Scoped to pendingStageTag alone;
// packingStageTag and orderTag keep reading their own screens' rules.
test("Pending customer order's own Stage stays Committed even once picking has started elsewhere", () => {
  const at = app.indexOf('const pendingStageTag = (o) => {');
  const fn = app.slice(at, app.indexOf('\n};', at));
  assert.match(fn, /if \(o\.committed_at && \['placed', 'picking'\]\.includes\(o\.status\)\) return tag\('Committed', 'pink'\);/,
    'once committed, placed or picking both still read Committed');
});

// Dispatch used to take a row off Pending customer order entirely, onto
// Packing list and nowhere else — the owner asked for the opposite: it stays
// right here too, Stage reading Completed, and the "waiting" count above the
// table keeps meaning only what has not gone out yet. Scoped to this screen
// alone; Packing list's own board and count are untouched.
test("a dispatched order stays on Pending customer order, Stage reading Completed, without inflating the waiting count", () => {
  const stageAt = app.indexOf('const pendingStageTag = (o) => {');
  const stageFn = app.slice(stageAt, app.indexOf('\n};', stageAt));
  assert.match(stageFn, /fulfilled: tag\('Completed', 'green'\)/,
    "a fulfilled order reads Completed here, not the Dispatched other screens use");

  const at = app.indexOf('SCREENS.pendingorders = async');
  const screen = app.slice(at, app.indexOf('\n};', at));
  assert.match(screen, /\.filter\(\(o\) => \['placed', 'picking', 'fulfilled'\]\.includes\(o\.status\)\)/,
    'the list itself keeps a dispatched row rather than dropping it');
  assert.match(screen, /const waiting = rows\.filter\(\(o\) => o\.status !== 'fulfilled'\);/,
    'the count and total above the table are computed off the still-waiting rows only');
  assert.match(screen, /waiting\.length[\s\S]{0,60}count\(waiting\.length\)/,
    'the header reads off that narrower list, not every row shown below');
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
  assert.doesNotMatch(screen, /openDraftsList|reopenDraft/,
    'Chat order\'s own dialog and basket-reopening logic are untouched');
});

// A saved-but-never-placed basket had no way back to Chat order from here —
// only Discard, since removed — even though the tab's own header promises
// "Place order brings one back." reopenChatDraftId is the hand-off: Draft
// tab sets it and switches the panel, Chat order itself reads it and clears
// it, so neither screen reaches into the other's own functions to make it
// happen.
test('Draft hands a saved basket back to Chat order to place; there is no discard any more', () => {
  const before = app.slice(0, app.indexOf('SCREENS.chatorders = async'));
  assert.match(before, /let reopenChatDraftId = null;/,
    'a module-level hand-off, the same way orderPanel already is');

  const draftScreen = app.slice(app.indexOf('SCREENS.draftorders = async'),
    app.indexOf('\n};', app.indexOf('SCREENS.draftorders = async')));
  assert.match(draftScreen, /data-placechat="\$\{o\.id\}">Place order</,
    'a Place order button sits on a chat-saved row');
  assert.doesNotMatch(draftScreen, /Discard|dropchat/,
    'discarding a saved basket is no longer offered here at all');
  assert.match(draftScreen, /reopenChatDraftId = b\.dataset\.placechat/,
    'clicking it hands the draft id off');
  assert.match(draftScreen, /orderPanel = 'chatorders'/,
    'and switches the panel — Draft tab does not open Chat order\'s basket itself');
  assert.doesNotMatch(draftScreen, /reopenDraft\(/,
    'the actual reopening stays inside Chat order\'s own screen');

  const chatScreen = app.slice(app.indexOf('SCREENS.chatorders = async'),
    app.indexOf('\n};', app.indexOf('SCREENS.chatorders = async')));
  assert.match(chatScreen, /if \(reopenChatDraftId\)/,
    'Chat order reads the hand-off itself rather than Draft tab pushing into it');
  assert.match(chatScreen, /reopenChatDraftId = null;/,
    'and clears it, so it only ever fires once');
  assert.match(chatScreen, /reopenDraft\(await GET\(`\/api\/order-drafts\/\$\{id\}`\)\)/,
    'reopened the same way Preview in its own Drafts dialog already does');
});

// A parked order's own Stage used to be the shared orderTag, which has no
// idea an order was set aside — it read Committed or Awaiting payment off
// status alone, straight through the park. Every row this screen loads is
// parked by definition, so Stage can just say Draft outright.
test("a parked order's own Stage says Draft, not the shared orderTag's Committed", () => {
  const draftScreen = app.slice(app.indexOf('SCREENS.draftorders = async'),
    app.indexOf('\n};', app.indexOf('SCREENS.draftorders = async')));
  assert.match(draftScreen, /o\.co_no \? tag\('Draft', 'grey'\)/,
    'Stage reads Draft outright rather than asking orderTag');
  assert.doesNotMatch(draftScreen, /orderTag\(/,
    'the shared tag is not called from this screen at all any more');
});

// wholesale_price and the RS price code are two separate figures that can
// drift apart — 146 products' worth of drift, found once the owner noticed
// this screen's own RS Price column did not match Pricelists' RS column for
// one product. The RS code is the one Pricelists means by RS, so that is what
// this screen reads now, falling back to wholesale_price only for a product
// that has never had an RS code set.
test('the RS Price column reads the RS price code, not wholesale_price', () => {
  const chatScreen = app.slice(app.indexOf('SCREENS.chatorders = async'),
    app.indexOf('\n};', app.indexOf('SCREENS.chatorders = async')));
  assert.match(chatScreen, /const rsPrice = \(p\) => Number\(p\.prices\?\.RS \?\? p\.wholesale_price\)/,
    'its own helper, falling back to wholesale_price only when a product has no RS code');
  assert.match(chatScreen, /head: 'RS Price', n: true, cell: \(p\) => peso\(rsPrice\(p\)\)/,
    'the column itself reads off it');
  assert.match(chatScreen, /price: rsPrice\(p\),\s*\n\s*listed: rsPrice\(p\),/,
    'and so does the price a freshly added line starts at');
});

// The basket's own total was real and simply never read — items and who it
// is for already showed, so a blank Total column was the odd one out.
test('a saved basket shows its own total, not a blank column', () => {
  const draftScreen = app.slice(app.indexOf('SCREENS.draftorders = async'),
    app.indexOf('\n};', app.indexOf('SCREENS.draftorders = async')));
  assert.match(draftScreen, /head: 'Total', n: true, cell: \(o\) => peso\(o\.total\)/,
    'one reading for both kinds of row now, not a dash for the chat-saved half');
});

// A saved basket has no order to open — openOrder has nothing to read — so
// Open here is its own dialog: the same customer order form on the left,
// and on the right a list of orders that mirrors Chat order's own basket
// editor, since that is what built this basket. Saving writes straight back
// onto the draft; placing it for real is still Place order's job.
test('a saved basket opens its own editable dialog, not openOrder\'s', () => {
  const before = app.slice(0, app.indexOf('SCREENS.draftorders = async'));
  assert.match(before, /async function openChatDraft\(draftId, reload\)/,
    "its own function, not openOrder — there is no real order to read");
  assert.match(before, /GET\(`\/api\/order-drafts\/\$\{draftId\}`\)/,
    'reads the one draft\'s own lines straight');
  assert.match(before, /GET\(`\/api\/resellers\/\$\{d\.reseller_id\}`\)/,
    'the account\'s own tax details are fetched too — the form has a block for them');

  const fn = before.slice(before.indexOf('async function openChatDraft'),
    before.indexOf('async function openDraftOrder'));
  assert.match(fn, /customerOrderForm\(\{/, 'the same form builder, not a share of openOrder');
  assert.match(fn, /<h3>List of orders<\/h3>/,
    'the right side reads like Chat order\'s own basket, not a plain table');
  assert.match(fn, /data-code="\$\{esc\(l\.sku\)\}"/, 'a PCODE picker on every line');
  assert.match(fn, /PUT\(`\/api\/order-drafts\/\$\{draftId\}`, \{ lines: rows \}\)/,
    'Save the changes writes straight back onto this same draft');
  assert.match(fn, /reload\?\.\(\)/,
    'and tells the Draft list to refresh once it has');
  assert.doesNotMatch(fn, /POST\(`\/api\/resellers\/.*\/orders`|\/api\/orders\/\$\{id\}\/lines/,
    'nothing here places the order for real — that stays Place order\'s job');

  const draftScreen = app.slice(app.indexOf('SCREENS.draftorders = async'),
    app.indexOf('\n};', app.indexOf('SCREENS.draftorders = async')));
  assert.match(draftScreen,
    /data-placechat="\$\{o\.id\}">Place order<\/button>\s*<button class="btn sm quiet" data-openchat="\$\{o\.id\}">Open/,
    'Open sits right after Place order, same order as the parked half of the list');
  assert.match(draftScreen, /openChatDraft\(b\.dataset\.openchat, load\)/,
    'wired to its own dialog, not openOrder, and told how to refresh the list');
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

  for (const btn of [/data-invpay=/, /data-invbill=/, /data-invco=/, /data-invdoc=/]) {
    assert.match(screen, btn, `${btn} is one of the row's four buttons`);
  }
});

test('the four invoice-row buttons do their own four things', () => {
  const at = app.indexOf('SCREENS.coinvoices = async');
  const screen = app.slice(at, app.indexOf('\n};', at));

  assert.match(screen, /recordInvoicePayment\(/, 'Record payment opens its own form');
  assert.match(screen, /showInvoiceBillingStatement\(/, 'Billing statement prints the yellow ledger, not the blue invoice');
  assert.match(screen, /openInvoiceOrder\(b\.dataset\.invco, load\)/,
    'Customer order opens Invoice tab\'s own dialog, not the shared openOrder');

  // Invoice reuses the generic showInvoiceDoc renderer — the same blue
  // INVOICE document a reseller's own account page already opens it from —
  // rather than redrawing the paper here; only the fetch that feeds it data
  // is this screen's own.
  const invdoc = screen.slice(screen.indexOf("$$('[data-invdoc]'"));
  assert.match(invdoc, /GET\(`\/api\/orders\/\$\{o\.id\}`\)/, "this screen's own fetch of the order");
  assert.match(invdoc, /GET\(`\/api\/resellers\/\$\{o\.reseller_id\}\/payments\?order_id=\$\{o\.id\}`\)/,
    'and of the payments made against it, so they show in the form\'s own Payment Details');
  assert.match(invdoc, /showInvoiceDoc\(\{/, 'the shared renderer, reused rather than redrawn');

  // Record payment shows on every row, paid or void included — the owner
  // asked for it there regardless, not only while something is still owed.
  assert.doesNotMatch(screen, /invoice_status === 'open' \? `<button/,
    'the button no longer waits on the invoice still being open');
  assert.match(screen, /data-invpay="\$\{o\.invoice_id\}"/,
    'and is on the row unconditionally');
});

// Invoice tab's own dialog, not a branch of the shared openOrder — correcting
// the CO/PL/SI series was never something Invoice tab should offer at all.
test('Invoice tab\'s Customer order dialog has no numbers-on-the-paperwork panel', () => {
  const before = app.slice(0, app.indexOf('SCREENS.coinvoices = async'));
  assert.match(before, /async function openInvoiceOrder\(id, reload\)/,
    'its own function, not openOrder');
  const fn = before.slice(before.indexOf('async function openInvoiceOrder'));
  assert.match(fn, /customerOrderForm\(\{/, 'the same form builder, not a share of openOrder');
  assert.doesNotMatch(fn, /The numbers on the paperwork/,
    'the panel the owner asked removed from this screen');
  assert.doesNotMatch(fn, /on_keep|on_co|on_pl|on_si/,
    'and none of its wiring left behind either');

  // The shared dialog itself is untouched — Packing list's own read-only
  // Open still reads it, panel and all, even though Draft no longer does.
  const openOrderFn = app.slice(app.indexOf('async function openOrder'),
    app.indexOf('async function openInvoiceOrder'));
  assert.match(openOrderFn, /The numbers on the paperwork/,
    'openOrder itself is left exactly as it was');
});

// Draft is a pending order set aside, not one Warehouse is picking — it now
// opens the same shaped dialog Pending customer order's own Open does, not
// Packing list's read-only openOrder, and the CO/PL/SI numbers-correction
// panel goes with it, on purpose: the owner asked Draft not to keep that.
test("Draft tab's Open uses its own dialog, not Pending's and not Packing list's openOrder", () => {
  const draftScreen = app.slice(app.indexOf('SCREENS.draftorders = async'),
    app.indexOf('\n};', app.indexOf('SCREENS.draftorders = async')));
  assert.match(draftScreen, /openDraftOrder\(b\.dataset\.open, load, page\)/,
    "wired to its own dialog");
  assert.doesNotMatch(draftScreen, /openOrder\(b\.dataset\.open, load\)/,
    'not the shared read-only one Packing list uses');

  // Packing list's and Pick & send's own read-only Opens are untouched.
  const packingScreen = app.slice(app.indexOf('SCREENS.copacking = async'),
    app.indexOf('SCREENS.orders = async'));
  assert.match(packingScreen, /openOrder\(b\.dataset\.open, load, \{ readOnly: true \}\)/,
    "Packing list's own read-only Open, unchanged");
  const wholesaleScreen = app.slice(app.indexOf('SCREENS.orders = async'),
    app.indexOf('async function openPendingOrder'));
  assert.match(wholesaleScreen, /openOrder\(b\.dataset\.open, load, \{ readOnly: true \}\)/,
    "Pick & send's own read-only Open, unchanged");
});

// The Invoice button pushes an order along to Invoice tab and marks it
// Committed — not something a Draft order, set aside on purpose, is ready
// for. Removed from Draft's own copy only; Pending customer order's own
// dialog, and the button on it, are untouched.
test("Draft's own dialog has no Invoice button; Pending customer order's still does", () => {
  const draftFn = app.slice(app.indexOf('async function openDraftOrder'),
    app.indexOf('SCREENS.draftorders = async'));
  assert.doesNotMatch(draftFn, /id="pl_invoice"/, 'no Invoice button on Draft\'s own dialog');
  assert.doesNotMatch(draftFn, /pl_invoice.*addEventListener|orderPanel = 'coinvoices'/s,
    'and none of its wiring left behind either');
  assert.match(draftFn, /id="pl_place"/, 'Save the changes is still there');
  assert.match(draftFn, /id="pl_cancel"/, 'and Cancel');

  const pendingFn = app.slice(app.indexOf('async function openPendingOrder'),
    app.indexOf('async function openOrder'));
  assert.match(pendingFn, /id="pl_invoice"/,
    "Pending customer order's own Invoice button, untouched");
  assert.match(pendingFn, /orderPanel = 'coinvoices'/,
    'and its wiring, untouched');
});

// Every b2b order gets an invoice row the moment it is placed — bookkeeping,
// not the office invoicing anybody. A tier-1 order still reading Awaiting
// payment on Pending customer order has not been committed yet and has no
// business showing up here until it is.
test('a tier-1 order still Awaiting payment does not show on the Invoice tab', () => {
  const at = app.indexOf('SCREENS.coinvoices = async');
  const screen = app.slice(at, app.indexOf('\n};', at));

  assert.match(screen, /const notYetCommitted = \(o\) => !o\.committed_at/,
    "the Invoice tab's own check, not a branch of Pending's pendingAwaitingPayment");
  assert.match(screen,
    /o\.status === 'placed' && o\.tier === 1 && o\.invoice_status === 'open'/,
    'the same reading "Awaiting payment" is drawn from, kept in step by hand');
  assert.match(screen, /\.filter\(\(o\) => o\.invoice_id && !notYetCommitted\(o\)\)/,
    'a row needs an invoice and to no longer be Awaiting payment');
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

// The bench reads Picking as still Committed — Pick & send is where that
// stage is tracked; this tab only answers whether it has cleared to be
// packed for. orderTag itself keeps showing Picking, untouched, for every
// screen that still needs it.
test("the packing list's own Stage reads Picking as Committed, not its own stage", () => {
  const before = app.slice(0, app.indexOf('SCREENS.copacking = async'));
  assert.match(before, /const packingStageTag = \(o\) => \{/,
    "this tab's own reading of Stage, not a branch of the shared orderTag");
  assert.match(before, /picking: tag\('Committed', 'pink'\),/,
    'Picking and Committed read identically here');

  const at = app.indexOf('SCREENS.copacking = async');
  const screen = app.slice(at, app.indexOf('\n};', at));
  assert.match(screen, /head: 'Stage', cell: \(o\) => packingStageTag\(o\)/,
    'the Stage column reads its own tag, not the shared one');
  assert.doesNotMatch(screen, /cell: \(o\) => orderTag\(o\)/,
    'orderTag itself is not called from this screen any more');

  const shared = app.slice(app.indexOf('function orderTag'), app.indexOf('function table('));
  assert.match(shared, /picking: tag\('Picking', 'amber'\),/,
    'the shared tag still shows Picking for Pick & send and everywhere else');
});

test('the panel tabs are plainly subordinate to the menu', () => {
  assert.match(css, /\.subtabs\s*\{/, 'the panel tabs are styled');
  const block = css.slice(css.indexOf('.subtabs {'), css.indexOf('.subtabs {') + 900);
  assert.match(block, /font-size:\s*\.8\d+rem/,
    'a size down from the menu, so the eye reads the column on the left first');
  assert.match(block, /border-bottom/,
    'an underline for the open one rather than a tinted bar of its own');
});

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
  assert.match(app, /let customerPanel = localStorage\.getItem\('customerPanel'\) \|\| 'reselleraccounts';/,
    'which panel is open is kept outside the screen function, and now survives a hard refresh too');

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
  assert.match(app, /let orderPanel = localStorage\.getItem\('orderPanel'\) \|\| 'chatorders';/,
    'the open panel is kept outside the screen function, and now survives a hard refresh too');
  const at = app.indexOf('SCREENS.customerorder = async');
  const screen = app.slice(at, app.indexOf('\n};', at));
  assert.match(screen, /orderPanel = b\.dataset\.panel/,
    'clicking a tab records which one, so raising an invoice does not bounce '
    + 'somebody back to the first tab');
  assert.match(screen, /localStorage\.setItem\('orderPanel', orderPanel\)/,
    'and every render saves the resolved panel, not only a click on it, so an '
    + 'Invoice button switching the panel programmatically survives a refresh too');
});

// A hard refresh used to land everybody back on Dashboard, whatever screen or
// panel they were actually on — the tab and panel variables were only ever
// kept in memory. The same localStorage convention branchPicker already uses
// now remembers the top-level tab and the three screens with their own
// sub-panels, the same way across all four.
test('a hard refresh remembers the tab and panel that were open, not just a redraw', () => {
  assert.match(app, /let tab = localStorage\.getItem\('tab'\) \|\| null;/,
    'the top-level tab is seeded from what was last saved');
  const at = app.indexOf('function drawFrame');
  const fn = app.slice(at, app.indexOf('\n}', at));
  assert.match(fn, /localStorage\.setItem\('tab', tab\)/,
    'every draw saves the resolved tab, covering both a click and the '
    + 'role-mismatch fallback alike');

  assert.match(app, /let inventoryPanel = localStorage\.getItem\('inventoryPanel'\) \|\| 'stockin';/,
    "Internal Inventory Report's own panel is seeded the same way");
  const invAt = app.indexOf('SCREENS.inventory = async');
  const invScreen = app.slice(invAt, app.indexOf('const box = $', invAt));
  assert.match(invScreen, /localStorage\.setItem\('inventoryPanel', inventoryPanel\)/,
    'and saved on every render');
});

// Used to read "a delivered order drops off the list by itself" — the owner
// reversed that: a dispatched row now stays right here too, Stage reading
// Completed. Pressing Cancel inside the order dialog used to take the row
// off this list the same moment it was pressed — the owner reversed that
// too: it stays, Stage reading Cancelled, the press itself still visible
// rather than the row quietly vanishing.
test('the pending list keeps a dispatched row, and a cancelled one too', () => {
  const at = app.indexOf('SCREENS.pendingorders = async');
  assert.ok(at > 0, 'there is a Pending customer order screen');
  const screen = app.slice(at, app.indexOf('\n};', at));

  assert.match(screen, /\['placed', 'picking', 'fulfilled', 'cancelled'\]\.includes\(o\.status\)/,
    'a dispatched or cancelled order stays, not just placed or picking');
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
  assert.match(before, /!o\.committed_at && o\.status === 'placed' && !o\.parked_at;/,
    'every tier waits the same way now — not gated to tier 1 the way the shared orderTag still is');

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
// Committed from then on even while orderTag, reading payment alone and still
// gated to tier 1, would call a tier-2 or tier-3 order Committed already.
// Every other screen that shows a stage still calls orderTag straight,
// unmoved by anything in this file.
test("Pending customer order's own Stage tells Committed once Invoice has been pushed", () => {
  const before = app.slice(0, app.indexOf('SCREENS.pendingorders = async'));
  assert.match(before, /const pendingStageTag = \(o\) => \{/,
    "its own reading of Stage, not a branch of the shared orderTag");
  assert.match(before, /if \(!o\.committed_at && o\.status === 'placed'\) \{/,
    'Awaiting payment holds for every tier while nothing has committed the order yet');
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
  assert.match(screen, /\.filter\(\(o\) => \['placed', 'picking', 'fulfilled', 'cancelled'\]\.includes\(o\.status\)\)/,
    'the list itself keeps a dispatched or cancelled row rather than dropping it');
  assert.match(screen, /const waiting = rows\.filter\(\(o\) => !\['fulfilled', 'cancelled'\]\.includes\(o\.status\)\);/,
    'the count and total above the table are computed off the still-waiting rows only');
  assert.match(screen, /waiting\.length[\s\S]{0,60}count\(waiting\.length\)/,
    'the header reads off that narrower list, not every row shown below');
});

// A cancelled purchase order already says why it was called off — Pending
// customer order's own Cancelled tag now does too, read off this screen's
// own reason rather than anything shared.
test("Pending customer order's own Cancelled tag shows the reason, when there is one", () => {
  const stageAt = app.indexOf('const pendingStageTag = (o) => {');
  const stageFn = app.slice(stageAt, app.indexOf('\n};', stageAt));
  assert.match(stageFn, /if \(o\.status === 'cancelled'\) \{/,
    'cancelled is its own branch, not folded into the object literal any more');
  assert.match(stageFn, /o\.cancel_reason[\s\S]{0,80}esc\(o\.cancel_reason\)/,
    'the reason is shown, escaped, when the order has one');
  assert.doesNotMatch(stageFn, /cancelled: tag\('Cancelled'/,
    'no longer the bare object-literal branch it used to be');

  // orderTag, used everywhere else a stage shows, knows nothing about a
  // cancel reason at all.
  const shared = app.slice(app.indexOf('function orderTag'), app.indexOf('function table('));
  assert.doesNotMatch(shared, /cancel_reason/, 'the shared tag is untouched');
});

// Cancelling here asks why, the same as a purchase order already does — its
// own copy of that prompt, scoped to this screen's own Cancel button.
// cancel_order itself is unchanged, and so is Draft's own copy of this same
// dialog: Draft was never asked for this, so it keeps cancelling silently.
test("Pending customer order's own Cancel asks why; Draft's identical button still does not", () => {
  const pendingFn = app.slice(app.indexOf('async function openPendingOrder'),
    app.indexOf('async function openOrder'));
  const pendingCancel = pendingFn.slice(pendingFn.indexOf("$('#pl_cancel')"));
  assert.match(pendingCancel, /const reason = prompt\('Why is this order being cancelled\?'\);/,
    'asks why, the same wording the purchase order prompt already uses');
  assert.match(pendingCancel, /if \(!reason\) return;/, 'no reason, no cancel — same as purchase order');
  assert.match(pendingCancel, /await POST\(`\/api\/orders\/\$\{id\}\/cancel-reason`, \{ reason \}\);/,
    'the reason is recorded against the order once it is cancelled');

  const draftFn = app.slice(app.indexOf('async function openDraftOrder'),
    app.indexOf('SCREENS.draftorders = async'));
  const draftCancel = draftFn.slice(draftFn.indexOf("$('#pl_cancel')"));
  assert.doesNotMatch(draftCancel, /prompt\(/, "Draft's own Cancel is untouched, still silent");
  assert.doesNotMatch(draftCancel, /cancel-reason/, 'and never asked to record one');
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
test('the Invoice tab is its own screen, built apart from the reseller account list', () => {
  const at = app.indexOf('SCREENS.coinvoices = async');
  assert.ok(at > 0, 'there is an Invoice screen of its own');
  const screen = app.slice(at, app.indexOf('\n};', at));

  const heads = [...screen.matchAll(/head: '([^']*)'/g)].map((m) => m[1]);
  assert.deepEqual(heads, ['Customer order no.', 'Invoice no.', 'Reseller',
    'Invoice issued date', 'Standing', 'Amount', 'Bal', 'Packing list issued date', ''],
    'in the order the owner asked for — Tier folded under Reseller\'s own name, ' +
    'not a column of its own');
  assert.match(screen, /tierTag\(o\.tier\)/, 'the tier still shows, just under the name');

  assert.doesNotMatch(screen, /resellerList/,
    'built fresh rather than branched off the shared account list');

  for (const btn of [/data-invpay=/, /data-invbill=/, /data-invco=/, /data-invdoc=/]) {
    assert.match(screen, btn, `${btn} is one of the row's four buttons`);
  }
});

// Four states, not the old paid/open/past due/void — unpaid and paid w/bal
// split on whether anything has landed against the invoice yet. Only unpaid
// reads red once it is overdue; paid w/bal already shows money landed, so it
// stays amber.
test('Standing reads paid, unpaid, paid w/bal, or void', () => {
  const at = app.indexOf('SCREENS.coinvoices = async');
  const screen = app.slice(at, app.indexOf('\n};', at));

  assert.match(screen, /if \(o\.invoice_status === 'paid'\) return 'paid';/, 'paid stays paid');
  assert.match(screen, /if \(o\.invoice_status === 'void'\) return 'void';/, 'void stays void');
  assert.match(screen, /return balance < amount \? 'paid w\/bal' : 'unpaid';/,
    'paid w/bal once something has landed against it, unpaid while nothing has');
  assert.match(screen, /tag\(label, label === 'unpaid' && o\.invoice_overdue \? 'red' : 'amber'\)/,
    'only unpaid reads red past its due date; paid w/bal stays amber');
});

// The Standing filter picks against the same plain word standingLabel hands
// the tag — a dropdown reading its own private copy of that logic would be
// the kind of drift that quietly falls out of step with what the tag says.
test('the Standing filter and the Standing tag read off the same label', () => {
  const at = app.indexOf('SCREENS.coinvoices = async');
  const screen = app.slice(at, app.indexOf('\n};', at));

  assert.match(screen, /const standingLabel = \(o\) => \{/,
    'one function the tag and the filter both call');
  assert.match(screen, /standingLabel\(o\) === pick/,
    'the filter compares against that same label, not a copy of the branches');

  const options = [...screen.matchAll(/<option value="([^"]*)">/g)].map((m) => m[1]);
  assert.deepEqual(options, ['', 'paid', 'paid w/bal', 'unpaid', 'void'],
    'All, then the same four words the tag itself can read');
});

// Search and Standing sit above the table, scoped to this screen alone — no
// server round trip on every keystroke, since the full list is already in
// hand from the last load.
test('the Invoice tab has a reseller search and a Standing pick, filtering client-side', () => {
  const at = app.indexOf('SCREENS.coinvoices = async');
  const screen = app.slice(at, app.indexOf('\n};', at));

  assert.match(screen, /id="coinv_search"/, 'the search box');
  assert.match(screen, /id="coinv_standing_pick"/, 'the standing dropdown');
  assert.match(screen,
    /o\.reseller \|\| ''\)\.toLowerCase\(\)\.includes\(search\)/,
    'filters by reseller name');
  assert.match(screen, /\$\('#coinv_search', page\)\.addEventListener\('input', draw\)/,
    'search redraws on every keystroke');
  assert.match(screen, /\$\('#coinv_standing_pick', page\)\.addEventListener\('change', draw\)/,
    'and the pick redraws the moment it changes');
  assert.match(screen, /const draw = \(\) => \{/, 'a redraw that only re-filters allRows');
  assert.match(screen, /allRows = \(await GET\('\/api\/orders\?status='\)\)/,
    'only load itself asks the server, once');
});

// Pressing Invoice again can move a number on its own, independent of when
// the order was placed — so the newest invoice is the one with the newest
// number, not necessarily the one placed most recently.
test('the Invoice tab lists rows by the invoice number itself, newest first, void or not', () => {
  const at = app.indexOf('SCREENS.coinvoices = async');
  const screen = app.slice(at, app.indexOf('\n};', at));
  assert.match(screen,
    /\.sort\(\(a, b\) => \(b\.si_no \|\| ''\)\.localeCompare\(a\.si_no \|\| ''\)/,
    'descending by si_no, b before a, with no separate void grouping');
});

test('the four invoice-row buttons do their own four things', () => {
  const at = app.indexOf('SCREENS.coinvoices = async');
  const screen = app.slice(at, app.indexOf('\n};', at));

  assert.match(screen, /recordInvoicePayment\(/, 'Record payment opens its own form');
  assert.match(screen, /data-invpay="\$\{o\.invoice_id\}" data-invno="\$\{esc\(o\.si_no \|\| ''\)\}"/,
    'the button carries its own invoice number, read straight off the row');
  assert.match(screen, /data-resellername="\$\{esc\(o\.reseller \|\| ''\)\}" data-chatlink="\$\{esc\(o\.chat_link \|\| ''\)\}"/,
    'and the reseller\'s own name and chat link');
  assert.match(screen,
    /recordInvoicePayment\(b\.dataset\.invpay, b\.dataset\.invno, b\.dataset\.resellername, b\.dataset\.chatlink,/,
    'and hands all three into the dialog it opens');
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
  // DATE on the printed document reads the packing list's own issued date
  // first — the paper normally leaves the day the goods actually went out,
  // not the day the invoice number was struck — falling back to the
  // invoice's own issued date, then the order's placement date, only when
  // there's no packing list date to read. Scoped to this screen's own fetch
  // only; other showInvoiceDoc call sites elsewhere in the file are untouched.
  assert.match(invdoc,
    /issuedOn: full\.packing_list_issued_at \|\| full\.invoice_issued_on \|\| full\.placed_at/,
    "the packing list's own issued date first, then the invoice's, then placed_at");

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
// Packing list's own read-only dialog, and the CO/PL/SI numbers-correction
// panel goes with it, on purpose: the owner asked Draft not to keep that.
test("Draft tab's Open uses its own dialog, not Pending's and not Packing list's", () => {
  const draftScreen = app.slice(app.indexOf('SCREENS.draftorders = async'),
    app.indexOf('\n};', app.indexOf('SCREENS.draftorders = async')));
  assert.match(draftScreen, /openDraftOrder\(b\.dataset\.open, load, page\)/,
    "wired to its own dialog");
  assert.doesNotMatch(draftScreen, /openOrder\(b\.dataset\.open, load\)/,
    'not the shared read-only one Pick & send uses');
  assert.doesNotMatch(draftScreen, /openPackingListOrder\(/,
    'and not Packing list\'s own copy either');

  // Packing list has its own copy (openPackingListOrder, below) — the owner
  // asked its buttons changed without touching Pick & send's own read-only
  // Open, which stays wired to the shared openOrder, exactly as it was.
  const packingScreen = app.slice(app.indexOf('SCREENS.copacking = async'),
    app.indexOf('SCREENS.orders = async'));
  assert.match(packingScreen, /openPackingListOrder\(b\.dataset\.open, load\)/,
    "Packing list's own dialog, not the shared one");
  assert.doesNotMatch(packingScreen, /openOrder\(b\.dataset\.open, load, \{ readOnly: true \}\)/,
    'no longer opens the shared read-only dialog');
  const wholesaleScreen = app.slice(app.indexOf('SCREENS.orders = async'),
    app.indexOf('async function openPendingOrder'));
  assert.match(wholesaleScreen, /openOrder\(b\.dataset\.open, load, \{ readOnly: true \}\)/,
    "Pick & send's own read-only Open, unchanged");
});

// Packing list's own copy of the order dialog: no Packing list button (this
// tab is itself reached by pressing Packing list elsewhere), no Start
// picking, and Dispatch renamed Completed — same action underneath, just
// this tab's own word for it. The shared openOrder, which Pick & send still
// uses, keeps all three exactly as they were.
test("Packing list's own dialog drops two buttons and renames Dispatch to Completed", () => {
  const at = app.indexOf('async function openPackingListOrder');
  const fn = app.slice(at, app.indexOf('\n}\n', at));

  assert.doesNotMatch(fn, /id="a_packing"/, 'no Packing list button');
  assert.doesNotMatch(fn, /id="a_pick"/, 'no Start picking button');
  assert.doesNotMatch(fn, /showPackingList\(/,
    'nothing here opens the Packing list document as a popup any more');
  assert.match(fn, /id="a_send">Completed<\/button>/,
    'Dispatch renamed to Completed, right on the button label');
  assert.match(fn, /act\('#a_send', 'dispatch'\);/,
    'the same action underneath — only the word on the button changed');

  // openOrder itself, which Pick & send still opens, is untouched.
  const openOrderFn = app.slice(app.indexOf('async function openOrder'),
    app.indexOf('async function openPackingListOrder'));
  assert.match(openOrderFn, /id="a_packing"/);
  assert.match(openOrderFn, /id="a_pick"/);
  assert.match(openOrderFn, />Dispatch<\/button>/);
});

// The sheet on the left is the PACKING LIST itself here, not the customer
// order form — this tab is about packing lists, so that is the paper it
// opens to. The owner was explicit this was not to be the customer order
// form that openOrder draws everywhere else.
test("Packing list's own dialog draws the PACKING LIST sheet, not the customer order form", () => {
  const at = app.indexOf('async function openPackingListOrder');
  const fn = app.slice(at, app.indexOf('\n}\n', at));

  assert.doesNotMatch(fn, /customerOrderForm\(\{/,
    'not the customer order form openOrder draws');
  assert.match(fn, /<div class="title">PACKING LIST<\/div>/,
    'the packing list sheet itself, same title it carries everywhere else');
  assert.match(fn, /o\.pl_no \? 'PACKING LIST NO\.' : 'SALES ORDER NO\.'/,
    'its own packing list number, same as the sheet printed from Pick & send');
  assert.match(fn, /PREPARED BY:/);
  assert.match(fn, /CHECKED BY:/);
});

// The paper's own DATE reads when Packing list was pressed, not when the
// order was placed — same fallback the tab's own table and sort already use
// (packing_list_issued_at first, placed_at only if it's somehow missing).
// This dialog builds its own sheet rather than calling the shared
// showPackingList, so the shared one's DATE is untouched.
test("Packing list's own dialog prints DATE as when Packing list was pressed", () => {
  const at = app.indexOf('async function openPackingListOrder');
  const fn = app.slice(at, app.indexOf('\n}\n', at));

  assert.match(fn,
    /DATE: <span class="val">\$\{onDay\(o\.packing_list_issued_at \|\| o\.placed_at\)\}<\/span>/,
    "packing_list_issued_at first, placed_at only as a fallback");
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

// A cancelled order has nothing left to invoice — Pending customer order's
// own Invoice button drops off its own dialog then. A committed order still
// shows it; Invoice is how an order gets committed in the first place, and
// pressing it again is harmless. But an order can be parked and committed
// at once, and when it is, this screen calls that Draft — the Invoice
// button drops off for that reason too. Cancel stays whatever the status,
// so the row can still be reopened and looked at.
test("Pending customer order's own Invoice button is gone once cancelled or parked, not once merely committed", () => {
  const pendingFn = app.slice(app.indexOf('async function openPendingOrder'),
    app.indexOf('async function openOrder'));
  assert.match(pendingFn,
    /\$\{o\.status !== 'cancelled' && !o\.parked_at \? '<button class="btn quiet" id="pl_invoice">Invoice<\/button>' : ''\}/,
    'the Invoice button disappears when the order is cancelled or parked, committed or not');
  assert.doesNotMatch(pendingFn, /o\.committed_at/,
    'committed_at plays no part in whether Invoice shows');
  assert.match(pendingFn, /id="pl_cancel"/, 'Cancel stays, whatever the status');
});

// The dialog's own header reads the same Stage the row it was opened from
// already does — not the shared orderTag every other screen's dialog uses,
// which knows nothing about parked_at and would call this order Committed
// even while it sits in Draft.
test("Pending customer order's own dialog heads with pendingStageTag, not the shared orderTag", () => {
  const pendingFn = app.slice(app.indexOf('async function openPendingOrder'),
    app.indexOf('async function openOrder'));
  assert.match(pendingFn, /<div class="tags">\$\{pendingStageTag\(o\)\}/,
    'the same Stage the table row already reads');
  assert.doesNotMatch(pendingFn, /\$\{orderTag\(o\)\}/,
    'not the shared tag, which does not know an order can be parked and committed at once');
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
    'a row needs an invoice, and to no longer be Awaiting payment');
});

// The owner reversed course from an earlier fix: a cancelled order's voided
// invoice is back on the Invoice tab rather than hidden, so its own record
// of the number reads here too — sorted by that number same as any other
// row, not singled out to the bottom for being void.
test('a void invoice shows on the Invoice tab, sorted by its number like any other', () => {
  const at = app.indexOf('SCREENS.coinvoices = async');
  const screen = app.slice(at, app.indexOf('\n};', at));
  assert.doesNotMatch(screen, /o\.status !== 'cancelled'/,
    'no longer filtered out for being cancelled');
  assert.doesNotMatch(screen, /invoice_status === 'void'\) - \(b/,
    'no separate void-sorts-last grouping');
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
  assert.match(fn, /\/api\/resellers\/\$\{resellerId\}\/deposit-credit/,
    'typed rows are saved as account credit, its own route');
  assert.doesNotMatch(fn, /openReseller|\br\.name\b/,
    'built apart from the reseller dialog, not a branch of it');
  assert.doesNotMatch(fn, /purchase-order-bill/,
    'built apart from the bill payment form too, not a branch of it');

  // Same shape as the Purchase order Billing statement's own dialog: what
  // has already landed and five rows to record more.
  assert.match(fn, /Payments on file/);
  assert.match(fn, /class="ci_file" type="file"/, 'each row can carry a proof photo');
});

// The Pending payment table — what the reseller said and when, not yet an
// actual payment — is gone from this one dialog. Nothing about pending
// payments anywhere else (the purchase order bill's own copy) is touched.
test('Record payment has no Pending payment table', () => {
  const at = app.indexOf('async function recordInvoicePayment');
  const fn = app.slice(at, app.indexOf('\n}\n', at));

  assert.doesNotMatch(fn, /Pending payment/);
  assert.doesNotMatch(fn, /id="ci_pending"|id="cip_amt"|id="cip_on"|id="cip_go"/);
  assert.doesNotMatch(fn, /\/api\/invoices\/\$\{invoiceId\}\/pending-payments/);
});

// The title now leads with the invoice number this payment is for, then the
// reseller's name, then a way straight into their chat — the same chatBadge
// every other screen already uses. The number comes from the Invoice tab's
// own row (o.si_no), the only place this dialog is opened from, carried in
// as its own parameter rather than refetched.
test('Record payment\'s title leads with the invoice number, then the reseller\'s name and chat link', () => {
  const at = app.indexOf('async function recordInvoicePayment');
  const fn = app.slice(at, app.indexOf('\n}\n', at));

  assert.match(fn, /async function recordInvoicePayment\(invoiceId, invoiceNo, resellerName, chatLink,/,
    'its own parameter, not refetched');
  assert.match(fn,
    /<h3>Record payment — \$\{invoiceNo \? `\$\{esc\(invoiceNo\)\} ` : ''\}\$\{esc\(resellerName \|\| `#\$\{invoiceId\}`\)\} \$\{chatBadge\(chatLink\)\}<\/h3>/);
});

// One reseller's invoices land wherever their own dates put them on the
// main list, next to nobody else's — this is where they are gathered.
test('Record payment shows the whole account\'s invoice log', () => {
  const at = app.indexOf('async function recordInvoicePayment');
  const fn = app.slice(at, app.indexOf('\n}\n', at));

  assert.match(fn, /Invoice log/);
  assert.match(fn, /GET\(`\/api\/resellers\/\$\{resellerId\}`\)/,
    'the whole account, not just this one invoice');
});

// issued_on is a bare date — two invoices raised the same day tie on it, and
// the owner found the newer one of a tied pair sitting below the older one.
// id climbs with every new invoice, so breaking the tie on id descending
// reads as "latest on top" the way she actually meant it.
test('the invoice log breaks a same-day tie by the newer invoice, id descending', () => {
  const at = app.indexOf('async function recordInvoicePayment');
  const fn = app.slice(at, app.indexOf('\n}\n', at));
  const logAt = fn.indexOf('const paintLog');
  const log = fn.slice(logAt, fn.indexOf('await paintLog();', logAt));

  assert.match(log,
    /const sortedInvoices = \[\.\.\.acct\.invoices\]\.sort\(\(a, b\) =>\s*\n\s*\(new Date\(b\.issued_on\) - new Date\(a\.issued_on\)\) \|\| \(b\.id - a\.id\)\);/,
    'this dialog\'s own sort — newest issued_on first, newer id breaks a tie');
  assert.match(log, /table\(sortedInvoices, \[/, 'the table reads the sorted copy, not the raw fetch order');
});

// The account's invoices, added up, so the total is read here rather than
// worked out by hand off the rows above — that sum belongs to the log at
// the bottom of the dialog, not the header, which is this one invoice's own
// figures, the same three Purchase order's own billing statement heads with.
test('the invoice log totals its own Amount and Bal columns', () => {
  const at = app.indexOf('async function recordInvoicePayment');
  const fn = app.slice(at, app.indexOf('\n}\n', at));
  const logAt = fn.indexOf('const paintLog');
  const log = fn.slice(logAt, fn.indexOf('await paintLog();', logAt));

  assert.match(log, /reduce\(\(s, i\) => s \+ Number\(i\[f\]/, 'the rows are added up');
  assert.match(log, /sum\('amount'\)/, 'the Amount column is summed');
  assert.match(log, /sum\('balance'\)/, 'the Bal column is summed too');

  assert.doesNotMatch(fn, /id="ci_accttotal"/,
    'the account-wide sum no longer heads the dialog');
  assert.match(fn, /id="ci_amount"|id="ci_paidsofar"|id="ci_owed"/,
    'this one invoice\'s own Amount, Paid so far and Still owed head it instead');
  assert.match(log, /acct\.invoices\.find\(\(i\) => String\(i\.id\) === String\(invoiceId\)\)/,
    'read off this one invoice, not summed across the account');
});

// The Invoice tab's own Standing tag reads paid / paid w/bal / unpaid / void
// — this log used to read paid / open / past due / void instead, its own
// older, unrelated branches. Brought in step, as its own copy.
test('the invoice log reads the same four Standing words the Invoice tab does', () => {
  const at = app.indexOf('async function recordInvoicePayment');
  const fn = app.slice(at, app.indexOf('\n}\n', at));
  const logStandingAt = fn.indexOf('const logStanding');
  const logStanding = fn.slice(logStandingAt, fn.indexOf('const paintLog', logStandingAt));

  assert.match(logStanding,
    /return tag\(funded\.has\(String\(i\.id\)\) \? 'paid with funds' : 'paid', 'green'\);/,
    'a paid invoice reads "paid with funds" when the account\'s Funds went onto it');
  assert.match(logStanding, /if \(i\.status === 'void'\) return tag\('void', 'grey'\);/);
  assert.match(logStanding,
    /const label = Number\(i\.balance\) < Number\(i\.amount\) \? 'paid w\/bal' : 'unpaid';/);
  assert.match(logStanding, /tag\(label, label === 'unpaid' && i\.overdue \? 'red' : 'amber'\)/);
  assert.doesNotMatch(logStanding, /'open'|'past due'/, 'the old four words are gone');
});

// A void invoice never happened, so the account-wide log's own Total —
// Amount / Bal line leaves it out of the sum; paid, paid w/bal and unpaid
// all still count, since those are real.
test("the invoice log's Total leaves void invoices out of the sum", () => {
  const at = app.indexOf('async function recordInvoicePayment');
  const fn = app.slice(at, app.indexOf('\n}\n', at));
  const sumAt = fn.indexOf('const sum = ');
  const sum = fn.slice(sumAt, fn.indexOf(';', fn.indexOf('reduce', sumAt)) + 1);

  assert.match(sum, /\.filter\(\(i\) => i\.status !== 'void'\)/,
    'void invoices are filtered out before the reduce');
  assert.match(sum, /\.reduce\(\(s, i\) => s \+ Number\(i\[f\] \|\| 0\), 0\)/);
});

// A row in the account-wide log is a dead end without its own way to open
// the document it is the record of — the same blue INVOICE the Invoice tab
// itself opens from, not a redrawn copy. The number itself is the way in,
// not a separate button column off at the end of the row.
test('every row in the invoice log opens its own Invoice document by its number, not a separate button column', () => {
  const at = app.indexOf('async function recordInvoicePayment');
  const fn = app.slice(at, app.indexOf('\n}\n', at));

  assert.match(fn,
    /head: 'Invoice no\.', cell: \(i\) => `<button class="nameopen"\s*\n\s*data-cilog-invdoc="\$\{i\.order_id\}" data-invid="\$\{i\.id\}"><b>\$\{esc\(i\.si_no \|\| '—'\)\}<\/b><\/button>`/,
    'the Invoice no. cell itself is the button, carrying its own order and invoice id');
  assert.doesNotMatch(fn, /🖨 Invoice<\/button>` \},\s*\n\s*\], 'No invoices yet\.'/,
    'no trailing button column left on this table');
  assert.match(fn, /\$\$\('\[data-cilog-invdoc\]', box\)\.forEach/,
    'wired for every row drawn into the log');
  assert.match(fn, /showInvoiceLogDoc\(\{/,
    "this log's own document renderer — Balance here can mean the Funds a payment overflowed to, which no other screen's blue INVOICE should ever show");
});

// The document opens over Record payment, not in place of it — its own ✕
// (or Done) has to come back to the dialog it was opened from, the same
// "one step back" the dialog stack already gives every other over:true
// opener, rather than closing out to the list behind everything.
// showInvoiceLogDoc always opens this way, so it is checked once on the
// renderer itself rather than on every call site that opens it.
test("the invoice log's own document closes back onto Record payment, not out to the list", () => {
  const at = app.indexOf('function showInvoiceLogDoc');
  const fn = app.slice(at, app.indexOf('\n}\n', at));

  assert.match(fn, /`, 'wide', true\);/,
    'always opened with over: true, so closing it pops back rather than closing everything');
});

// Save pays the invoice down first; only real overpayment becomes Funds. So
// a payment row here can be bigger than anything this invoice ever owed —
// the Amount printed has to be the real transfer, not just the slice this
// invoice kept, and Balance, once there is nothing left to collect, says
// where the rest of it went instead of repeating a Total Due that already
// reads ₱0.00 above it.
test("the invoice log's own document shows the real amount paid and, once settled, where any extra went", () => {
  const at = app.indexOf('function showInvoiceLogDoc');
  const fn = app.slice(at, app.indexOf('\n}\n', at));

  assert.match(fn, /Amount: \$\{p \? peso\(p\.displayAmount \?\? p\.amount\) : ''\}/,
    'the row shows the real transfer (applied + whatever of it overflowed), not just what was applied');
  assert.match(fn,
    /<span id="iv_bal">\$\{\s*\n?\s*peso\(fundTotal > 0 \? fundTotal : grand - paid\)\}<\/span>/,
    "Balance reads the Funds total once there's nothing left owed; otherwise it's the ordinary balance due");

  // The shared showInvoiceDoc every other screen opens is untouched —
  // Balance there only ever means what is still owed.
  const shared = app.slice(app.indexOf('function showInvoiceDoc('),
    app.indexOf('function showInvoiceLogDoc'));
  assert.doesNotMatch(shared, /fundTotal/,
    'no other screen\'s blue INVOICE is told about Funds overflow at all');
  assert.match(shared, /<span id="iv_bal">\$\{peso\(grand - paid\)\}<\/span>/,
    "elsewhere Balance still means what is still owed, never a fund");
});

test("the invoice log's own click handler matches each overflow to the payment row it came off, by reference no.", () => {
  const at = app.indexOf('async function recordInvoicePayment');
  const fn = app.slice(at, app.indexOf('\n}\n', at));
  const handlerAt = fn.indexOf("$$('[data-cilog-invdoc]', box)");
  const handler = fn.slice(handlerAt, fn.indexOf('}));', handlerAt));

  assert.match(handler,
    /const myOverflow = \(acct\.overflow \|\| \[\]\)\s*\n\s*\.filter\(\(f\) => String\(f\.source_invoice_id\) === b\.dataset\.invid && !f\.target_invoice_id\);/,
    "only this invoice's own overpayment — a Funds draw (target set) is not one — and acct is already in hand, no second fetch");
  assert.match(handler, /\(f\.reference_no \|\| ''\) === \(p\.reference_no \|\| ''\)/,
    'matched to the payment row that shares its reference no.');
  assert.match(handler, /displayPayments\.push\(\{\s*\n\s*method: 'FUNDS'/,
    'overflow with no matching row (paid entirely in FUNDS) still gets a slot of its own, not dropped');
});

// Purchase order's own billing statement already shows Amount / Paid so far
// / Still owed, and a real photo thumbnail once a payment has one on file —
// this is that same shape, for an invoice, built apart rather than shared.
test('Record payment heads with its own Amount, Paid so far and Still owed', () => {
  const at = app.indexOf('async function recordInvoicePayment');
  const fn = app.slice(at, app.indexOf('\n}\n', at));

  assert.match(fn, /<div><div class="dim">Amount<\/div><b id="ci_amount"><\/b><\/div>/);
  assert.match(fn, /<div><div class="dim">Paid so far<\/div><b id="ci_paidsofar"><\/b><\/div>/);
  assert.match(fn, /<div><div class="dim">Still owed<\/div><b id="ci_owed">\$\{peso\(owed\)\}<\/b><\/div>/);
});

// Right under the payment rows, so whoever is recording a payment can see
// at a glance what the account already has in credit before adding to it —
// the owner asked for it by name, "Funds".
test('a Funds readout sits below the payment rows, showing the account\'s available credit', () => {
  const at = app.indexOf('async function recordInvoicePayment');
  const fn = app.slice(at, app.indexOf('\n}\n', at));

  const rowsAt = fn.indexOf('id="ci_rows"');
  const fundsNowAt = fn.indexOf('id="ci_fundsnow"');
  const buttonRowAt = fn.indexOf('id="ci_pack2"');
  assert.ok(rowsAt > 0 && fundsNowAt > rowsAt && buttonRowAt > fundsNowAt,
    'sits between the payment rows and the Save/Done/Packing list row');
  assert.match(fn, /<div><div class="dim">Funds<\/div><b id="ci_fundsnowamt"><\/b>/);

  const paintAt = fn.indexOf('const paintLog');
  const paint = fn.slice(paintAt, fn.indexOf('await paintLog();', paintAt));
  assert.match(paint, /\$\('#ci_fundsnowamt'\)/);
  assert.match(paint, /fundsAmount = Number\(acct\.credit \|\| 0\)/,
    'the account\'s own current credit balance, already carried by the one account fetch');
});

// The owner asked for the "Apply to this payment" checkbox to be removed
// from this dialog entirely — the Funds amount still reads back here.
// Drawing on Funds didn't leave the dialog for good, though (172): it
// came back as its own Mode of payment, a row read by name rather than a
// checkbox read by its own state.
test('the Funds checkbox is gone — the readout stays, a FUNDS row is how credit is applied now', () => {
  const at = app.indexOf('async function recordInvoicePayment');
  const fn = app.slice(at, app.indexOf('\n}\n', at));

  assert.doesNotMatch(fn, /ci_fundscheck/, 'the checkbox and its handler are both gone');
  assert.match(fn, /\/api\/invoices\/\$\{invoiceId\}\/apply-credit/,
    'a FUNDS-mode row calls the same apply-credit route the old checkbox did');
  assert.match(fn, /<div><div class="dim">Funds<\/div><b id="ci_fundsnowamt"><\/b><\/div>/,
    'the Funds amount is still shown — only the checkbox was asked to go');
});

// Opening the dialog, or right after a save, the first row already reads
// a real amount — what this invoice still owes — not just a grey hint she
// has to type herself.
test('the first row keeps a real value — what is still owed — not just a placeholder hint', () => {
  const at = app.indexOf('async function recordInvoicePayment');
  const fn = app.slice(at, app.indexOf('\n}\n', at));

  assert.match(fn, /value="\$\{n \|\| owed <= 0 \? '' : Number\(owed\)\.toLocaleString\('en-US'\)\}"/,
    'a real starting value on the first row alone, blank on the rest');

  const resetAt = fn.indexOf('const resetRows');
  const reset = fn.slice(resetAt, fn.indexOf('};', resetAt) + 2);
  assert.match(reset, /\$\('\.ci_amt', row\)\.value = n === 0 && owed > 0/,
    'the same real value is restored after every save, not just on first open');
});

// Typing exactly what an invoice owes used to just sit in Funds forever,
// with no way left to actually settle the invoice once the checkbox was
// removed — the owner hit this directly (paying 25,800 against a 25,800
// invoice kept adding to Funds instead of ever reaching zero balance). Each
// row now pays down what's still owed first, in the order typed; only once
// that hits zero does any of it become a real overpayment, banked as Funds.
test('Save pays down what the invoice still owes first — only the real overpayment becomes Funds', () => {
  const at = app.indexOf('async function recordInvoicePayment');
  const fn = app.slice(at, app.indexOf('\n}\n', at));
  const saveAt = fn.indexOf('const save = async');
  const save = fn.slice(saveAt, fn.indexOf("$('#ci_go2')", saveAt));

  assert.match(save, /let remaining = owed;/, 'walked down from what is still owed, not the invoice\'s full amount');
  assert.match(save, /const pay = Math\.min\(r\.amount, Math\.max\(remaining, 0\)\);/,
    'never pays more than either the row itself or what is actually still owed');
  assert.match(save, /const overflow = r\.amount - pay;/,
    'whatever a row has left over once owing is covered');

  assert.match(save, /if \(payRows\.length\) \{/);
  assert.match(save, /\/api\/invoices\/\$\{invoiceId\}\/payments`, \{ payments: payRows\.map/,
    'the part that pays down owing goes straight to the invoice, same route as before the Funds feature existed');
  assert.match(save, /if \(overflowRows\.length\) \{/);
  assert.match(save, /\/api\/resellers\/\$\{resellerId\}\/deposit-credit`, \{ payments: overflowRows\.map/,
    'only the part left over banks as credit');
  assert.doesNotMatch(save, /\/api\/resellers\/\$\{resellerId\}\/confirm/,
    'never the route that pays down whatever else the account has open');
  assert.match(save, /target_invoice_id: null, amount: r\.amount/,
    'an overflow row is still logged in this dialog\'s own Funds log same as before');
});

// Pressing Invoice no longer reaches into Funds on its own (172) — a row
// with Mode of payment set to FUNDS is the one door left that draws on it,
// read by name rather than folded into the ordinary pay/overflow split
// every other row goes through.
test('a row with Mode of payment FUNDS draws on the account\'s own Funds instead of being paid in', () => {
  const at = app.indexOf('async function recordInvoicePayment');
  const fn = app.slice(at, app.indexOf('\n}\n', at));
  const saveAt = fn.indexOf('const save = async');
  const save = fn.slice(saveAt, fn.indexOf("$('#ci_go2')", saveAt));

  assert.match(save, /if \(r\.method === 'FUNDS'\) \{/,
    'told apart from an ordinary row by its own Mode of payment, before the pay/overflow split runs at all');
  assert.match(save, /fundsRows\.push\(r\);/);
  assert.match(save, /remaining -= r\.amount;/,
    'a FUNDS row still counts against what is owed, so a row typed after it does not also try to cover the same amount');

  const fundsAt = save.indexOf('for (const r of fundsRows)');
  const funds = save.slice(fundsAt, save.indexOf('if (payRows.length)', fundsAt));
  assert.match(funds, /\/api\/invoices\/\$\{invoiceId\}\/apply-credit`, \{ amount: r\.amount \}/,
    'the same apply-credit route the old checkbox used — drawn from Funds, not banked into it');
  assert.match(funds, /\/api\/invoices\/\$\{invoiceId\}\/overflow-log`,\s*\n\s*\{ reseller_id: resellerId, target_invoice_id: invoiceId, amount: r\.amount/,
    'logged against this invoice in the Funds log too, same as the old checkbox logged its own application');

  assert.match(save, /paid: payRows\.reduce\(\(s, r\) => s \+ r\.amount, 0\) \+ fundsRows\.reduce\(\(s, r\) => s \+ r\.amount, 0\)/,
    'counted as paid in the notice Save shows, same as a row that paid the invoice directly');
});

// Payments on file still reads a real thumbnail back for any payment
// actually recorded against this invoice. A proof photo attached to any
// row typed into Save still goes into the account's own general file
// drawer, whether that row paid the invoice, overflowed to Funds, or split
// across both — simpler than threading it onto one half of a split row.
test('Payments on file still reads a real thumbnail; a Save-row\'s own proof goes to the account\'s file drawer', () => {
  const at = app.indexOf('async function recordInvoicePayment');
  const fn = app.slice(at, app.indexOf('\n}\n', at));
  const priorAt = fn.indexOf('const paintPrior');
  const prior = fn.slice(priorAt, fn.indexOf('await paintPrior();', priorAt));

  assert.match(prior, /p\.file_ids\?\.length/,
    'a payment with a file on file is told apart from one with none');
  assert.match(prior, /`\/api\/invoice-payment-files\/\$\{p\.file_ids\[0\]\}`/,
    'the real photo is read back, not just its presence noted');
  // A Save-row's proof lives in the account's drawer, labelled with this
  // invoice and its reference — found there so the card shows it and zooms.
  assert.match(prior, /f\.category === 'payment_proof'/);
  assert.match(prior, /f\.label === `Invoice #\$\{invoiceId\}\$\{p\.reference_no \? ` · \$\{p\.reference_no\}` : ''\}`/,
    'the same label Save files it under');
  assert.match(prior, /`\/api\/reseller-files\/\$\{proof\.id\}`/);
  assert.match(prior, /data-zoom="\$\{src\}"/, 'and it opens full size');
  // The card's amount is the real transfer: what went on to Funds off the
  // same reference is added back (₱61,200 + ₱23,800 = ₱85,000).
  assert.match(prior, /String\(f\.source_invoice_id\) === String\(invoiceId\) && !f\.target_invoice_id/);
  assert.match(prior, /<b>\$\{esc\(peso\(amount\)\)\}<\/b>/);

  const saveAt = fn.indexOf('const save = async');
  const save = fn.slice(saveAt, fn.indexOf('$(\'#ci_go2\')', saveAt));
  assert.match(save, /uploadResellerFile\(resellerId, r\.file, 'payment_proof'/,
    'every row\'s own proof goes to the account\'s file drawer, not threaded onto a specific invoice payment');
  assert.doesNotMatch(save, /\/api\/invoice-payments\/\$\{paymentId\}\/files/);
});

// The button is a door, not a shortcut — it lands on the tab where the
// order already sits and leaves opening it to whoever gets there. But
// Packing list only shows what is paid, so a payment typed into the form
// and left unsaved would make the order look like it never happened —
// the button saves that on the way out rather than stranding it.
test('Record payment has a Packing list button beside Done, and it saves on the way out', () => {
  const at = app.indexOf('async function recordInvoicePayment');
  const fn = app.slice(at, app.indexOf('\n}\n', at));

  const doneAt = fn.indexOf('id="ci_done2"');
  const packAt = fn.indexOf('id="ci_pack2"');
  assert.ok(doneAt > 0 && packAt > 0 && Math.abs(packAt - doneAt) < 120,
    'Packing list sits right beside Done, not off elsewhere in the dialog');

  const packHandler = fn.slice(fn.indexOf("$('#ci_pack2').addEventListener"));
  assert.match(packHandler, /await save\(\);/,
    'a payment left filled in the form is saved before leaving');
  assert.match(packHandler, /\$\('\[data-panel="copacking"\]'\)\?\.click\(\)/,
    'clicking it switches to the Packing list tab');
  assert.doesNotMatch(fn, /showPackingList\(/,
    'it does not open the document itself — that is opened by hand from the tab');
});

// One Packing list / Done / Save, right under the payment rows (and the
// Funds readout beneath them) — the owner asked for the second copy that
// used to sit below the Funds log removed, so this is the only row left,
// wired directly rather than delegating down to a row that no longer exists.
test('Record payment has one Packing list / Done / Save row, right under the payment rows', () => {
  const at = app.indexOf('async function recordInvoicePayment');
  const fn = app.slice(at, app.indexOf('\n}\n', at));

  const rowsAt = fn.indexOf('id="ci_rows"');
  const fundsNowAt = fn.indexOf('id="ci_fundsnow"');
  const rowAt = fn.indexOf('id="ci_pack2"');
  const logAt = fn.indexOf('Invoice log');
  assert.ok(rowsAt > 0 && fundsNowAt > rowsAt && rowAt > fundsNowAt && logAt > rowAt,
    'payment rows, then the Funds readout, then the one button row, then the invoice log');
  assert.match(fn, /id="ci_done2"/);
  assert.match(fn, /id="ci_go2"/);

  assert.doesNotMatch(fn, /id="ci_go"|id="ci_done"|id="ci_pack"/,
    'the bottom row this used to delegate to is gone, not just hidden');
  assert.match(fn, /\$\('#ci_go2'\)\.addEventListener\('click', async \(\) => \{/,
    'Save is wired directly to this one row now, not delegated to a removed one');
});

// The amount held as credit is what the Save button tells the owner, not a
// silent success — she asked for the overpayment to be visible, not just
// accepted without a word. And since a row can now split across both an
// actual payment and a real overpayment, the message says so when it does.
test('Save says when part of a payment was held as credit', () => {
  const at = app.indexOf('async function recordInvoicePayment');
  const fn = app.slice(at, app.indexOf('\n}\n', at));
  const goAt = fn.indexOf("$('#ci_go2').addEventListener");
  const go = fn.slice(goAt, fn.indexOf('});', goAt) + 3);

  assert.match(go, /result\.paid > 0 && result\.overflow > 0/,
    'a split row gets its own message — both halves named');
  assert.match(go, /result\.overflow > 0/);
  assert.match(go, /held as credit/);
});

// Below the Invoice log, same account, same dialog — not a second fetch of
// an account already loaded for the Invoice log just above it. The owner
// asked for the button row that used to follow it removed, so the dialog
// now simply ends here.
test('a Funds log sits below the Invoice log, fed off the same account fetch, and the dialog ends there', () => {
  const at = app.indexOf('async function recordInvoicePayment');
  const fn = app.slice(at, app.indexOf('\n}\n', at));

  const logAt = fn.indexOf('id="ci_log"');
  const fundsAt = fn.indexOf('id="ci_funds"');
  assert.ok(logAt > 0 && fundsAt > logAt, 'Funds log sits below the Invoice log');
  assert.match(fn, /<h3 class="mt">Funds log/);
  assert.doesNotMatch(fn.slice(fundsAt), /class="mt right"/,
    'no button row follows the Funds log anymore');

  const paintAt = fn.indexOf('const paintLog');
  const paint = fn.slice(paintAt, fn.indexOf('await paintLog();', paintAt));
  const fundsBoxAt = paint.indexOf("$('#ci_funds')");
  assert.ok(fundsBoxAt > 0, 'painted from inside paintLog, not a second GET of its own');
  const fundsPaint = paint.slice(fundsBoxAt);
  assert.match(fundsPaint, /acct\.overflow/, 'reads this dialog\'s own overflow log');
  assert.doesNotMatch(fn, /\/api\/resellers\/\$\{resellerId\}\/overflow/,
    'no separate overflow endpoint — the one account fetch already carries it');
});

// reseller_credits (the account page's own Credit ledger) only ever shows a
// leftover with nothing open to put it against — most of the time
// pay_reseller_account pays down whatever else is open first, and that used
// to vanish from here with nothing to show for it. The owner found exactly
// this: a payment that overshot one invoice, with the overflow nowhere to
// be seen. Invoice tab's own record of where it actually went — tied to
// both invoices, with both their own numbers and dates — is read back here.
test('the Funds log shows which invoice an overflow came from and which it actually reached', () => {
  const at = app.indexOf('async function recordInvoicePayment');
  const fn = app.slice(at, app.indexOf('\n}\n', at));
  const paintAt = fn.indexOf('const paintLog');
  const paint = fn.slice(paintAt, fn.indexOf('await paintLog();', paintAt));
  const fundsAt = paint.indexOf("$('#ci_funds')");
  const funds = paint.slice(fundsAt);

  assert.match(funds, /table\(acct\.overflow \|\| \[\], \[/, 'a real table, not a joined list of lines');
  assert.match(funds, /head: 'Invoice no\./, 'the invoice this overflow came from');
  assert.match(funds, /f\.source_si_no/);
  assert.match(funds, /f\.source_issued_on/, 'that invoice\'s own date, not just the log entry\'s own timestamp');
  assert.match(funds, /f\.target_si_no/, 'and the invoice it actually reached, if any');
  assert.doesNotMatch(funds, /f\.target_issued_on/,
    'the second Date column (when the overflow was applied) is gone — Reason already names the invoice');
  assert.match(funds, /Overpayment of \$\{esc\(f\.source_si_no \|\| '—'\)\}\$\{f\.reference_no \? `-\$\{esc\(f\.reference_no\)\}` : ''\}/,
    'a row with nothing open to reach names the invoice it overpaid and its own reference no., not a generic phrase');
  // The Invoice no. cell itself is the way in now, not a separate button
  // column — same nameopen pattern the Invoice log above it uses — and it
  // opens the source invoice shown in the row, not the target named in Reason.
  assert.match(funds,
    /head: 'Invoice no\.', cell: \(f\) => `<button class="nameopen"\s*\n\s*data-cifunds-invdoc="\$\{f\.source_order_id\}" data-invid="\$\{f\.source_invoice_id\}"><b>\$\{esc\(f\.source_si_no \|\| '—'\)\}<\/b><\/button>`/,
    'the Invoice no. cell itself is the button, carrying the source order');
  assert.doesNotMatch(funds, /🖨 Invoice<\/button>` : ''\} \},\s*\n\s*\], 'No overpayment on this account\.'/,
    'no trailing button column left on this table');

  // Written from this one dialog's own save, not reseller_credits or
  // pay_reseller_account, which every other screen already depends on.
  // Every overflow row Save deposits is banked with nothing open to put it
  // against, so target_invoice_id is always null here.
  const saveAt = fn.indexOf('const save = async');
  const save = fn.slice(saveAt, fn.indexOf("$('#ci_go2')", saveAt));
  assert.match(save, /\/api\/invoices\/\$\{invoiceId\}\/overflow-log/);
  assert.match(save, /target_invoice_id: null, amount: r\.amount/);

  // The same blue INVOICE the Invoice log's row opens, with the same
  // figures — the real transfer amount and what went on to Funds — from the
  // Funds log's own copy of that document, not the shared showInvoiceDoc,
  // which printed only the slice this invoice absorbed and Balance ₱0.00.
  assert.match(funds, /\$\$\('\[data-cifunds-invdoc\]', fundsBox\)\.forEach/);
  assert.match(funds, /showFundsLogDoc\(\{/);
  assert.doesNotMatch(funds, /showInvoiceDoc\(\{/,
    'the shared invoice paper is left to the screens that still use it');
  assert.match(funds, /String\(f\.source_invoice_id\) === b\.dataset\.invid/);
  assert.match(funds, /displayAmount: Number\(p\.amount\) \+ extra/);
  assert.match(funds, /payments: displayPayments, who: full, invoiceNo: full\.si_no, fundTotal/);

  const doc = app.slice(app.indexOf('function showFundsLogDoc('));
  const docFn = doc.slice(0, doc.indexOf('\n}\n'));
  assert.match(docFn, /peso\(p\.displayAmount \?\? p\.amount\)/, 'Amount is the real transfer');
  assert.match(docFn, /peso\(fundTotal > 0 \? fundTotal : grand - paid\)/, 'Balance is what went to Funds');
});

// The Amount column reads as a running balance — what Funds stood at right
// after each event — not the raw size of that one event. The table itself
// still reads newest first, same as every other log in this dialog, but the
// balance under it has to be walked the other way: oldest first, a deposit
// adding, an application (something with a target invoice) taking away.
test('the Funds log\'s Amount column is a running balance, not the size of that one event', () => {
  const at = app.indexOf('async function recordInvoicePayment');
  const fn = app.slice(at, app.indexOf('\n}\n', at));
  const paintAt = fn.indexOf('const paintLog');
  const paint = fn.slice(paintAt, fn.indexOf('await paintLog();', paintAt));
  const fundsAt = paint.indexOf("$('#ci_funds')");
  const funds = paint.slice(fundsAt);

  assert.match(funds, /\.sort\(\(a, b\) => a\.id - b\.id\)/,
    'walked oldest first to accumulate correctly, regardless of the table\'s own newest-first order');
  assert.match(funds, /f\.target_invoice_id \? -Number\(f\.amount\) : Number\(f\.amount\)/,
    'an application takes away, a deposit adds');
  assert.match(funds, /cell: \(f\) => `<b>\$\{peso\(fundsRunning\.get\(f\.id\)\)\}<\/b>`/,
    'the computed running balance is shown, not the raw f.amount');

  // raise_invoice (db/047, shared by every screen that commits an order)
  // draws down the same Funds the moment a new invoice is raised, with no
  // way for this one dialog's own log to hear about it — so the computed
  // balance drifts stale the moment that happens anywhere else. Anchoring
  // the newest entry to the account's own real current credit (the one
  // number every screen already agrees on) keeps it honest without this
  // dialog having to know why Funds moved.
  assert.match(funds, /const fundsDrift = Number\(acct\.credit \|\| 0\) - fundsRunningLast;/,
    'the gap between what this log computed and what Funds actually is');
  assert.match(funds, /if \(fundsDrift\) for \(const \[id, bal\] of fundsRunning\) fundsRunning\.set\(id, bal \+ fundsDrift\);/,
    'every row shifted by that same gap, so the newest one lands on the real current balance');
});

test('the packing list screen leads with its own number, not a database id', () => {
  const at = app.indexOf('SCREENS.copacking = async');
  const screen = app.slice(at, app.indexOf('\n};', at));
  assert.match(screen, /head: 'Packing list', cell: \(o\) => `<b>\$\{esc\(o\.pl_no/,
    'the bench is holding a sheet with PL26_08_004 on it, not #41');
});

// The owner asked for the invoice number to sit right beside the packing
// list number — order_board already carries si_no along with every other
// order field this screen fetches, so this is a column, not a new fetch.
test("the packing list screen shows the invoice number right beside the packing list's own", () => {
  const at = app.indexOf('SCREENS.copacking = async');
  const screen = app.slice(at, app.indexOf('\n};', at));
  const plAt = screen.indexOf("head: 'Packing list'");
  const invAt = screen.indexOf("head: 'Invoice no.'");
  const resellerAt = screen.indexOf("head: 'Reseller'");
  assert.ok(plAt > 0 && invAt > plAt && resellerAt > invAt,
    'Invoice no. sits right after Packing list, ahead of Reseller');
  assert.match(screen, /head: 'Invoice no\.', cell: \(o\) => esc\(o\.si_no \|\| '—'\)/,
    "the invoice's own number, not the database id, a dash when there isn't one yet");
});

// Pressing Packing list on Invoice tab's own Record payment dialog is what
// sends an order here in the first place — pressing it again on an order
// already sitting here is asking to be seen first, the same as pressing
// Invoice again asks Invoice tab for the newest number.
test('the packing list screen reads newest-pressed first', () => {
  const at = app.indexOf('SCREENS.copacking = async');
  const screen = app.slice(at, app.indexOf('\n};', at));
  assert.match(screen,
    /\.sort\(\(a, b\) => new Date\(b\.packing_list_issued_at \|\| b\.placed_at\)\s*-\s*new Date\(a\.packing_list_issued_at \|\| a\.placed_at\)\)/,
    'descending by packing_list_issued_at, b before a');
});

// Every row here has had Packing list pressed, so the date shown has to be
// the one that press happened on — same field the sort just above already
// reads — not the order's own placement date, which can land on an earlier
// day entirely once an order sits a while before being packed.
test("the packing list screen's own Placed column reads when Packing list was pressed, not when the order was placed", () => {
  const at = app.indexOf('SCREENS.copacking = async');
  const screen = app.slice(at, app.indexOf('\n};', at));
  assert.match(screen, /head: 'Placed', cell: \(o\) => when\(o\.packing_list_issued_at \|\| o\.placed_at\)/,
    "packing_list_issued_at first, placed_at only as a fallback");
});

// The tab shows only what Packing list has actually been pressed for — paid
// or not, the press decides. The warehouse's own Pick & send, and the
// observer's Wholesale, still need every committed order regardless of that
// press — so this is its own screen, not a filter bolted onto the shared
// one, the same lesson PRs #531-535 already paid for once.
test('the tab is its own screen, packing-list-pressed only — the shared board stays untouched', () => {
  const at = app.indexOf('SCREENS.copacking = async');
  const screen = app.slice(at, app.indexOf('\n};', at));
  assert.match(screen, /\.filter\(\(o\) => o\.packing_list_issued_at\)/,
    'only orders Packing list was pressed for show here, whether paid or not');
  assert.doesNotMatch(screen, /user\.role === 'warehouse'/,
    'this copy never speaks for Pick & send — it does not know that heading exists');

  const shared = app.slice(app.indexOf('SCREENS.orders = async'),
                            app.indexOf('/**\n * One order, opened.'));
  assert.doesNotMatch(shared, /\.filter\(\(o\) => o\.packing_list_issued_at\)/,
    'Pick & send and Wholesale still show every committed order, pressed or not');
});

// The explicit reversal: an unpaid order that has had Packing list pressed
// still belongs here. Payment is read as its own column, not a gate.
test('an unpaid order still shows here once Packing list has been pressed', () => {
  const at = app.indexOf('SCREENS.copacking = async');
  const screen = app.slice(at, app.indexOf('\n};', at));
  assert.doesNotMatch(screen, /invoice_status === 'paid'/,
    'payment status no longer gates this screen at all');
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

// Chat order's own product search — typing a code should find the product
// the same as typing its name already does. Draft resumes into this exact
// same basket screen, so there is nothing else to touch for that flow.
//
// Nearly every code in the real catalog shares the shop's own prefix, so
// matching it on any term at all — including something as short and common
// as a two-letter word — turns "search" into "show almost everything".
// The code only joins the search once the term is long enough to actually
// mean something as a code, name and brand still matching at any length.
test("Chat order's product search also matches the product code", () => {
  const at = app.indexOf('SCREENS.chatorders = async');
  const screen = app.slice(at, app.indexOf('\nSCREENS.', at + 1));
  assert.match(screen, /term\.length >= 3 && \(p\.sku \|\| ''\)\.toLowerCase\(\)\.includes\(term\)/,
    'the sku only joins the search once the term is long enough to mean something as a code');
  assert.match(screen, /placeholder="Search by code, name or brand…"/,
    'the box says so, now that code is one of the three');
});

// The box says it searches by code — the table it searches has to show one,
// or typing a code found on a printed price list has nothing on screen to
// confirm the match against.
test('the product table leads with the code, ahead of the product itself', () => {
  const at = app.indexOf('SCREENS.chatorders = async');
  const screen = app.slice(at, app.indexOf('\nSCREENS.', at + 1));
  const codeAt = screen.indexOf("head: 'Code'");
  const productAt = screen.indexOf("head: 'Product'");
  assert.ok(codeAt > -1 && productAt > -1 && codeAt < productAt,
    'Code is a column of its own, and comes before Product');
  assert.match(screen, /head: 'Code', cell: \(p\) => esc\(p\.sku \|\| ''\)/,
    'the code column reads the sku plainly, nothing dressed up');
});

// Pending customer order's printed CUSTOMER ORDER FORM sits in a flex column
// (co-side) that scrolls when it is too tall, but co-scale (the box holding
// the sheet, scaled to size by JS) sets overflow: hidden of its own — which,
// on a flex item, zeroes its automatic minimum height. Past a certain line
// count co-side's content outgrew its own 78vh ceiling, and flex shrank
// co-scale below the height scaleCoForm had just given it rather than
// letting co-side's scrollbar take the overflow: the sheet was clipped
// mid-row, its bottom lines never visible, however many were actually on
// the order. openDraftOrder shares this exact same markup and CSS and is
// left alone — the fix reaches Pending customer order only.
test('Pending customer order carries its own dialog class, scoped away from the Draft screen that shares its markup', () => {
  const at = app.indexOf('async function openPendingOrder');
  const fn = app.slice(at, app.indexOf('\nasync function openDraftOrder'));
  assert.match(fn, /,\s*'wide co-open pco-open'\);/,
    "its own class alongside the shared co-open one, not a second door onto it");

  const draftAt = app.indexOf('async function openDraftOrder');
  const draftFn = app.slice(draftAt, app.indexOf('\nasync function', draftAt + 1));
  assert.doesNotMatch(draftFn, /pco-open/,
    "Draft's own copy of this same dialog never picks up Pending customer order's fix");
});

test('co-scale is held to its full height only inside the pco-open dialog, not everywhere co-scale is used', () => {
  assert.match(css, /\.dialog\.pco-open \.order-split \.co-scale\s*\{\s*flex-shrink:\s*0;\s*\}/,
    'scoped under .pco-open, so Purchase order, Receiving form, the Invoice and ' +
    'Packing list tabs, Chat order and Draft — every other screen built on the ' +
    'same co-scale — render exactly as they did before');

  // The shared rule itself is untouched — still the one declaration, same as
  // every other screen built on co-scale still reads it.
  const sharedCount = [...css.matchAll(/\.order-split \.co-scale\s*\{\s*overflow:\s*hidden;\s*\}/g)].length;
  assert.equal(sharedCount, 1, 'the shared co-scale rule was not touched, only added to');
});

// Record payment, three owner asks in one pass, all inside this one dialog:
// two entry rows instead of five, "paid with funds" in the Invoice log, and
// the Funds log's Sales amount column with Amount renamed Funds.
test('Record payment: two entry rows, paid with funds, and the Funds log reads Sales amount then Funds', () => {
  const at = app.indexOf('async function recordInvoicePayment');
  const fn = app.slice(at, app.indexOf('\n}\n', at));

  assert.match(fn, /<div id="ci_rows">\$\{\[0, 1\]\.map\(\(n\) =>/, 'two rows');
  assert.match(fn, /Up to two payments at once/);
  assert.doesNotMatch(fn, /Up to five payments at once/);
  assert.match(fn, /<h3 class="mt">Payments on file<\/h3>/, 'Payments on file stays');

  // Every Funds draw leaves a negative reseller_credits row naming the invoice.
  assert.match(fn, /\.filter\(\(c\) => Number\(c\.amount\) < 0\)/);
  assert.match(fn, /\/invoice #\(\\d\+\)\/i\.exec\(c\.reason/);
  assert.match(fn, /head: 'Standing', cell: \(i\) => logStanding\(i, funded\)/);

  const funds = fn.slice(fn.indexOf("$('#ci_funds')"));
  const reason = funds.indexOf("head: 'Reason'");
  const sales = funds.indexOf("head: 'Sales amount'");
  const fundsCol = funds.indexOf("head: 'Funds'");
  assert.ok(reason > 0 && sales > reason && fundsCol > sales, 'Reason, then Sales amount, then Funds');
  assert.doesNotMatch(funds, /head: 'Amount', n: true, cell: \(f\)/, 'Amount is renamed Funds');
  assert.match(funds, /String\(f\.target_invoice_id \?\? f\.source_invoice_id\)/);
});

// Kept out of every other screen: the shared reseller account fetch and the
// Customers payment form are not where these changes live.
test('the Record payment changes stay inside Record payment', () => {
  const at = app.indexOf('async function recordInvoicePayment');
  const end = app.indexOf('\n}\n', at);
  const outside = app.slice(0, at) + app.slice(end);
  assert.doesNotMatch(outside, /'paid with funds'/);
  assert.doesNotMatch(outside, /head: 'Sales amount'/);
});

// SI26_10_032, paid from Funds: a FUNDS row writes the payment (no MOP) and a
// Funds log draw for the same money. Counted as overflow, the draw doubled the
// Amount (₱2,290 shown as ₱4,580) and showed again as a red Balance. Now the
// payment prints as FUNDS, its Amount is the Funds balance it was drawn from,
// and Balance is what Funds had left — in the Invoice log's own handler only.
test("the Invoice log's invoice shows a Funds payment as the Funds it was drawn from", () => {
  const at = app.indexOf('async function recordInvoicePayment');
  const fn = app.slice(at, app.indexOf('\n}\n', at));
  const handlerAt = fn.indexOf("$$('[data-cilog-invdoc]', box)");
  const handler = fn.slice(handlerAt, fn.indexOf('}));', handlerAt));

  assert.match(handler, /\.filter\(\(f\) => String\(f\.target_invoice_id\) === b\.dataset\.invid\)/,
    "this invoice's own Funds draws");
  assert.match(handler, /const fundsDrift = Number\(acct\.credit \|\| 0\) - fundsLast;/,
    'anchored to the real credit, the same as the Funds log');
  assert.match(handler, /return \{ \.\.\.p, method: 'FUNDS', displayAmount: after \+ Number\(draw\.amount\) \};/,
    'Amount is the Funds balance before the draw');
  assert.match(handler, /: Math\.max\(lastDrawAfter \?\? 0, 0\);/, 'Balance is what Funds had left');
  assert.match(handler, /showInvoiceLogDoc\(\{/);

  // The Funds log's own copy is left exactly as it was.
  const funds = fn.slice(fn.indexOf("$('#ci_funds')"));
  assert.doesNotMatch(funds, /lastDrawAfter|myDraws/);
});

// SI26_10_037, opened from the Funds log: ₱23,800 from Funds + ₱200 BDO. The
// Funds log's own handler counted the Funds draw as overflow too, so the
// FUNDS payment read ₱47,600. Its own copy of the Invoice log's rule now —
// matching what the Invoice log shows for the same invoice.
test("the Funds log's invoice shows a Funds payment the way the Invoice log does", () => {
  const at = app.indexOf('async function recordInvoicePayment');
  const fn = app.slice(at, app.indexOf('\n}\n', at));
  const funds = fn.slice(fn.indexOf("$$('[data-cifunds-invdoc]', fundsBox)"));
  const handler = funds.slice(0, funds.indexOf('}));'));

  assert.match(handler, /String\(f\.source_invoice_id\) === b\.dataset\.invid && !f\.target_invoice_id/,
    'a Funds draw is not overflow');
  assert.match(handler, /\.filter\(\(f\) => String\(f\.target_invoice_id\) === b\.dataset\.invid\)/);
  assert.match(handler, /return \{ \.\.\.p, method: 'FUNDS', displayAmount: left \+ Number\(draw\.amount\) \};/);
  assert.match(handler, /: Math\.max\(leftAfterDraw \?\? 0, 0\);/);
  assert.match(handler, /showFundsLogDoc\(\{/, 'still its own copy of the document');
});

// CO26_10_035's Billing statement: BDO 5989 was ₱85,000 — ₱61,200 onto
// SI26_10_036 and ₱23,800 to Funds. CREDITS shows the whole ₱85,000 and an
// EXCESS TO FUNDS row moves the extra on, so CURRENT BAL still ends on what
// the invoice is owed. Invoice tab's own statement and button only.
test("the Invoice tab's Billing statement credits the whole transfer and moves the excess to Funds", () => {
  const at = app.indexOf('function showInvoiceBillingStatement(');
  const fn = app.slice(at, app.indexOf('\n}\n', at));
  assert.match(fn, /function showInvoiceBillingStatement\(order, payments = \[\], overflow = \[\]\)/);
  assert.match(fn, /const received = Number\(p\.amount\) \+ extra;/);
  assert.match(fn, /<td class="c"><\/td><td class="c">\$\{peso\(received\)\}<\/td>/, 'CREDITS is the whole transfer');
  assert.match(fn, /<td>EXCESS TO FUNDS<\/td>/);
  assert.match(fn, /const bal = \(v\) => \(v < 0 \? `\(\$\{peso\(-v\)\}\)` : peso\(v\)\);/, 'a credit balance in brackets');

  const btn = app.slice(app.indexOf("$$('[data-invbill]', page)"));
  const handler = btn.slice(0, btn.indexOf('}));'));
  assert.match(handler, /String\(f\.source_invoice_id\) === String\(o\.invoice_id\) && !f\.target_invoice_id/);
  assert.match(handler, /showInvoiceBillingStatement\(full, payments, overflow\);/);
  assert.equal((app.match(/showInvoiceBillingStatement\(/g) || []).length, 2, 'still one caller');
});

// Estimated balance sits right after Still owed: Still owed less whatever is
// in the rows, live, never below ₱0.00 — anything past that is Funds. The
// first row keeps its pre-filled owed amount (the owner's choice), so it
// opens on ₱0.00 and moves as soon as an amount is changed.
test('Record payment shows an Estimated balance next to Still owed, live as amounts are typed', () => {
  const at = app.indexOf('async function recordInvoicePayment');
  const fn = app.slice(at, app.indexOf('\n}\n', at));

  const owedAt = fn.indexOf('id="ci_owed"');
  const estAt = fn.indexOf('<div><div class="dim">Estimated balance</div><b id="ci_est">');
  assert.ok(owedAt > 0 && estAt > owedAt, 'right after Still owed');
  assert.match(fn, /est\.textContent = peso\(Math\.max\(estBase - typed, 0\)\)/);
  assert.match(fn, /comma\(el\);\s*\n\s*showEstimate\(\);/, 'recomputed on every keystroke');
  assert.match(fn, /estBase = Number\(mine\.balance \|\| 0\);\s*\n\s*showEstimate\(\);/,
    'and whenever Still owed moves');
});

// Internal Inventory Report's Running stocks: Cost price between Category
// and Quantity, and a Status after it — out of stock, critical at or below
// the shelf minimum (ten where none is set), in stock above. That tab only.
test('Running stocks shows Cost price and a Status', () => {
  const at = app.indexOf("if (inventoryPanel === 'runningstocks')");
  const block = app.slice(at, app.indexOf('\n  }\n', at));
  const heads = [...block.matchAll(/head: '([^']*)'/g)].map((m) => m[1]);
  assert.deepEqual(heads, ['Code', 'Product', 'Brand', 'Category', 'Cost price', 'Quantity', 'Status']);
  assert.match(block, /peso\(p\.unit_cost\)/);
  assert.match(block, /tag\('Out of stock', 'red'\)/);
  assert.match(block, /Number\(p\.shelf_min\) > 0 \? Number\(p\.shelf_min\) : 10/);
  assert.match(block, /tag\('Critical stocks', 'amber'\)/);
  const wh = app.slice(app.indexOf('SCREENS.warehouseinventory = async'));
  assert.doesNotMatch(wh.slice(0, wh.indexOf('\n};\n')), /Critical stocks/, 'Warehouse inventory report is untouched');
});

// A counter over Running stocks — All, Promo, Out of stock, In stock,
// Critical stocks, each with its number — on its own chips, not the
// dashboard's, and nowhere in Warehouse inventory report.
test('Running stocks has its own status counter', () => {
  const at = app.indexOf("if (inventoryPanel === 'runningstocks')");
  const block = app.slice(at, app.indexOf('\n  }\n', at));
  assert.match(block, /class="rschips" id="rs_stf"/);
  assert.match(block, /\[\['os', 'Out of stock'\], \['is', 'In stock'\], \['cs', 'Critical stocks'\]\]/);
  // All and Promo live on the category row, with their counts — its own
  // copy of the chips, not the shared catChips.
  assert.match(block, /All \(<span id="rs_n_all">/);
  assert.match(block, /Promo \(<span id="rs_n_promo">/);
  assert.doesNotMatch(block, /catChips\('cat_rs'\)/);
  assert.match(block, /\$\{l\} \(\$\{count\(n\[k\]\)\}\)/);
  assert.doesNotMatch(block, /dashchips/);
  const wh = app.slice(app.indexOf('SCREENS.warehouseinventory = async'));
  assert.doesNotMatch(wh.slice(0, wh.indexOf('\n};\n')), /rschips/);
});

// The dashboard no longer carries a Product stock table — the owner asked
// for it gone; Running stocks is where stock is read now.
test('the dashboard has no Product stock table', () => {
  const at = app.indexOf('SCREENS.dashboard = async');
  const fn = app.slice(at, app.indexOf('\n};\n', at));
  assert.doesNotMatch(fn, /Product stock|dash_stock|dash_stf|dash_q|drawStock/);
  assert.match(fn, /Recent invoices/, 'the rest of the dashboard stays');
});

// Internal Inventory Report's Inventory stock value report: its own tab next
// to Running stocks, its own copy of the code, quantity × cost price.
test('Inventory stock value report sits after Running stocks with its own columns', () => {
  assert.match(app, /\['runningstocks', 'Running stocks'\],\n    \['stockvalue', 'Inventory stock value report'\],/);
  const at = app.indexOf("if (inventoryPanel === 'stockvalue')");
  const block = app.slice(at, app.indexOf('\n  }\n', at));
  const heads = [...block.matchAll(/head: '([^']*)'/g)].map((m) => m[1]);
  assert.deepEqual(heads, ['Code', 'Product', 'Brand', 'Quantity', 'Cost price', 'Value', 'Status']);
  assert.match(block, /const worth = \(p\) => Math\.max\(available\(p\), 0\) \* Number\(p\.unit_cost \|\| 0\)/);
  assert.doesNotMatch(block, /rs_find|cat_rs|rs_stf/, 'its own ids, not Running stocks\'');
  const wh = app.slice(app.indexOf('SCREENS.warehouseinventory = async'));
  assert.doesNotMatch(wh.slice(0, wh.indexOf('\n};\n')), /stockvalue/, 'Warehouse inventory report is untouched');
});

test('Inventory stock value report ends with Download and the total value', () => {
  const at = app.indexOf("if (inventoryPanel === 'stockvalue')");
  const block = app.slice(at, app.indexOf('\n  }\n', at));
  assert.match(block, /<div id="r_value"><\/div>\s*<div class="svfoot"><button class="btn sm" id="sv_dl">⬇ Download<\/button>\s*<span>Total value/);
  assert.match(block, /a\.download = `inventory-stock-value-\$\{localDay\(\)\}\.csv`/);
});

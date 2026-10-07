// Somebody who leaves partway through a cutoff is still owed the days they
// worked in it. A cutoff takes on everybody still here on any day of it, and
// one already open can have a missing person added — by the same rule, so
// the two never count differently.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { hashPassword } from '../lib/auth.js';
import { server } from '../scripts/dev.js';
import { pool } from '../lib/db.js';

const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 });
let base;
let admin;

test.before(async () => {
  await new Promise((done) => server.listen(0, done));
  base = `http://127.0.0.1:${server.address().port}`;
  const username = `leavers-admin-${process.pid}-${Date.now()}`;
  await db.query(
    `insert into app_users (username, display_name, password_hash, role)
     values ($1,$1,$2,'admin')`, [username, hashPassword('secret123')]);
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'secret123' }),
  });
  assert.equal(res.status, 200);
  admin = (res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie')).split(';')[0];
});
test.after(async () => {
  await new Promise((done) => server.close(done));
  await pool.end();
  await db.end();
});

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: admin },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

// A cutoff of its own, far from anybody else's, so no other test's people or
// periods get in the way.
let year = 2090 + (process.pid % 40);
const cutoff = () => {
  year += 1;
  return { from: `${year}-03-11`, to: `${year}-03-25` };
};

async function person(name, { company = 'BOA', left = null } = {}) {
  const r = await db.query(
    `insert into employees (name, position, company, daily_rate, ended_on, branch_id)
     values ($1, 'Beauty Consultant', $2, 600, $3, (select id from branches order by id limit 1))
     returning id`,
    [`${name} ${process.pid}-${Date.now()}`, company, left]);
  return Number(r.rows[0].id);
}

async function worked(id, ...days) {
  for (const d of days) {
    await db.query(
      `insert into shifts (employee_id, business_date, started_at, ended_at)
       values ($1, $2::date, $2::date + time '09:00', $2::date + time '17:00')`, [id, d]);
  }
}

const lineFor = async (period, id) => (await db.query(
  'select * from payroll_lines where period_id = $1 and employee_id = $2', [period, id])).rows[0];

test('a cutoff opened after somebody left still pays them for the days they worked in it', async () => {
  const { from, to } = cutoff();
  const leaver = await person('Leaver', { left: `${year}-03-14` });
  await worked(leaver, `${year}-03-11`, `${year}-03-12`, `${year}-03-13`);
  // A cash advance still running comes off their final cutoff like anybody's.
  await db.query(
    `insert into advances (employee_id, kind, principal, per_cutoff, started_on)
     values ($1, 'ca', 1000, 250, $2)`, [leaver, from]);

  const gone = await person('Long gone', { left: `${year}-02-01` });
  await worked(gone, `${year}-01-20`);

  const opened = await call('POST', '/api/payroll', { company: 'BOA', starts_on: from, ends_on: to });
  assert.equal(opened.status, 200, JSON.stringify(opened.data));

  const line = await lineFor(opened.data.id, leaver);
  assert.ok(line, 'somebody who left during the cutoff is on it');
  assert.equal(Number(line.days_present), 3, 'only the days they actually worked');
  assert.equal(Number(line.ca_amount), 250, 'their running cash advance comes off');

  assert.equal(await lineFor(opened.data.id, gone), undefined,
    'somebody who left before the cutoff began is not on it');

  const read = await call('GET', `/api/payroll?id=${opened.data.id}`);
  const row = read.data.lines.find((l) => Number(l.employee_id) === leaver);
  assert.ok(row.left_on, 'the screen is told they have left, to mark it as final pay');
});

test('somebody missing from an open cutoff can be added, by the same rule', async () => {
  const { from, to } = cutoff();
  const opened = await call('POST', '/api/payroll', { company: 'BOA', starts_on: from, ends_on: to });
  assert.equal(opened.status, 200, JSON.stringify(opened.data));
  const period = opened.data.id;

  // Put on the team after the cutoff opened, worked two days, then left.
  const late = await person('Late leaver', { left: `${year}-03-20` });
  await worked(late, `${year}-03-16`, `${year}-03-17`);
  await db.query(
    `insert into advances (employee_id, kind, loan_type, principal, per_cutoff, started_on)
     values ($1, 'sss', 'salary', 500, 200, $2)`, [late, from]);
  const before = await person('Before it began', { left: `${year}-03-01` });
  const other = await person('Other company', { company: 'MS BEAU' });

  const list = await call('GET', `/api/payroll?id=${period}`);
  const offered = list.data.addable.map((p) => Number(p.id));
  assert.ok(offered.includes(late), 'offered: still here on some day of the cutoff');
  assert.ok(!offered.includes(before), 'not offered: left before it began');
  assert.ok(!offered.includes(other), 'not offered: the other company');

  const added = await call('POST', `/api/payroll/${period}/people`, { employee_id: late });
  assert.equal(added.status, 200, JSON.stringify(added.data));
  const line = await lineFor(period, late);
  assert.equal(Number(line.days_present), 2);
  assert.equal(Number(line.sss_salary_amount), 200, 'their loan due this cutoff comes off');

  const again = await call('POST', `/api/payroll/${period}/people`, { employee_id: late });
  assert.notEqual(again.status, 200, 'never twice');
  const taken = await db.query(
    `select count(*)::int as n from advance_payments ap join advances a on a.id = ap.advance_id
      where a.employee_id = $1 and ap.period_id = $2`, [late, period]);
  assert.equal(taken.rows[0].n, 1, 'the loan is taken once, not again');

  for (const id of [before, other]) {
    const refused = await call('POST', `/api/payroll/${period}/people`, { employee_id: id });
    assert.notEqual(refused.status, 200, 'the database refuses what the list never offered');
  }

  await call('POST', `/api/payroll/${period}/close`, {});
  const closed = await call('GET', `/api/payroll?id=${period}`);
  assert.deepEqual(closed.data.addable, [], 'nothing is offered on a closed cutoff');
});

test('the cutoff opening picks up leavers through the one shared rule', async () => {
  const fs = await import('node:fs');
  const sql = fs.readFileSync(new URL('../db/175_payroll_keeps_leavers.sql', import.meta.url), 'utf8');
  assert.match(sql, /perform payroll_take_on\(v_id, null\)/, 'open_payroll goes through payroll_take_on');
  assert.match(sql, /perform payroll_take_on\(p_period, p_employee\)/, 'and so does add_to_payroll');
});

test('"They have left" takes the real last day and why, and can be undone', async () => {
  const id = await person('Walked out');
  const day = '2026-10-01';
  await db.query("update employees set started_on = '2025-01-06' where id = $1", [id]);

  const left = await call('POST', `/api/team/${id}/left`, { on: day, reason: 'resigned' });
  assert.equal(left.status, 200, JSON.stringify(left.data));
  let row = (await db.query('select ended_on::text, separation_reason from employees where id = $1', [id])).rows[0];
  assert.equal(row.ended_on, day, 'the day picked, not today');
  assert.equal(row.separation_reason, 'resigned');

  const team = await call('GET', '/api/team');
  const shown = team.data.team.find((p) => Number(p.id) === id);
  assert.equal(shown.separation_reason, 'resigned', 'the Team list is told why');

  const typed = await call('POST', `/api/team/${id}/left`, { on: day, reason: 'aaaaa' });
  assert.notEqual(typed.status, 200, 'a reason not on the list is refused');
  const early = await call('POST', `/api/team/${id}/left`, { on: '2024-01-01', reason: 'resigned' });
  assert.notEqual(early.status, 200, 'cannot leave before they started');

  const back = await call('POST', `/api/team/${id}/back`, {});
  assert.equal(back.status, 200, JSON.stringify(back.data));
  row = (await db.query('select ended_on, separation_reason from employees where id = $1', [id])).rows[0];
  assert.equal(row.ended_on, null, 'back on the team');
  assert.equal(row.separation_reason, null);
  assert.notEqual((await call('POST', `/api/team/${id}/back`, {})).status, 200,
    'nothing to undo for somebody still here');

  // Pressed with nothing chosen still works, dated today, as it always did.
  assert.equal((await call('POST', `/api/team/${id}/left`, {})).status, 200);
});

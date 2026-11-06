import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOmpAccounts, ompIdentity, ompProgram, ompWindows, outUntil } from '../../server/omp-accounts.mjs';
import { fakeOmpAuth, fakeOmpConfig } from '../e2e/fake-omp.mjs';

const FAKE = path.resolve('tests/e2e/fake-omp.mjs');

function setup(email = 'user@example.com', more = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'office-omp-')), seat = path.join(root, 'seat'), fake = path.join(root, 'fake');
  fs.mkdirSync(seat); fs.mkdirSync(fake);
  if (email) {
    fs.writeFileSync(path.join(seat, 'auth.json'), JSON.stringify(fakeOmpAuth(email)));
    fs.writeFileSync(path.join(seat, 'config.yml'), fakeOmpConfig('claude-sonnet-4'));
  }
  process.env.FAKE_OMP_DIR = fake;
  const changes = [];
  const o = createOmpAccounts({ dir: path.join(root, 'office'), seat: () => seat, bin: () => FAKE, onChange: (w) => changes.push(w || {}), ...more });
  const usage = (mail, u) => fs.writeFileSync(path.join(fake, `${mail}.json`), JSON.stringify(u));
  const seatEmail = () => {
    try {
      const a = JSON.parse(fs.readFileSync(path.join(seat, 'auth.json'), 'utf8'));
      return ompIdentity(a)?.email;
    } catch { return ''; }
  };
  return { o, root, seat, fake, changes, usage, seatEmail };
}

const idOf = (o, email) => o.out().list.find((a) => a.email === email)?.id;
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };

test('reading omp auth & config: identity, plan, model, usage windows, outUntil', () => {
  const cfg = fakeOmpConfig('claude-sonnet-4', 'haiku');
  const auth = fakeOmpAuth('dev@example.com', 'kilo', 'pro', 'claude-sonnet-4');
  const who = ompIdentity(auth, cfg);
  assert.equal(who.email, 'dev@example.com');
  assert.equal(who.plan, 'pro');
  assert.equal(who.model, 'claude-sonnet-4');
  assert.equal(who.provider, 'kilo');

  const now = 1_800_000_000_000;
  const ws = ompWindows({ primary: { usedPercent: 99, windowDurationMins: 300, resetsAt: now / 1000 + 600 } });
  assert.equal(ws[0].pct, 99);
  assert.equal(outUntil({ windows: ws }, now), now + 600_000);
  assert.equal(outUntil({ windows: ws }, now + 700_000), 0);

  assert.equal(ompProgram('/Users/dev/bin/omp --model opus'), 'terminal');
  assert.equal(ompProgram('/Users/dev/.vscode/extensions/omp-ext/bin/omp.sh'), 'VS Code');
  assert.equal(ompProgram('/usr/bin/something-else'), '');
});

test('seat account is added by itself, read, and switched to another with newest tokens kept', async () => {
  const { o, changes, usage, seatEmail, fake } = setup('a@example.com');
  await o.syncSeat();
  const a = idOf(o, 'a@example.com');
  assert.ok(a);
  assert.equal(o.out().now, a);
  await o.read(a);

  // second account
  fs.writeFileSync(path.join(fake, 'next-login'), 'b@example.com');
  const L = o.addStart();
  assert.equal(L.state, 'waiting');
  assert.ok(await until(() => o.out().login?.state === 'done'), 'the sign-in finished');
  const b = idOf(o, 'b@example.com');
  assert.ok(b);
  assert.equal(seatEmail(), 'a@example.com');

  // switch to B
  const r = await o.switchTo(b);
  assert.ok(r.ok);
  assert.equal(seatEmail(), 'b@example.com');
  assert.equal(o.out().now, b);
  assert.ok(changes.some((w) => w.switched?.to === b && w.switched.why === 'you'));

  usage('b@example.com', { primary: 30 });
  await o.switchTo(a);
  assert.equal(seatEmail(), 'a@example.com');

  assert.equal((await o.remove(a)).code, 'inSeat');
  assert.ok((await o.remove(b)).ok);
  assert.equal(o.out().list.length, 1);
  o.stop();
});

test('autoSwitch moves to next account when active runs out', async () => {
  const { o, usage, seatEmail, fake } = setup('a@example.com');
  await o.syncSeat();
  const a = idOf(o, 'a@example.com');

  fs.writeFileSync(path.join(fake, 'next-login'), 'b@example.com');
  o.addStart();
  assert.ok(await until(() => o.out().login?.state === 'done'));
  const b = idOf(o, 'b@example.com');
  await o.read(b);

  o.setAuto(true);
  usage('a@example.com', { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 } });
  await o.read(a);
  assert.ok(await until(() => seatEmail() === 'b@example.com'), 'seat moved to B');
  o.stop();
});

test('older processes running on former account detected', async () => {
  let started = 0;
  const { o, fake } = setup('a@example.com', { procs: async () => (started ? [{ pid: 5555, start: started, args: '/Users/dev/.cursor/extensions/bin/omp' }] : []) });
  await o.syncSeat();
  const a = idOf(o, 'a@example.com');

  fs.writeFileSync(path.join(fake, 'next-login'), 'b@example.com');
  o.addStart();
  assert.ok(await until(() => o.out().login?.state === 'done'));
  const b = idOf(o, 'b@example.com');

  started = Math.floor(Date.now() / 1000) - 60;
  const r = await o.switchTo(b);
  assert.deepEqual(r.older.map((p) => [p.where, p.id]), [['Cursor', a]]);
  assert.deepEqual(o.out().older, [{ where: 'Cursor', id: a }]);
  o.stop();
});

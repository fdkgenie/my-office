// "Nhiều tài khoản Oh My Pi": the accounts and profiles Oh My Pi (omp.sh) uses.
// OMP stores its configuration and auth in $OMP_HOME or $PI_CODING_AGENT_DIR (~/.omp/agent): the seat.
// Each account the office knows has a copy of its own in <dir>/<id>/, so switching updates config.yml / auth.json
// in the seat. With switching on, the seat moves to the next account with room when the one in it runs out.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const FULL = 98;   // a window this used: the account is out until it resets
const SEAT_EVERY = 2 * 60e3, SEAT_IDLE_EVERY = 10 * 60e3, OTHER_EVERY = 20 * 60e3, SIGNED_OUT_EVERY = 6 * 3600e3;

/** A JWT's claims (not verified: only to name the account), {} when it isn't one. */
export function jwtClaims(t) {
  try { return JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString('utf8')) || {}; } catch { return {}; }
}

/** Parses modelRoles.default from a config.yml string */
export function parseConfigModel(text) {
  if (typeof text !== 'string') return '';
  const m = /^\s*default:\s*['"]?([^'"\r\n]+)['"]?/m.exec(text) || /^\s*model:\s*['"]?([^'"\r\n]+)['"]?/m.exec(text);
  return m ? m[1].trim() : '';
}

/** The Oh My Pi account identity from credentials and config: { key, email, name, plan, provider, model }; null for none. */
export function ompIdentity(auth, configText = '') {
  const model = parseConfigModel(configText);
  if (!auth && !model) return null;
  let cred = auth;
  if (auth && Array.isArray(auth.credentials) && auth.credentials.length > 0) {
    const found = auth.credentials.find((x) => x.email || x.credential?.email || x.credential?.access || x.access) || auth.credentials[0];
    cred = found;
  }
  const token = cred?.credential?.access || cred?.credential?.access_token || cred?.access || cred?.access_token || '';
  const c = token ? jwtClaims(token) : {};
  const email = cred?.email || c.email || (c.kiloUserId ? `kilo:${c.kiloUserId.slice(0, 8)}` : '');
  const name = cred?.name || c.name || (email ? email.split('@')[0] : '') || cred?.provider || 'omp';
  const provider = cred?.provider || 'omp';
  const plan = cred?.plan || cred?.type || provider;
  const user = cred?.user || c.sub || email || name || (model ? `profile-${model}` : '');
  if (!user && !email && !model) return null;
  const key = `${provider}|${user}|${email}`;
  return { key, email, name, plan, provider, model: cred?.model || model };
}

const ms = (t) => (!t ? 0 : t < 1e12 ? t * 1000 : t);

/** OMP usage windows as limit rows: session window, then weekly or per-model quota. */
export function ompWindows(r) {
  if (!r) return [];
  const s = r?.rateLimits || r?.limits || r || {}, out = [];
  for (const [w, guess, label] of [[s.primary, 'session', 'Session'], [s.secondary, 'weekly', 'Weekly']]) {
    if (!w || typeof w.usedPercent !== 'number') continue;
    const mins = w.windowDurationMins || 0;
    out.push({ key: mins ? (mins <= 24 * 60 ? 'session' : 'weekly') : guess, label, mins, pct: Math.max(0, Math.min(100, w.usedPercent)), resetsAt: ms(w.resetsAt) });
  }
  if (!out.length && typeof s.primary === 'number') {
    out.push({ key: 'session', label: 'Session', mins: 300, pct: Math.max(0, Math.min(100, s.primary)), resetsAt: ms(s.resetsAt || Date.now() + 300 * 60e3) });
  }
  return out;
}

/** Until when an account can't be used: a window nearly used up, or limit reached; 0 = it has room. */
export function outUntil(a, now = Date.now()) {
  let until = 0;
  const live = (a.windows || []).filter((w) => w.resetsAt > now);
  for (const w of live) if (w.pct >= FULL) until = Math.max(until, w.resetsAt);
  if (a.reached && a.at) until = Math.max(until, ...live.map((w) => w.resetsAt), a.at + 15 * 60e3);
  return until > now ? until : 0;
}

const EDITORS = [['.antigravity-ide', 'Antigravity IDE'], ['.antigravity', 'Antigravity'], ['.vscode-insiders', 'VS Code Insiders'], ['.vscode', 'VS Code'], ['.cursor', 'Cursor'], ['.windsurf', 'Windsurf'], ['.kiro', 'Kiro'], ['.trae', 'Trae']];

/** Detect if running process is omp or omp.sh */
export function ompProgram(args) {
  const a = String(args || '');
  if (!/(^|[\\/])omp(\.exe|\.sh)?( |$)/.test(a)) return '';
  const ed = EDITORS.find(([dot]) => a.includes(`${path.sep}${dot}${path.sep}`) || a.includes(`/${dot}/`));
  return ed ? ed[1] : 'terminal';
}

/**
 * @param {{ dir: string, seat: () => string, bin: () => (string | null), procs?: () => Promise<{ pid: number, start: number, args: string }[]>,
 *   openUrl?: (url: string) => void, now?: () => number, log?: (s: string) => void, onChange?: (what?: object) => void }} o
 */
export function createOmpAccounts({ dir, seat, bin, procs = async () => [], openUrl = () => {}, now = Date.now, log = () => {}, onChange = () => {} }) {
  const FILE = path.join(dir, 'accounts.json');
  let st = { list: [], order: [], auto: false, tenure: [] };
  try { st = { ...st, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { /* none yet */ }
  const save = () => { try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(st), { mode: 0o600 }); } catch { /* read-only data */ } };
  const home = (id) => path.join(dir, id);
  const find = (id) => st.list.find((a) => a.id === id);
  const seatConfig = () => path.join(seat(), 'config.yml');
  const seatAuth = () => {
    const f1 = path.join(seat(), 'auth.json');
    if (fs.existsSync(f1)) return f1;
    const f2 = path.join(seat(), 'credentials.json');
    return fs.existsSync(f2) ? f2 : f1;
  };

  let seatId = null, seatText = null, seatNote = '', running = [], login = null;
  const mine = new Set();

  async function writeSecret(file, text) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.office-tmp`;
    await fsp.writeFile(tmp, text, { mode: 0o600 });
    await fsp.rename(tmp, file);
  }

  async function keep(id, authText, cfgText) {
    if (authText) {
      const f = path.join(home(id), 'auth.json');
      let was = null; try { was = await fsp.readFile(f, 'utf8'); } catch { /* new */ }
      if (was !== authText) await writeSecret(f, authText);
    }
    if (cfgText) {
      const f = path.join(home(id), 'config.yml');
      let was = null; try { was = await fsp.readFile(f, 'utf8'); } catch { /* new */ }
      if (was !== cfgText) await writeSecret(f, cfgText);
    }
  }

  function addAccount(who) {
    let id = crypto.createHash('sha256').update(who.key).digest('hex').slice(0, 10);
    while (find(id)) id += 'x';
    const a = { id, key: who.key, email: who.email, name: who.name, plan: who.plan, model: who.model || '', label: '', windows: [], reached: false, at: 0, note: '', tried: 0 };
    st.list.push(a); st.order.push(id);
    log(`omp: account added (${who.email || who.name || id})`);
    return a;
  }

  async function readSeatAuthText() {
    let authText = '';
    try { authText = await fsp.readFile(seatAuth(), 'utf8'); } catch { /* none */ }
    if (!authText) {
      const dbPath = path.join(seat(), 'agent.db');
      if (fs.existsSync(dbPath)) {
        try {
          const { DatabaseSync } = await import('node:sqlite');
          const db = new DatabaseSync(dbPath, { readOnly: true });
          const rows = db.prepare('SELECT provider, credential_type, data FROM auth_credentials WHERE disabled_cause IS NULL').all();
          const credentials = rows.map((r) => ({ provider: r.provider, credential: { type: r.credential_type, ...JSON.parse(r.data) } }));
          db.close();
          if (credentials.length) authText = JSON.stringify({ version: 1, credentials });
        } catch { /* SQLite unavailable or unreadable */ }
      }
    }
    return authText;
  }

  async function syncSeat() {
    let authText = '', cfgText = '';
    authText = await readSeatAuthText();
    try { cfgText = await fsp.readFile(seatConfig(), 'utf8'); } catch { /* none */ }
    const combined = `${authText}\n---config---\n${cfgText}`;
    if (combined === seatText) return;
    seatText = combined;
    let auth = null; try { auth = JSON.parse(authText); } catch { /* not JSON */ }
    const who = ompIdentity(auth, cfgText);
    seatNote = (!authText && !cfgText) ? 'signedOut' : !who ? (auth?.apiKey ? 'apiKey' : 'unknown') : '';
    let a = who && st.list.find((x) => x.key === who.key);
    if (who && !a) a = addAccount(who);
    if (a) {
      Object.assign(a, {
        email: who.email || a.email,
        name: who.name || a.name,
        plan: who.plan || a.plan,
        model: who.model || a.model,
      });
      await keep(a.id, authText, cfgText).catch(() => {});
    }
    const was = seatId; seatId = a?.id || null;
    if (seatId !== (st.tenure.at(-1)?.id ?? null)) {
      st.tenure.push({ id: seatId, from: st.tenure.length ? now() : 0 });
      st.tenure = st.tenure.slice(-12);
    }
    save();
    if (seatId !== was) { onChange(); if (a && !a.at) readSoon(a.id); }
  }

  const accountAt = (t) => { let id = null; for (const x of st.tenure) if (x.from <= t * 1000) id = x.id; return id; };
  async function look() {
    const list = await procs().catch(() => []);
    running = list.filter((p) => !mine.has(p.pid)).map((p) => ({ pid: p.pid, where: ompProgram(p.args), id: accountAt(p.start) })).filter((p) => p.where);
  }

  let queue = Promise.resolve();
  function read(id) { queue = queue.then(() => readNow(id)).catch(() => {}); return queue; }
  async function readNow(id) {
    const a = find(id); if (!a) return;
    a.tried = now();
    const inSeat = id === seatId;
    if (!inSeat && running.some((p) => p.id === id)) return;

    // Check usage file in test/fake or home dir if exists
    let usage = null;
    const fakeDir = process.env.FAKE_OMP_DIR;
    if (fakeDir && a.email) {
      try { usage = JSON.parse(fs.readFileSync(path.join(fakeDir, `${a.email}.json`), 'utf8')); } catch { /* none */ }
    }
    if (!usage) {
      try {
        const uFile = path.join(inSeat ? seat() : home(id), 'usage.json');
        usage = JSON.parse(await fsp.readFile(uFile, 'utf8'));
      } catch { /* none */ }
    }

    if (usage) {
      a.windows = ompWindows(usage);
      a.reached = !!usage.reached;
      a.at = now();
      a.note = '';
      if (usage.model) a.model = usage.model;
    } else {
      a.at = now();
      a.note = '';
    }

    if (inSeat) await syncSeat();
    save(); onChange();
    if (inSeat) autoSwitch();
  }
  const readSoon = (id) => setTimeout(() => read(id), 300).unref?.();

  const ordered = () => [...st.list].sort((x, y) => st.order.indexOf(x.id) - st.order.indexOf(y.id));

  async function switchTo(id, why = 'you') {
    const a = find(id); if (!a) return { ok: false, code: 'noAccount' };
    await syncSeat();
    if (id === seatId) return { ok: true, same: true };

    const from = seatId;
    let authCopy = '', cfgCopy = '';
    try { authCopy = await fsp.readFile(path.join(home(id), 'auth.json'), 'utf8'); } catch { /* optional */ }
    try { cfgCopy = await fsp.readFile(path.join(home(id), 'config.yml'), 'utf8'); } catch { /* optional */ }
    if (!authCopy && !cfgCopy) return { ok: false, code: 'noCopy' };

    try {
      if (authCopy) await writeSecret(seatAuth(), authCopy);
      if (cfgCopy) await writeSecret(seatConfig(), cfgCopy);
    } catch {
      return { ok: false, code: 'seatFailed' };
    }

    seatText = `${authCopy}\n---config---\n${cfgCopy}`;
    seatId = id; seatNote = '';
    st.tenure.push({ id, from: now() }); st.tenure = st.tenure.slice(-12); save();
    log(`omp: ${from || '-'} -> ${id} (${why})`);
    await look();
    onChange({ switched: { from, to: id, why, until: from ? outUntil(find(from) || {}, now()) : 0 } });
    readSoon(id);
    return { ok: true, older: running.filter((p) => p.id !== id) };
  }

  let switching = false;
  async function autoSwitch() {
    const a = find(seatId);
    if (!st.auto || !a || switching || !outUntil(a, now())) return;
    const next = ordered().find((x) => x.id !== a.id && x.note !== 'signedOut' && !outUntil(x, now()));
    if (!next) return;
    switching = true;
    try { await switchTo(next.id, 'auto'); } finally { switching = false; }
  }

  function addStart() {
    if (login?.state === 'waiting') return loginOut();
    const b = bin();
    if (!b) { login = { state: 'failed', note: 'noCli' }; return loginOut(); }
    const tmp = path.join(dir, `_login-${now().toString(36)}`);
    fs.mkdirSync(tmp, { recursive: true });

    let child;
    const js = /\.m?js$/.test(b);
    try {
      child = spawn(js ? process.execPath : b, [...(js ? [b] : []), 'login'], { env: { ...process.env, PI_CODING_AGENT_DIR: tmp, OMP_HOME: tmp }, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      login = { state: 'failed', note: 'noCli' }; return loginOut();
    }
    mine.add(child.pid);
    const L = login = { state: 'waiting', url: '', note: '', name: '', child, tmp };
    const end = (state, note = '') => {
      if (L.state !== 'waiting') return;
      Object.assign(L, { state, note }); clearTimeout(L.timer);
      try { child.kill(); } catch { /* gone */ }
      mine.delete(child.pid);
      setTimeout(() => fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}), 1500).unref?.();
      onChange();
    };
    L.timer = setTimeout(() => end('failed', 'timeout'), 15 * 60e3); L.timer.unref?.();

    child.on('error', () => end('failed', 'noCli'));
    child.stdout?.on('data', (d) => {
      const text = String(d || '');
      const m = text.match(/https?:\/\/[^\s]+/);
      if (m && !L.url) {
        L.url = m[0];
        openUrl(L.url);
        onChange();
      }
    });
    child.on('exit', async () => {
      let authText = '', cfgText = '';
      try { authText = await fsp.readFile(path.join(tmp, 'auth.json'), 'utf8'); } catch { /* check credentials.json */ }
      if (!authText) {
        try { authText = await fsp.readFile(path.join(tmp, 'credentials.json'), 'utf8'); } catch { /* none */ }
      }
      try { cfgText = await fsp.readFile(path.join(tmp, 'config.yml'), 'utf8'); } catch { /* none */ }
      let auth = null; try { auth = JSON.parse(authText); } catch { /* not JSON */ }
      const who = ompIdentity(auth, cfgText);
      if (!who) { end('failed', 'noAuth'); return; }
      let a = st.list.find((x) => x.key === who.key);
      if (a && a.id === seatId) { L.name = who.email || who.name; end('done'); return; }
      if (!a) a = addAccount(who);
      Object.assign(a, { email: who.email, name: who.name, plan: who.plan || a.plan, model: who.model || a.model, note: '' });
      await keep(a.id, authText, cfgText);
      save(); readSoon(a.id);
      L.name = who.email || who.name;
      end('done');
    });

    return loginOut();
  }

  function addCancel() {
    if (login?.state !== 'waiting') return;
    const L = login;
    L.state = 'cancelled';
    try { L.child.kill(); } catch { /* gone */ }
    mine.delete(L.child.pid);
    fsp.rm(L.tmp, { recursive: true, force: true }).catch(() => {});
    onChange();
  }

  const loginOut = () => (login ? { state: login.state, url: login.url || '', note: login.note || '', name: login.name || '' } : null);

  async function remove(id) {
    const a = find(id); if (!a) return { ok: false, code: 'noAccount' };
    if (id === seatId) return { ok: false, code: 'inSeat' };
    st.list = st.list.filter((x) => x !== a); st.order = st.order.filter((x) => x !== id); save();
    await fsp.rm(home(id), { recursive: true, force: true }).catch(() => {});
    log(`omp: account removed (${a.email || a.name || id})`);
    onChange();
    return { ok: true };
  }

  function rename(id, label) { const a = find(id); if (!a) return { ok: false }; a.label = String(label || '').slice(0, 24); save(); onChange(); return { ok: true }; }
  function setAuto(on) { st.auto = !!on; save(); onChange(); if (st.auto) autoSwitch(); return { ok: true }; }
  function setOrder(ids) {
    const all = st.list.map((a) => a.id);
    if (!Array.isArray(ids) || ids.length !== all.length || !all.every((x) => ids.includes(x))) return { ok: false };
    st.order = [...ids]; save(); onChange(); return { ok: true };
  }

  function out() {
    const t = now();
    const cur = find(seatId);
    return {
      cli: !!bin(), seat: seatNote, now: seatId, auto: !!st.auto, login: loginOut(),
      model: cur?.model || '',
      list: ordered().map((a) => ({
        id: a.id, email: a.email, name: a.name, plan: a.plan, label: a.label, model: a.model,
        at: a.at, note: a.note,
        windows: (a.windows || []).filter((w) => !w.resetsAt || w.resetsAt > t),
        until: outUntil(a, t),
      })),
      older: running.filter((p) => p.id !== seatId).map((p) => ({ where: p.where, id: p.id })),
    };
  }

  async function tick() {
    await syncSeat(); await look();
    const t = now(), busy = running.length > 0;
    for (const a of ordered()) {
      const every = a.note === 'signedOut' ? SIGNED_OUT_EVERY : a.id === seatId ? (busy ? SEAT_EVERY : SEAT_IDLE_EVERY) : OTHER_EVERY;
      if (t - (a.tried || 0) >= every) read(a.id);
    }
  }

  const timers = [];
  function start() {
    syncSeat().then(tick).catch(() => {});
    timers.push(setInterval(() => syncSeat().catch(() => {}), 10_000), setInterval(() => tick().catch(() => {}), 60_000));
    for (const x of timers) x.unref?.();
  }
  function stop() { for (const x of timers) clearInterval(x); if (login?.state === 'waiting') addCancel(); }

  return { start, stop, out, switchTo, read, addStart, addCancel, remove, rename, setAuto, setOrder, syncSeat, tick, autoSwitch, seatNow: () => seatId };
}

#!/usr/bin/env node
// A stand-in for `omp` (server/omp-accounts.mjs speaks to it): OMP's CLI operations,
// credentials in $OMP_HOME/auth.json (or credentials.json) and config in $OMP_HOME/config.yml.
// Usage comes from $FAKE_OMP_DIR/<email>.json ({ primary, secondary, reached }),
// 10% and 5% otherwise; each call is noted in $FAKE_OMP_DIR/calls.log as "<OMP_HOME> <args>".
// Signing in writes credentials for $FAKE_OMP_DIR/next-login a moment after it starts.
import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.PI_CODING_AGENT_DIR || process.env.OMP_HOME || '', DIR = process.env.FAKE_OMP_DIR || '';
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

export function fakeOmpAuth(email = 'dev@example.com', provider = 'kilo', plan = 'pro', model = 'claude-sonnet-4') {
  const jwt = (claims) => `${b64({ alg: 'none' })}.${b64(claims)}.sig`;
  return {
    version: 1,
    credentials: [
      {
        provider,
        type: 'oauth',
        email,
        name: email.split('@')[0],
        plan,
        model,
        credential: {
          access: jwt({ email, name: email.split('@')[0], sub: `user-${email}` }),
          refresh: `refresh-${email}`,
          expires: Date.now() + 864000_000,
          authorizedAt: Date.now(),
        },
      },
    ],
  };
}

export function fakeOmpConfig(model = 'claude-sonnet-4', advisor = 'claude-haiku-4') {
  return [
    'modelRoles:',
    `  default: ${model}`,
    `  advisor: ${advisor}`,
    'theme:',
    '  dark: titanium',
    'composer:',
    '  shape: claude',
    '',
  ].join('\n');
}

const emailOf = () => {
  try {
    const raw = read(path.join(HOME, 'auth.json')) || read(path.join(HOME, 'credentials.json'));
    if (!raw) return '';
    const j = JSON.parse(raw);
    const cred = Array.isArray(j.credentials) ? j.credentials[0] : j;
    if (cred?.email) return cred.email;
    const t = cred?.credential?.access || cred?.access;
    if (t) return JSON.parse(Buffer.from(t.split('.')[1], 'base64url')).email || '';
  } catch { /* ignored */ }
  return '';
};

const args = process.argv.slice(2);
if (DIR) fs.appendFileSync(path.join(DIR, 'calls.log'), `${HOME} ${args.join(' ')}\n`);

if (args.includes('--version') || args.includes('-v')) {
  process.stdout.write('omp/18.12.6\n');
} else if (args[0] === 'auth' && args[1] === 'export') {
  const email = emailOf() || 'default@example.com';
  process.stdout.write(`${JSON.stringify(fakeOmpAuth(email))}\n`);
} else if (args[0] === 'models' && args.includes('--json')) {
  process.stdout.write(JSON.stringify([{ id: 'claude-sonnet-4', name: 'Claude Sonnet 4' }, { id: 'cb-gemini', name: 'Gemini Flash' }]) + '\n');
} else if (args[0] === 'config' && args[1] === 'list' && args.includes('--json')) {
  process.stdout.write(JSON.stringify({ modelRoles: { value: { default: 'claude-sonnet-4' } } }) + '\n');
} else if (args[0] === 'login') {
  const next = (DIR && read(path.join(DIR, 'next-login')).trim()) || 'new@example.com';
  if (HOME) {
    fs.mkdirSync(HOME, { recursive: true });
    fs.writeFileSync(path.join(HOME, 'auth.json'), JSON.stringify(fakeOmpAuth(next)));
    fs.writeFileSync(path.join(HOME, 'config.yml'), fakeOmpConfig('claude-sonnet-4'));
  }
  process.stdout.write(`Logged in as ${next}\n`);
}

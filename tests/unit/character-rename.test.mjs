import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPrefs } from '../../server/prefs.mjs';

const dn = (s) => (s ? s.title || s.name : '');

test('renaming character updates display name and persists in prefs', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'office-char-test-'));
  try {
    const prefs = createPrefs(tmp);
    const session = { id: 's-1', sid: 'claude-sid-123', name: 'my-project-01', title: '' };

    // Default display name is short name
    assert.equal(dn(session), 'my-project-01');

    // Rename character and store in prefs
    const map = { ...(prefs.get('characterNames') || {}) };
    map[session.sid] = 'Super Bot';
    prefs.set('characterNames', map);
    session.title = 'Super Bot';
    session.customName = 'Super Bot';

    assert.equal(dn(session), 'Super Bot');

    // New instance of prefs reads stored name
    const prefs2 = createPrefs(tmp);
    const saved = prefs2.get('characterNames');
    assert.equal(saved[session.sid], 'Super Bot');

    // Clearing character name reverts back to default
    delete saved[session.sid];
    prefs2.set('characterNames', Object.keys(saved).length ? saved : undefined);
    session.customName = '';
    session.title = '';
    assert.equal(dn(session), 'my-project-01');
    assert.equal(prefs2.get('characterNames'), undefined);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

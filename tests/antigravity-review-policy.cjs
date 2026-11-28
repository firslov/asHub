'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createProjectReviewPolicy } = require('../electron/antigravity-review-policy.cjs');

function fixture() {
  const projects = new Map([['a', { name: 'First', enabled: false, available: true }], ['b', { name: 'Second', enabled: false, available: true }]]);
  const commits = [];
  let window = { isDestroyed: () => false };
  const current = (id, enabled) => {
    const project = projects.get(id);
    if (!project) throw new Error('Project no longer exists');
    if (enabled !== undefined) { project.enabled = enabled; commits.push([id, enabled]); }
    return { ...project };
  };
  const set = createProjectReviewPolicy({
    trusted: event => event.trusted, owner: () => window, policy: () => current,
    showMessageBox: () => assert.fail('Project policy changes must not open a native prompt'),
  });
  return { projects, commits, run: (id, enabled) => set({ trusted: true }, id, enabled), set,
    close: () => { window = { isDestroyed: () => true }; }, detach: () => { window = null; } };
}

test('one explicit desktop action grants only the selected project and can be revoked', () => {
  const f = fixture();
  assert.equal(f.run('a').enabled, false);
  assert.deepEqual(f.commits, []);
  assert.equal(f.run('a', true).enabled, true);
  assert.equal(f.run('b').enabled, false);
  assert.equal(f.run('a', true).enabled, true);
  // A previously granted project must still be revocable without its backend.
  f.projects.get('a').available = false;
  assert.equal(f.run('a', false).enabled, false);
  assert.deepEqual(f.commits, [['a', true], ['a', false]]);
});

test('an inactive window, untrusted sender, invalid input or missing backend cannot grant', () => {
  const f = fixture();
  assert.throws(() => f.set({ trusted: false }, 'a', true), /Untrusted/);
  assert.throws(() => f.run('a', 'true'), /Invalid/);
  assert.throws(() => f.run('missing', true), /no longer exists/);
  f.projects.get('a').available = false;
  assert.throws(() => f.run('a', true), /unavailable/);
  f.projects.get('a').available = true;
  f.close();
  assert.throws(() => f.run('a', true), /active desktop window/);
  f.detach();
  assert.throws(() => f.run('a', true), /active desktop window/);
  assert.equal(f.run('a').enabled, false);
  assert.deepEqual(f.commits, []);
});

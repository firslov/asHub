import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-installed-compat-'));
process.env.AGENT_SH_HOME = home;
const { adaptInstalledApplicationUI } = await import('../dist/extensions/installed-compatibility.js');
const { parsePluginManifest } = await import('../dist/extensions/manifest.js');
const { installedApplicationDefinitions } = await import('../dist/extensions/installed.js');
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const legacy = () => ({
  schemaVersion: 2, id: 'ashub-browser-automation', entries: { session: 'index.mjs' },
  requires: { capabilities: ['session-extensions', 'browser-pages'] },
  ui: { version: 1, panels: [{ id: 'browser', title: '会话浏览器', components: [
    { type: 'action', label: '打开网页', action: 'composer.insert', value: '打开网页 https://' },
  ] }] },
});
const normalize = raw => parsePluginManifest(raw, raw.id, 'index.mjs');
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

test('legacy browser shortcut is hidden without modifying any manifest fields', () => {
  const manifest = normalize(legacy()), before = structuredClone(manifest);
  freeze(manifest);
  assert.equal(adaptInstalledApplicationUI(manifest), undefined);
  assert.deepEqual(manifest, before);
});

test('legacy adaptation preserves unrelated panels and their contents', () => {
  const raw = legacy();
  raw.ui.panels.push({ id: 'other', title: 'Additional tools', components: [{ type: 'text', text: 'Keep this panel' }] });
  const manifest = freeze(normalize(raw)), before = structuredClone(manifest);
  const ui = adaptInstalledApplicationUI(manifest);
  assert.deepEqual(ui.panels.map(panel => panel.id), ['other']);
  assert.equal(ui.panels[0], manifest.ui.panels[1]);
  assert.deepEqual(manifest, before);
});

test('matching content from another plugin is not treated as legacy browser UI', () => {
  const raw = legacy(); raw.id = 'another-browser';
  const manifest = freeze(normalize(raw));
  assert.equal(adaptInstalledApplicationUI(manifest), manifest.ui);
});

test('browser panels with different IDs, values or richer contents remain unchanged', () => {
  for (const change of [
    raw => { raw.ui.panels[0].id = 'open-page'; },
    raw => { raw.ui.panels[0].components[0].value = '打开网页 https://example.com'; },
    raw => { raw.ui.panels[0].components = [{ type: 'resource', id: 'browser' }]; },
    raw => { raw.ui.panels[0].components.push({ type: 'text', text: 'Additional explanation' }); },
  ]) {
    const raw = legacy(); change(raw);
    const manifest = freeze(normalize(raw));
    assert.equal(adaptInstalledApplicationUI(manifest), manifest.ui);
  }
});

test('current bundled browser manifest does not need the legacy adaptation', () => {
  const raw = JSON.parse(fs.readFileSync(new URL('../examples/extensions/browser-automation/ashub-plugin.json', import.meta.url), 'utf8'));
  const manifest = freeze(normalize(raw));
  assert.equal(manifest.ui, undefined);
  assert.equal(adaptInstalledApplicationUI(manifest), manifest.ui);
});

test('installed discovery uses the compatibility view without changing files or browser activation', async () => {
  const dir = fs.mkdtempSync(path.join(home, 'profile-')), settings = path.join(dir, 'settings.json');
  const root = path.join(dir, 'extensions', 'legacy-browser');
  fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(settings, '{}');
  const raw = legacy(), manifestFile = path.join(root, 'ashub-plugin.json');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: raw.id, version: '1.0.0', type: 'module' }));
  fs.writeFileSync(manifestFile, JSON.stringify(raw));
  fs.writeFileSync(path.join(root, 'index.mjs'), 'export default () => {}');
  const before = fs.readFileSync(manifestFile, 'utf8'), calls = [];
  const definitions = installedApplicationDefinitions(settings, { enableBrowserPages: (id, signal) => calls.push({ id, signal }) });
  const definition = definitions.find(entry => entry.capabilities?.includes('browser-pages'));
  assert(definition, 'legacy native browser activation remains discoverable');
  assert.equal(definition.ui, undefined);
  const controller = new AbortController();
  await definition.create({ signal: controller.signal, onDispose() {} });
  assert.deepEqual(calls, [{ id: definition.pluginId, signal: controller.signal }]);
  assert.equal(fs.readFileSync(manifestFile, 'utf8'), before);
  assert.equal(fs.readFileSync(settings, 'utf8'), '{}');
});

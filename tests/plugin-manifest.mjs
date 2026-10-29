import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { env } = require('./harness.cjs');
const { zip, plugin } = require('./plugin-zip-fixture.cjs');
function fixture(run = async () => {}) {
  const e = env({ globals: { setTimeout, clearTimeout } });
  const manifest = e.load('src/extensions/manifest.ts'), catalog = e.load('src/plugins.ts');
  const { PluginInstaller } = e.load('src/plugin-installer.ts');
  const file = path.join(e.dir, 'settings.json'); fs.writeFileSync(file, '{}');
  return { e, file, manifest, catalog, installer: new PluginInstaller(file, run, 'darwin') };
}
const manifest = { schemaVersion: 2, id: 'sample-plugin', entries: { session: 'index.mjs' } };
const ui = { version: 1, panels: [{ id: 'overview', title: 'Sample', components: [
  { type: 'text', text: '<script>plain text only</script>' },
  { type: 'action', label: 'Insert', action: 'composer.insert', value: 'Review this project' },
  { type: 'form', id: 'settings', mode: 'config', namespace: 'sample', fields: [
    { id: 'enabled', label: 'Enabled', type: 'boolean', value: true },
    { id: 'limit', label: 'Limit', type: 'number', value: 3, min: 1, max: 10 },
  ] },
] }] };
const configuration = { configNamespaces: ['sample'], defaults: { sample: { enabled: true, limit: 3 } }, configSchema: { sample: {
  type: 'object', required: ['enabled', 'limit'], additionalProperties: false,
  properties: { enabled: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 10 } },
} } };
const uiManifest = { schemaVersion: 2, id: 'sample-plugin', name: 'Declarative Sample', ...configuration, ui };
function archive(m, entries = {}) {
  return zip({ 'release/package.json': JSON.stringify({ name: m.id, version: '1.0.0', type: 'module' }),
    'release/ashub-plugin.json': JSON.stringify(m), ...entries });
}
async function done(installer, id) {
  for (let i = 0; i < 200; i++) { const status = installer.status(id); if (status.state !== 'running') return status; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw Error('Installer did not finish');
}
function installed(f, id, m, version = '1.0.0') {
  const root = path.join(f.e.dir, 'extensions', id); fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: m.id, version }));
  fs.writeFileSync(path.join(root, 'ashub-plugin.json'), JSON.stringify(m));
  for (const entry of Object.values(m.entries ?? (m.schemaVersion === 1 ? { session: 'index.mjs' } : {}))) {
    fs.mkdirSync(path.dirname(path.join(root, entry)), { recursive: true }); fs.writeFileSync(path.join(root, entry), 'export default () => {}');
  }
  return root;
}
function uiAtJSONLength(length) {
  const sized = { version: 1, panels: ['first', 'second'].map(id => ({ id, title: id,
    components: Array.from({ length: 16 }, () => ({ type: 'text', text: '😀'.repeat(4000) })),
  })) };
  const tail = { type: 'text', text: '' }; sized.panels[1].components.push(tail);
  const remaining = length - JSON.stringify(sized).length;
  assert(remaining > 0 && remaining <= 8000, 'boundary uses valid local component/text limits');
  tail.text = 'x'.repeat(remaining);
  assert.equal(JSON.stringify(sized).length, length);
  return sized;
}
test('declarative UI total limit matches the client at exactly 262144 UTF-16 characters', async () => {
  const f = fixture();
  const { validateDeclarativeUI } = await import('../web/js/extensions/declarative-schema.js');
  assert.equal(f.manifest.MAX_PLUGIN_UI_JSON_CHARS, 262144);
  const boundary = uiAtJSONLength(262144), over = uiAtJSONLength(262145);
  assert(Buffer.byteLength(JSON.stringify(boundary), 'utf8') > 262144, 'limit counts UTF-16 characters rather than UTF-8 bytes');
  const declaration = { schemaVersion: 2, id: 'sample-plugin', ui: boundary };
  assert.doesNotThrow(() => f.manifest.parsePluginManifest(declaration, declaration.id));
  assert.doesNotThrow(() => validateDeclarativeUI(boundary));
  assert.throws(() => f.manifest.parsePluginManifest({ ...declaration, ui: over }, declaration.id), /exceeds 262144 JSON characters/);
  assert.throws(() => validateDeclarativeUI(over), /Unsupported declarative interface/);
  const preview = await f.installer.preview(archive(declaration));
  assert(preview.canInstall); f.installer.discard(preview.token);
  await f.installer.close();
});
test('oversized declarative-only ZIP is rejected before installation and staging is removed', async () => {
  let calls = 0; const f = fixture(async () => { calls++; });
  await assert.rejects(f.installer.preview(archive({ schemaVersion: 2, id: 'sample-plugin', ui: uiAtJSONLength(262145) })), /exceeds 262144 JSON characters/);
  assert.equal(calls, 0); assert(!fs.existsSync(path.join(f.e.dir, 'extensions')));
  assert.equal(fs.readFileSync(f.file, 'utf8'), '{}');
  assert.deepEqual(fs.readdirSync(path.join(f.e.dir, 'plugin-install/staging')), []);
  await f.installer.close();
});
test('legacy v1 and manifestless agent-sh packages retain session discovery and stable identities', async () => {
  const f = fixture();
  const raw = JSON.parse(fs.readFileSync(new URL('../examples/extensions/project-management/ashub-plugin.json', import.meta.url)));
  const parsed = f.manifest.parsePluginManifest(raw, raw.id, 'index.ts');
  assert.equal(parsed.schemaVersion, 1); assert.equal(parsed.entries.session, 'index.ts');
  const legacyExtras = f.manifest.parsePluginManifest({ ...raw, ui: { html: '<script>unvalidated</script>' }, configSchema: { providers: {} } }, raw.id);
  assert.equal(legacyExtras.ui, undefined); assert.equal(legacyExtras.configSchema, undefined);
  const preview = await f.installer.preview(zip(plugin({}, null)));
  assert.equal((await done(f.installer, f.installer.confirm(preview.token).id)).state, 'succeeded');
  const [legacy] = f.catalog.pluginCatalog(f.file); assert.equal(legacy.manifest, undefined); assert(legacy.sessionEnabled);
  f.catalog.setPluginEnabled(f.file, legacy.id, false);
  const next = await f.installer.preview(zip(plugin({}, { schemaVersion: 1, id: 'sample-plugin' })));
  assert.equal((await done(f.installer, f.installer.confirm(next.token).id)).state, 'succeeded');
  const [upgraded] = f.catalog.pluginCatalog(f.file); assert.equal(upgraded.id, legacy.id); assert.equal(upgraded.enabled, false); assert.equal(upgraded.manifest.schemaVersion, 1);
  await f.installer.close();
});
test('v1 explicit entry paths preserve their separate identity and directory disable precedence', async () => {
  const f = fixture();
  const root = installed(f, 'sample-plugin', { schemaVersion: 1, id: 'sample-plugin' });
  fs.writeFileSync(path.join(root, 'index.js'), 'export default () => {}');
  fs.writeFileSync(f.file, JSON.stringify({ extensions: [path.join(root, 'index.mjs')], disabledExtensions: ['sample-plugin'] }));
  const entries = f.catalog.pluginCatalog(f.file);
  assert.equal(entries.length, 2);
  const explicit = entries.find(entry => entry.source.endsWith('index.mjs')), directory = entries.find(entry => entry.source.endsWith('index.js'));
  assert(explicit.enabled); assert.equal(directory.enabled, false);
  assert.equal(explicit.sessionSpecifier, path.join(root, 'index.mjs')); assert(explicit.sessionEnabled);
  assert(entries.every(entry => entry.compatibility.compatible)); await f.installer.close();
});
test('managed v2 application scope survives explicit nested paths and nested package metadata', async () => {
  const f = fixture();
  const root = installed(f, 'sample-plugin', { ...manifest, entries: { application: 'app/start.mjs' } });
  const entry = path.join(root, 'app/start.mjs');
  fs.writeFileSync(path.join(root, 'app/package.json'), '{"type":"module"}');
  const [directoryOnly] = f.catalog.pluginCatalog(f.file);
  fs.writeFileSync(f.file, JSON.stringify({ extensions: [entry] }));
  const entries = f.catalog.pluginCatalog(f.file), [explicit] = entries;
  assert.equal(entries.length, 1); assert.equal(explicit.id, directoryOnly.id);
  assert.equal(explicit.manifest.schemaVersion, 2); assert.equal(explicit.packageRoot, root);
  assert.equal(explicit.applicationSpecifier, entry); assert.equal(explicit.sessionSpecifier, undefined); assert.equal(explicit.sessionEnabled, false);
  assert.deepEqual([...explicit.directoryNames], ['sample-plugin']);
  f.catalog.setPluginEnabled(f.file, explicit.id, false);
  assert.equal(f.catalog.pluginCatalog(f.file)[0].enabled, false);
  assert.equal(f.catalog.pluginCatalog(f.file)[0].id, explicit.id);
  // A nested dependency declaration must not redefine the managed package's
  // application entry as a legacy or session plugin either.
  fs.writeFileSync(path.join(root, 'app/ashub-plugin.json'), JSON.stringify({ schemaVersion: 1, id: 'inner-plugin' }));
  const [nestedManifest] = f.catalog.pluginCatalog(f.file);
  assert.equal(nestedManifest.manifest.id, 'sample-plugin'); assert.equal(nestedManifest.packageRoot, root); assert.equal(nestedManifest.sessionEnabled, false);
  await f.installer.close();
});
test('explicit external nested entries obey their parent v2 manifest while v1 file identities stay unchanged', async () => {
  const f = fixture();
  const root = installed(f, 'sample-plugin', { ...manifest, entries: { application: 'app/start.mjs' } });
  const external = path.join(f.e.dir, 'external-plugin'); fs.renameSync(root, external);
  fs.writeFileSync(path.join(external, 'app/package.json'), '{"type":"module"}');
  const entry = path.join(external, 'app/start.mjs'); fs.writeFileSync(f.file, JSON.stringify({ extensions: [entry] }));
  const [app] = f.catalog.pluginCatalog(f.file);
  assert.equal(app.packageRoot, external); assert.equal(app.manifest.schemaVersion, 2); assert.equal(app.applicationSpecifier, entry); assert.equal(app.sessionEnabled, false);
  // Invalid parent manifests still fail closed rather than falling back to a
  // runnable legacy entry through the nested module-mode package boundary.
  fs.writeFileSync(path.join(external, 'ashub-plugin.json'), '{"schemaVersion":99}');
  const [invalid] = f.catalog.pluginCatalog(f.file);
  assert.equal(invalid.packageRoot, external); assert.equal(invalid.sessionEnabled, false); assert.equal(invalid.compatibility.compatible, false);
  await f.installer.close();
});
test('UI-only ZIP installs without an executable entry and supports bound revision-checked config writes', async () => {
  const calls = [], f = fixture(async (...args) => calls.push(args));
  const preview = await f.installer.preview(archive(uiManifest));
  assert(preview.canInstall); assert.equal(calls.length, 0);
  assert.equal((await done(f.installer, f.installer.confirm(preview.token).id)).state, 'succeeded');
  assert.equal(calls.length, 0, 'declarative metadata must never execute');
  const [entry] = f.catalog.pluginCatalog(f.file);
  assert.equal(entry.sessionEnabled, false); assert.equal(entry.sessionSpecifier, undefined); assert.equal(entry.applicationSpecifier, undefined);
  assert.equal(entry.manifest.ui.panels[0].components[0].text, '<script>plain text only</script>');
  assert.deepEqual([...entry.configNamespaces], ['sample']); assert(entry.compatibility.compatible);
  assert(!fs.existsSync(entry.source));
  const loaded = f.catalog.getPluginConfig(f.file, entry.id, 'sample');
  const saved = f.catalog.savePluginConfig(f.file, entry.id, 'sample', { enabled: false, limit: 5 }, loaded.revision);
  assert.equal(saved.config.limit, 5);
  assert.throws(() => f.catalog.savePluginConfig(f.file, entry.id, 'sample', { enabled: false, limit: 6 }, loaded.revision), /changed elsewhere/);
  assert.throws(() => f.catalog.savePluginConfig(f.file, entry.id, 'sample', { enabled: false, limit: 11 }, saved.revision), /allowed range/);
  assert.throws(() => f.catalog.getPluginConfig(f.file, entry.id, 'undeclared'), /not declared/);
  assert.throws(() => f.catalog.savePluginConfig(f.file, entry.id, 'undeclared', {}, saved.revision), /not declared/);
  f.catalog.setPluginEnabled(f.file, entry.id, false);
  const disabled = f.catalog.pluginCatalog(f.file)[0]; assert.equal(disabled.enabled, false); assert.equal(disabled.id, entry.id);
  assert.equal(f.catalog.getPluginConfig(f.file, entry.id, 'sample').config.limit, 5);
  await f.installer.close();
});
test('application and dual-scope ZIPs expose explicit entry scopes without importing either during installation', async () => {
  const checked = [], f = fixture(async (command, args) => { checked.push([command, args]); });
  const app = { ...manifest, entries: { application: 'app/start.mjs' } };
  const first = await f.installer.preview(archive(app, { 'release/app/start.mjs': 'throw Error("must not import app")' }));
  assert(first.canInstall); assert.equal(checked.length, 0);
  assert.equal((await done(f.installer, f.installer.confirm(first.token).id)).state, 'succeeded');
  const [appEntry] = f.catalog.pluginCatalog(f.file);
  assert.equal(appEntry.sessionEnabled, false); assert.equal(appEntry.sessionSpecifier, undefined);
  assert.equal(appEntry.applicationSpecifier, path.join(first.target, 'app/start.mjs'));
  assert.equal(appEntry.packageRoot, first.target); assert.equal(checked.length, 1); assert.equal(checked[0][0], '--check');
  const dual = { ...manifest, id: 'dual-plugin', entries: { session: 'session.mjs', application: 'application.mjs' } };
  const next = await f.installer.preview(archive(dual, { 'release/session.mjs': 'export default () => {}', 'release/application.mjs': 'export default () => {}' }));
  assert.equal((await done(f.installer, f.installer.confirm(next.token).id)).state, 'succeeded');
  const both = f.catalog.pluginCatalog(f.file).find(entry => entry.manifest.id === dual.id);
  assert(both.sessionEnabled); assert(both.applicationSpecifier); assert(both.sessionSpecifier.endsWith('session.mjs')); assert.equal(checked.length, 3);
  await f.installer.close();
});
test('unknown host API/capabilities fail closed in installer and manually copied catalog entries', async () => {
  let calls = 0; const f = fixture(async () => { calls++; });
  for (const requires of [{ hostApi: '>=99' }, { capabilities: ['os-sandbox'] }]) {
    const preview = await f.installer.preview(archive({ ...manifest, requires }, { 'release/index.mjs': 'export default () => {}' }));
    assert.equal(preview.canInstall, false); assert.throws(() => f.installer.confirm(preview.token), /prerequisites/); f.installer.discard(preview.token);
  }
  assert.equal(calls, 0);
  installed(f, 'sample-plugin', { ...manifest, requires: { capabilities: ['unknown'] } });
  const [entry] = f.catalog.pluginCatalog(f.file); assert.equal(entry.compatibility.compatible, false); assert.equal(entry.sessionEnabled, false); assert.match(entry.compatibilityError, /unknown/);
  const accepted = f.manifest.parsePluginManifest({ ...manifest, requires: { hostApi: '^1.0.0', capabilities: ['session-extensions'] } }, manifest.id);
  assert(f.manifest.pluginCompatibility(accepted, { platform: 'darwin', nodeVersion: '22.23.3' }).compatible);
  assert.equal(f.manifest.pluginCompatibility(accepted, { capabilities: [] }).compatible, false);
  await f.installer.close();
});
test('manifest and UI schemas reject unsupported fields, executable UI, unsafe paths and undeclared configuration', async () => {
  const f = fixture(), parse = raw => f.manifest.parsePluginManifest(raw, raw.id);
  const bad = [
    { ...manifest, unknownRequirement: true }, { ...manifest, entries: { frontend: 'evil.mjs' } },
    { ...manifest, entries: { session: '../escape.mjs' } }, { ...manifest, requires: { sandbox: true } },
    { ...manifest, defaults: { sample: {} } }, { ...manifest, configNamespaces: ['providers'] },
    { ...uiManifest, configSchema: { sample: { type: 'object', $ref: 'remote-schema' } } },
    { ...uiManifest, configSchema: { sample: { type: 'object', properties: { limit: { type: 'integer', enum: ['bad'] } } } } },
    { ...uiManifest, configSchema: { sample: { type: 'object', properties: { limit: { type: 'integer', minimum: 9, maximum: 1 } } } } },
    { ...uiManifest, defaults: { sample: { enabled: true, limit: 50 } } },
  ];
  for (const component of [
    { type: 'html', html: '<script>evil()</script>' }, { type: 'text', text: 'ok', onClick: 'evil' },
    { type: 'action', label: 'Run', action: 'host.execute', value: 'rm' },
    { type: 'form', id: 'unsafe', mode: 'config', namespace: 'providers', fields: [] },
    { type: 'form', id: 'unsafe', fields: [{ id: 'path', type: 'file', label: 'Path' }] },
    { type: 'form', id: 'unsafe', mode: 'config', namespace: 'sample', fields: [{ id: 'secret', type: 'text', label: 'Secret' }] },
  ]) bad.push({ ...uiManifest, ui: { version: 1, panels: [{ id: 'overview', title: 'Bad', components: [component] }] } });
  for (const raw of bad) assert.throws(() => parse(raw));
  await assert.rejects(f.installer.preview(archive({ ...uiManifest, ui: { version: 1, panels: [{ id: 'bad', title: 'Bad', components: [{ type: 'script', src: 'evil.js' }] }] } })), /Unsupported UI/);
  assert(!fs.existsSync(path.join(f.e.dir, 'extensions'))); await f.installer.close();
});
test('dependencies use package IDs, enforce enabled/version/compatibility, and reject cycles transitively', async () => {
  const f = fixture();
  installed(f, 'custom-directory', { schemaVersion: 1, id: 'dependency-plugin' }, '1.2.0');
  const dependent = { ...manifest, dependencies: [{ id: 'dependency-plugin', minVersion: '1.1.0' }] };
  const preview = await f.installer.preview(archive(dependent, { 'release/index.mjs': 'export default () => {}' })); assert(preview.canInstall);
  const dependency = f.catalog.pluginCatalog(f.file)[0]; f.catalog.setPluginEnabled(f.file, dependency.id, false);
  assert.equal(f.installer.previewStatus(preview.token).canInstall, false); assert.throws(() => f.installer.confirm(preview.token), /prerequisites/);
  f.catalog.setPluginEnabled(f.file, dependency.id, true); installed(f, 'sample-plugin', dependent);
  assert(f.catalog.pluginCatalog(f.file).every(entry => entry.compatibility.compatible));
  const cycle = { schemaVersion: 1, id: 'dependency-plugin', dependencies: [{ id: 'sample-plugin', minVersion: '1.0.0' }] };
  fs.writeFileSync(path.join(dependency.packageRoot, 'ashub-plugin.json'), JSON.stringify(cycle));
  assert(f.catalog.pluginCatalog(f.file).every(entry => entry.compatibility.compatible === false && !entry.sessionEnabled));
  await f.installer.close();
});
test('setup cannot change approved v2 scopes, capabilities or UI metadata', async () => {
  const f = fixture(async (script, _args, cwd) => {
    if (script === '--check') return;
    const file = path.join(cwd, 'ashub-plugin.json'), raw = JSON.parse(fs.readFileSync(file)); raw.entries = { session: 'app.mjs' }; fs.writeFileSync(file, JSON.stringify(raw));
  });
  const raw = { ...manifest, entries: { application: 'app.mjs' }, setup: { script: 'setup.mjs', description: 'Build' } };
  const preview = await f.installer.preview(archive(raw, { 'release/app.mjs': 'export default () => {}', 'release/setup.mjs': '// setup' }));
  const result = await done(f.installer, f.installer.confirm(preview.token).id);
  assert.equal(result.state, 'failed'); assert.match(result.error, /manifest changed/); assert(!fs.existsSync(preview.target)); await f.installer.close();
});

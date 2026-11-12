import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { zip } = require('./plugin-zip-fixture.cjs');
const { getFileMatchers } = require('app-builder-lib/out/fileMatcher.js');
const yaml = require('js-yaml'), ts = require('typescript');
const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'examples/extensions/personal-assistant');
const packageId = 'ashub-personal-assistant';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-plugin-boundaries-'));
process.env.AGENT_SH_HOME = home;
for (const key of Object.keys(process.env)) if (/(API_KEY|AUTH_TOKEN|ACCESS_TOKEN)$/.test(key)) delete process.env[key];
globalThis.fetch = async () => { throw Error('No external network in plugin boundary tests'); };
const { PluginInstaller } = await import('../dist/plugin-installer.js');
const { pluginCatalog } = await import('../dist/plugins.js');
const { ApplicationExtensionRegistry } = await import('../dist/extensions/application.js');
const { installedApplicationDefinitions } = await import('../dist/extensions/installed.js');
const { ConversationEntries } = await import('../dist/extensions/conversation-entries.js');
const { PluginBackground } = await import('../dist/extensions/background.js');
const { pluginDataDirectory } = await import('../dist/extensions/data-directory.js');
const { PluginRuntime, preparePluginRegistrations } = await import('../dist/plugin-runtime.js');
const { createCore } = await import('agent-sh');
const { activateAgent } = await import('agent-sh/agent');
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

function archive() {
  const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json')));
  return zip(Object.fromEntries(['package.json', ...pkg.files].map(name => [name, fs.readFileSync(path.join(source, name), 'utf8')])));
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(home, 'profile-')), file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{}');
  const sessions = new Map(), resources = new Map();
  let active, bound = 0, calls = 0, historyReads = 0;
  const catalog = () => pluginCatalog(file).find(entry => entry.packageName === packageId);
  const snapshot = () => ({ sessions: [...sessions.values()], projects: [] });
  const boot = async () => {
    assert(!active, 'close the previous Hub before restarting');
    const life = new AbortController();
    const entries = new ConversationEntries(path.join(dir, 'hub-sessions/plugin-conversations.json'), {
      exists: id => sessions.has(id), models: () => [{ provider: 'test', model: 'offline' }], changed() {},
      async create(id, spec) { sessions.set(id, { instanceId: id, title: spec.label, cwd: spec.cwd, kind: 'agent' }); },
    });
    const background = new PluginBackground(path.join(dir, 'background.json'), {
      targets: () => [...sessions.values()].map(s => ({ ...s, id: s.instanceId, provider: 'test', model: 'offline', busy: true })),
      store() { historyReads++; throw Error('No history should be read without memory authorization'); },
      async complete() { calls++; throw Error('No model requests in plugin boundary tests'); },
    }, life.signal);
    const registry = new ApplicationExtensionRegistry({ settingsFile: file, definitions: [], discover: () => installedApplicationDefinitions(file, {
      bindServices: (pluginId, context) => {
        bound++;
        return {
          conversations: entries.bind(pluginId, context.signal), background: background.bind(pluginId, context.signal), host: { snapshot },
          interactions: { register(key, resource) {
            const id = pluginId + '/' + key; resources.set(id, resource);
            return () => resources.delete(id);
          } },
        };
      },
    }) });
    active = { registry, entries, life };
    await registry.start();
    return active;
  };
  const shutdown = async () => {
    if (!active) return;
    const prior = active; active = null;
    await prior.registry.close(); prior.life.abort();
    assert.equal(prior.entries.list().length, 0); assert.equal(resources.size, 0);
  };
  const installer = new PluginInstaller(file, undefined, process.platform, () => false, async () => { await active?.registry.refresh(); });
  t.after(async () => { await shutdown(); await installer.close(); });
  const install = async () => {
    const preview = await installer.preview(archive());
    assert(preview.canInstall, JSON.stringify(preview.checks));
    const job = installer.confirm(preview.token);
    for (let i = 0; i < 300 && installer.status(job.id).state === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(installer.status(job.id).state, 'succeeded', installer.status(job.id).error);
    return catalog();
  };
  return { dir, file, boot, shutdown, install, installer, catalog, sessions, resources, counts: () => ({ bound, calls, historyReads }) };
}

test('a fresh profile and repeated Hub startup never install, activate or allocate assistant storage', async t => {
  const f = fixture(t);
  for (let n = 0; n < 2; n++) {
    assert.equal(f.catalog(), undefined);
    const { registry, entries } = await f.boot();
    assert.equal(entries.list().length, 0);
    assert(!registry.snapshot().features.some(feature => feature.name === '个人助手'));
    assert.equal(f.sessions.size, 0);
    assert(!fs.existsSync(path.join(f.dir, 'extensions', packageId)));
    assert(!fs.existsSync(path.join(f.dir, 'hub-sessions/plugin-data')));
    assert.deepEqual(f.counts(), { bound: 0, calls: 0, historyReads: 0 });
    await f.shutdown();
  }
});

test('explicit ZIP installation owns entry lifecycle; disable, upgrade, uninstall and restart preserve user data without resurrection', async t => {
  const f = fixture(t);
  let hub = await f.boot();
  const installed = await f.install(), id = installed.id, data = pluginDataDirectory(f.file, id);
  assert.equal(installed.enabled, true);
  assert.equal(hub.entries.list().length, 1);
  assert.equal(hub.entries.list()[0].sessionId, null, 'installation alone cannot create a conversation');
  const { current } = await import(pathToFileURL(path.join(installed.packageRoot, 'shared.mjs')).href);
  const assistant = current(data);
  assert(assistant); assert.equal(assistant.learning.config().enabled, false);
  assert(fs.existsSync(path.join(data, 'memory.sqlite')));
  const input = { key: 'assistant', provider: 'test', model: 'offline' };
  const session = await hub.entries.approve(id, await hub.entries.prepare(id, input));
  const record = assistant.store.add({ title: 'Fixture preference', content: 'Prefers concise reports', kind: 'preference', scope: 'personal' }, { type: 'user', at: 1 }, 'active');
  assert(hub.entries.matchesSession(id, ['assistant'], session));

  // Exercise the actual session loader: an installed application must not add
  // memory tools or even a loaded-plugin status to an ordinary conversation.
  const core = createCore({ apiKey: 'offline-test-only', baseURL: 'http://127.0.0.1:1/v1', model: 'offline' });
  const context = core.extensionContext({ quit() {} });
  preparePluginRegistrations(context); activateAgent(context); preparePluginRegistrations(context);
  const runtime = new PluginRuntime(f.file, 10_000, undefined, undefined, undefined,
    (pluginId, keys) => hub.entries.matchesSession(pluginId, keys, 'ordinary-session'));
  try {
    assert.deepEqual(await runtime.load(context), []);
    assert(!runtime.status.some(entry => entry.id === id));
    assert(!context.agent.getTools().some(tool => tool.name.startsWith('assistant_memory_')));
  } finally { runtime.close(); core.kill(); }

  await hub.registry.setPluginEnabled(id, false);
  assert.equal(hub.entries.list().length, 0); assert.equal(current(data), undefined);
  assert.equal(assistant.stopped, true); assert.equal(assistant.learning.controller.signal.aborted, true);
  // Updating a disabled installation must retain the user's decision and identity.
  const updated = await f.install(); assert.equal(updated.id, id); assert.equal(updated.enabled, false);
  assert.equal(current(data), undefined);
  await f.shutdown(); hub = await f.boot();
  assert.equal(hub.entries.list().length, 0); assert.equal(current(data), undefined);
  assert(fs.existsSync(path.join(data, 'memory.sqlite')));
  await hub.registry.setPluginEnabled(id, true);
  assert.equal(hub.entries.list()[0].sessionId, session);
  assert.equal(current(data).store.get(record.id).content, record.content);

  await hub.registry.uninstallPlugin(id, () => {}, () => f.installer.uninstall(id));
  assert.equal(f.catalog(), undefined); assert.equal(current(data), undefined);
  assert.equal(hub.entries.list().length, 0); assert(f.sessions.has(session));
  assert(fs.existsSync(path.join(data, 'memory.sqlite')));
  await f.shutdown(); hub = await f.boot();
  assert.equal(f.catalog(), undefined); assert.equal(hub.entries.list().length, 0);
  assert.equal(current(data), undefined, 'restart cannot rediscover the uninstall backup');

  const restored = await f.install();
  assert.equal(restored.id, id); assert.equal(pluginDataDirectory(f.file, restored.id), data);
  assert.equal(hub.entries.list()[0].sessionId, session);
  assert.equal(current(data).store.get(record.id).content, record.content);
  assert.equal(f.sessions.size, 1, 'explicit reinstall reuses the original conversation');
  assert.equal(f.counts().calls, 0); assert.equal(f.counts().historyReads, 0);
});

test('release file selection excludes the standalone assistant on every desktop platform', () => {
  const config = yaml.load(fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json')));
  for (const platform of ['mac', 'win', 'linux']) {
    const matchers = ['files', 'extraResources', 'extraFiles'].flatMap(name => getFileMatchers(config, name, path.join(home, 'package'), {
      defaultSrc: root, globalOutDir: path.join(root, 'release'), customBuildOptions: config[platform] ?? {}, macroExpander: value => value,
    }) ?? []);
    const included = file => matchers.some(matcher => {
      const relative = path.relative(matcher.from, file);
      return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
        && matcher.createFilter()(file, fs.statSync(file));
    });
    for (const name of ['package.json', ...pkg.files]) assert(!included(path.join(source, name)), `${platform} bundles personal-assistant/${name}`);
    assert(included(path.join(root, 'examples/extensions/image-display/ashub-plugin.json')), `${platform}: positive control must select a bundled extension`);
  }
});

test('host source depends on generic plugin capabilities, not assistant modules or memory schemas', () => {
  const failures = [];
  for (const directory of ['src', 'electron', 'web/js']) {
    const base = path.join(root, directory);
    for (const relative of fs.readdirSync(base, { recursive: true })) {
      const file = path.join(base, relative);
      if (!/\.(?:[cm]?js|ts)$/.test(file) || !fs.statSync(file).isFile()) continue;
      const code = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = node => {
        if (ts.isStringLiteralLike(node)) {
          const parent = node.parent;
          const module = (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) && parent.moduleSpecifier === node
            || ts.isCallExpression(parent) && parent.arguments[0] === node && (parent.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(parent.expression) && parent.expression.text === 'require');
          if (module && /(?:^|\/)personal-assistant(?:\/|$)|^ashub-personal-assistant(?:\/|$)/.test(node.text)) failures.push(`${file}: imports assistant implementation`);
          if (/(?:^|[/\\])memory\.sqlite$/.test(node.text) || /CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:memories|memory_fts|memory_versions|learning_state)\b/i.test(node.text)) failures.push(`${file}: owns assistant memory storage`);
        }
        ts.forEachChild(node, visit);
      };
      visit(code);
    }
  }
  assert.deepEqual(failures, []);
});

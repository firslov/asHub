import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-plugin-approvals-'));
process.env.AGENT_SH_HOME = home;
for (const key of Object.keys(process.env)) if (/API_KEY|AUTH_TOKEN|ACCESS_TOKEN/.test(key)) delete process.env[key];
globalThis.fetch = async () => { throw Error('External network disabled'); };
const file = path.join(home, 'settings.json');
fs.writeFileSync(file, JSON.stringify({ 'ashub.permissions.autoApprove': true, disabledBuiltins: ['codex-provider'] }));
const directory = path.join(home, 'extensions', 'project-management');
fs.mkdirSync(directory, { recursive: true });
for (const name of ['index.mjs', 'package.json', 'ashub-plugin.json'])
  fs.copyFileSync(new URL('../examples/extensions/project-management/' + name, import.meta.url), path.join(directory, name));
const { AshBridge } = await import('../dist/bridges/ash.js');
const { pluginCatalog, setPluginEnabled, savePluginConfig, getPluginConfig } = await import('../dist/plugins.js');
const { setPluginAutoApproval, canAutoApprovePlugin, PLUGIN_AUTO_APPROVE } = await import('../dist/plugin-approvals.js');
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

test('plugin-specific consent uses runtime identity, changes live, preserves cancellation and defaults to confirmation', async () => {
  const plugin = pluginCatalog(file)[0];
  let prompts = 0, effects = 0;
  const bridge = new AshBridge({
    kind: 'agent', cwd: home, sessionId: 'approval-test',
    hostAccess: {
      catalog: async () => ({ currentId: 'approval-test', projects: [], models: [] }),
      execute: async (_request, approve, signal) => {
        const allowed = await approve({ title: 'Create', items: [] }, signal);
        if (allowed) effects++;
        return { status: allowed ? 'completed' : 'denied', results: [] };
      },
    },
  });
  try {
    await bridge.ready();
    bridge.on('event', event => {
      if (event.name === 'permission:request') {
        prompts++;
        bridge.decidePermission(event.payload.requestId, 'denied', false);
      }
    });
    const tool = bridge.extCtx.agent.getTools().find(t => t.name === 'project_management_create_project');
    assert(tool);
    const execute = () => tool.execute({ requestKey: 'project-plan', name: 'Fixture', cwd: home }, null, {});
    assert((await execute()).isError);
    assert.equal(prompts, 1);
    assert.equal(effects, 0);
    setPluginAutoApproval(file, plugin.id, true);
    assert(canAutoApprovePlugin(file, plugin.id));
    assert(!(await execute()).isError);
    assert.equal(prompts, 1);
    assert.equal(effects, 1);
    // A model argument cannot impersonate the plugin on a direct kernel call.
    await bridge.core.handlers.call('ashub:execute', { pluginId: plugin.id, request: {} });
    assert.equal(prompts, 2);
    assert.equal(effects, 1);
    const controller = new AbortController(); controller.abort();
    assert((await tool.execute({ requestKey: 'cancelled', name: 'Fixture', cwd: home }, null, {signal:controller.signal})).isError);
    assert.equal(effects, 1);
    setPluginAutoApproval(file, plugin.id, false);
    assert((await execute()).isError);
    assert.equal(prompts, 3);
    setPluginAutoApproval(file, plugin.id, true);
    setPluginEnabled(file, plugin.id, false);
    assert.equal(canAutoApprovePlugin(file, plugin.id), false);
    assert.equal(canAutoApprovePlugin(file, 'different-plugin'), false);
    assert.throws(() => setPluginAutoApproval(file, 'builtin:agent', true));
    assert.throws(() => getPluginConfig(file, plugin.id, PLUGIN_AUTO_APPROVE));
    assert.throws(() => savePluginConfig(file, plugin.id, PLUGIN_AUTO_APPROVE, {}, ''));
    fs.writeFileSync(file, '{malformed');
    assert.equal(canAutoApprovePlugin(file, plugin.id), false);
  } finally { bridge.close(); }
});

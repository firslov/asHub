import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import activate from '../examples/extensions/browser-automation/index.mjs';

// The same command and bus contract can be checked against a released kernel.
const require = process.env.ASHUB_TEST_KERNEL_ROOT
  ? createRequire(resolve(process.env.ASHUB_TEST_KERNEL_ROOT, 'package.json'))
  : createRequire(import.meta.url);
const loadKernel = (name) => import(pathToFileURL(require.resolve(name)).href);
const { createCore } = await loadKernel('agent-sh');
const { loadBuiltinExtensions } = await loadKernel('agent-sh/extensions');

async function fixture(t, { slash = true } = {}) {
  const core = createCore({});
  const ctx = core.extensionContext({ quit() {} });
  if (slash) await loadBuiltinExtensions(ctx, ['codex-provider', 'file-autocomplete']);
  const tools = new Map();
  const notices = [];
  const builtInCalls = [];
  const legacyCalls = [];
  let handlePage = async (request) => ['open', 'observe'].includes(request.op)
    ? { url: request.url ?? 'https://example.test/', items: [] }
    : { status: 'verified' };
  let instruction, advise, dispose, available = true;
  ctx.bus.on('ui:info', ({ message }) => notices.push(message));
  ctx.bus.on('ui:error', ({ message }) => notices.push(message));
  for (const action of ['status', 'relogin', 'retry_script', 'update_strategy']) {
    const name = `legacy_chromium_${action}`;
    tools.set(name, { name, execute(args) { legacyCalls.push([name, args]); return { status: 'fixture-only' }; } });
  }
  activate({ ...ctx,
    services: { browserPages: { available: () => available, run(request) {
      builtInCalls.push(request);
      return handlePage(request);
    } } },
    agent: { registerTool: (tool) => tools.set(tool.name, tool), registerInstruction: (_, text) => { instruction = text; },
      adviseInstruction: (_, fn) => { advise = fn; } },
    onDispose: (fn) => { dispose = fn; },
  });
  t.after(() => { dispose?.(); core.kill(); });
  return { tools, notices, builtInCalls, legacyCalls, ctx,
    instruction: () => advise(() => instruction),
    visible: () => ctx.bus.emitPipe('agent:tools:visible', { tools: [...tools.values()] }).tools,
    command: (args) => ctx.bus.emit('command:execute', { name: '/browser-use', args }),
    setHandler: (handler) => { handlePage = handler; },
    setAvailable: (value) => { available = value; },
  };
}

test('default advice prefers an explicit old workflow; external mode leaves every legacy tool intact', async (t) => {
  const browser = await fixture(t);
  const another = await fixture(t);
  const legacy = [...browser.tools.keys()].filter(name => name.startsWith('legacy_'));
  assert(browser.ctx.list().includes('command:/browser-use'));
  assert.match(browser.instruction(), /explicitly designates an existing Chromium session, script, or browser interface/);
  assert.match(browser.instruction(), /When the user has not specified a workflow, prefer browser_open/);
  assert.match(browser.instruction(), /Never switch to bypass a denial or automatically replay an uncertain action/);
  assert.equal(browser.visible().length, legacy.length + 6);
  browser.command('external');
  assert.match(browser.notices.at(-1), /停用本对话/);
  assert.match(browser.instruction(), /does not connect to Chromium or grant permissions/);
  assert.deepEqual(browser.visible().map(tool => tool.name), legacy);
  assert.equal(another.visible().length, legacy.length + 6, 'no other conversation changes mode');
  for (const tool of browser.tools.values()) {
    if (!tool.name.startsWith('browser_')) continue;
    const answer = await tool.execute({ url: 'https://example.test/' });
    assert(answer.isError && /External browser mode/.test(answer.content));
  }
  for (const tool of browser.visible()) {
    assert.equal(tool.execute({ session: 'existing-fixture' }).status, 'fixture-only');
  }
  assert.deepEqual(browser.legacyCalls.map(([name]) => name), legacy);
  assert.equal(browser.builtInCalls.length, 0, 'neither mode change nor legacy tools dispatch an inner-browser operation');
});

test('busy or uncertain work is not replayed; returning to built-in needs a fresh observation', async (t) => {
  const browser = await fixture(t);
  let settle;
  browser.setHandler(() => new Promise(resolve => { settle = resolve; }));
  const click = () => browser.tools.get('browser_act').execute({ action: 'click', ref: 'old-ref' });
  const pending = click();
  assert(settle);
  browser.command('external');
  assert.match(browser.notices.at(-1), /正在操作/);
  assert(browser.visible().some(tool => tool.name === 'browser_act'));
  settle({ status: 'unverified' });
  assert((await pending).isError);
  browser.command('external');
  browser.command('builtin');
  assert((await click()).isError);
  assert.deepEqual(browser.builtInCalls.map(request => request.op), ['click']);
  browser.setHandler(async () => { throw Error('No page'); });
  assert((await browser.tools.get('browser_observe').execute({})).isError);
  assert((await click()).isError, 'a failed observation cannot unlock actions');
  browser.setHandler(async req => req.op === 'observe'
    ? { url: 'https://example.test/', items: [{ name: 'button', ref: 'new-ref' }] }
    : { status: 'verified' });
  assert(!(await browser.tools.get('browser_observe').execute({})).isError);
  assert(!(await browser.tools.get('browser_act').execute({ action: 'click', ref: 'new-ref' })).isError);
  assert.deepEqual(browser.builtInCalls.map(request => request.op), ['click', 'observe', 'observe', 'click']);
});

test('optional slash component and unavailable internal service leave unrelated tools visible', async (t) => {
  const browser = await fixture(t, { slash: false });
  assert(!browser.ctx.list().includes('command:/browser-use'));
  assert.match(browser.instruction(), /existing Chromium session/);
  browser.setAvailable(false);
  assert.equal(browser.instruction(), '');
  assert(browser.visible().every(tool => tool.name.startsWith('legacy_chromium_')));
});

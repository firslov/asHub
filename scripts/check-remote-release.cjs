#!/usr/bin/env node
// The remote website is maintained outside the application repository. Run this
// in an assembled checkout before deploying it; never upload or deploy here.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseArgs } = require('node:util');

function plan(root, argv) {
  const { values } = parseArgs({ args: argv, options: {
    baseline: { type: 'string' }, ui: { type: 'boolean', default: false },
  }, allowPositionals: false });
  if (!values.baseline) throw new Error('Provide --baseline /path/to/released-desktop-checkout to verify released-client compatibility');
  const baseline = fs.realpathSync(path.resolve(values.baseline));
  if (baseline === fs.realpathSync(root)) throw new Error('The baseline must be a separate released desktop checkout');
  for (const file of ['remote/package.json', 'remote/server.mjs', 'remote/hub-test.cjs', 'remote/public/index.html', 'dist/remote/replay.js']) {
    if (!fs.existsSync(path.join(root, file))) throw new Error(`Required validation file is missing: ${file}`);
  }
  for (const file of ['package.json', 'src/hub.ts', 'web/index.html', 'node_modules/typescript/package.json']) {
    if (!fs.existsSync(path.join(baseline, file))) throw new Error(`Released desktop baseline is incomplete: ${file}`);
  }
  const baseVersion = JSON.parse(fs.readFileSync(path.join(baseline, 'package.json'), 'utf8')).version;
  const steps = [
    { name: 'Shared presentation and replay contracts', args: ['--test', 'tests/mobile-replay.mjs', 'tests/regression-conversation-presentation.cjs'] },
    { name: 'Current remote protocol and rendering', args: ['--test', 'remote/test.mjs', 'remote/render-test.mjs', 'remote/regression-test.mjs'] },
    { name: 'Current desktop integration', args: ['remote/hub-test.cjs'] },
    // The harness loads the source from ASHUB_TEST_ROOT; the gateway and web
    // files still come from this candidate checkout. No production accounts,
    // existing conversations or real model endpoints are used.
    { name: `Released desktop ${baseVersion} integration`, args: ['remote/hub-test.cjs'], env: { ASHUB_TEST_ROOT: baseline } },
  ];
  if (values.ui) {
    steps.push({ name: 'Desktop and remote queue interactions', electron: true, args: ['tests/electron-queue-actions.cjs', '--require-remote'] });
    for (const file of ['render-detail-test.cjs', 'render-layout-test.cjs', 'render-scroll-test.cjs', 'render-sidebar-test.cjs']) {
      steps.push({ name: `Chromium: ${file}`, electron: true, args: [`remote/${file}`] });
    }
    for (const file of ['render-detail-webkit.cjs', 'render-scroll-webkit.cjs', 'render-sidebar-webkit.cjs']) {
      steps.push({ name: `WebKit: ${file}`, args: [`remote/${file}`] });
    }
  }
  return { steps, ui: values.ui };
}
function check(root, argv) {
  const { steps, ui } = plan(root, argv);
  for (const step of steps) {
    console.log(`\n${step.name}`);
    const environment = { ...process.env, ASHUB_TEST_ROOT: root, ...step.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    const executable = step.electron ? require('electron') : process.execPath;
    const result = spawnSync(executable, step.args, { cwd: root, env: environment, stdio: 'inherit', timeout: 180_000 });
    if (result.error || result.status !== 0) throw new Error(`${step.name} failed: ${result.error?.message || result.signal || result.status}`);
  }
  console.log(ui ? 'Remote release checks passed, including released-desktop and browser checks.'
    : 'Remote protocol checks passed. Browser acceptance is still required: repeat with --ui before deployment.');
}
module.exports = { plan, check };
if (require.main === module) {
  try { check(path.resolve(__dirname, '..'), process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

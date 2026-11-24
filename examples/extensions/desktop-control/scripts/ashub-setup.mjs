import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { DesktopRuntime } from '../dist/runtime.js';
if (process.platform !== 'darwin' || Number(os.release().split('.')[0]) < 23) throw Error('Desktop control requires macOS 14 or later');
const home = process.env.AGENT_SH_HOME;
if (!home || !path.isAbsolute(home)) throw Error('Missing AGENT_SH_HOME');
const root = fileURLToPath(new URL('..', import.meta.url));
fs.accessSync(path.join(root, 'native/capture'), fs.constants.X_OK);
const runtime = new DesktopRuntime(path.join(home, 'settings.json'));
const stop = () => { void runtime.close().finally(() => process.exit(1)); };
process.once('SIGTERM', stop); process.once('SIGINT', stop);
try {
  const health = await runtime.ensureInstalled();
  if (!health.healthy) throw Error(runtime.error || health.healthError || 'Desktop runtime is unavailable');
  fs.writeFileSync(path.join(root, '.ashub-desktop-control'), 'ashub-desktop-control\n');
  console.log('Desktop runtime ready. Grant system permissions and choose allowed apps in plugin settings.');
} finally { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); await runtime.close(); }

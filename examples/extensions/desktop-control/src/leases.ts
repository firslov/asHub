import fs from 'node:fs';
import path from 'node:path';
import { DesktopService } from './service.js';
type Entry = { service: DesktopService; refs: number; stopWatching: () => void };
const entries = new Map<string, Entry>();
const closing = new Map<string, Promise<void>>();
/** One driver per settings file, owned entirely by the installed extension. */
export async function leaseService(file: string, factory = () => new DesktopService(file)) {
  const key = path.resolve(file);
  while (closing.has(key)) await closing.get(key);
  let entry = entries.get(key);
  if (!entry) {
    const service = factory();
    const changed = () => { void service.syncSettings().catch(() => {}); };
    fs.watchFile(key, { interval: 250, persistent: false }, changed);
    entry = { service, refs: 0, stopWatching: () => fs.unwatchFile(key, changed) };
    entries.set(key, entry);
  }
  entry.refs++;
  const owned = entry; let released = false;
  return { service: owned.service, async release() {
    if (released) return; released = true;
    if (--owned.refs !== 0) return;
    entries.delete(key); owned.stopWatching();
    const done = owned.service.close(); closing.set(key, done);
    try { await done; } finally { if (closing.get(key) === done) closing.delete(key); }
  } };
}

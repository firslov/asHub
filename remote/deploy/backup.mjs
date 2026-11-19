import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
const root = '/var/lib/ashub-mobile';
const dir = path.join(root, 'backups');
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const name = new Date().toISOString().replace(/[:.]/g, '-') + '.sqlite';
const db = new DatabaseSync(path.join(root, 'remote.sqlite'));
try { db.prepare('VACUUM INTO ?').run(path.join(dir, name)); } finally { db.close(); }
fs.chmodSync(path.join(dir, name), 0o600);
// Only expire backups created by this script; do not touch arbitrary files.
const backups = fs.readdirSync(dir).filter(n => /^\d{4}-\d{2}-\d{2}T[\dZ-]+\.sqlite$/.test(n)).sort().reverse();
for (const old of backups.slice(7)) fs.unlinkSync(path.join(dir, old));

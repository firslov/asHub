import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const code = (error: unknown) => (error as NodeJS.ErrnoException)?.code;
const busy = () => Object.assign(Error('后台存储正在保存，请稍后重试'), { code: 'ELOCKED' });

function removeOwner(lock: string, owner?: string): void {
  if (owner) {
    try { fs.rmdirSync(path.join(lock, owner)); }
    catch (error) { if (code(error) !== 'ENOENT') throw error; }
  }
  // Only an empty directory can be removed. A newly acquired lock has its
  // own marker and stays in place even if this is a delayed cleanup.
  try { fs.rmdirSync(lock); }
  catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(code(error) ?? '')) throw error; }
}

/** Coordinates writers to one ledger on the local machine. */
export function acquireLedgerLock(file: string): () => void {
  const lock = file + '.writer-lock';
  const stage = fs.mkdtempSync(lock + '-');
  const owner = `${process.pid}-${randomUUID()}`;
  try {
    // Publish ownership atomically. A live writer keeps its lock even when
    // suspended, and a process exit allows the next writer to reclaim it.
    fs.mkdirSync(path.join(stage, owner));
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.renameSync(stage, lock);
        return () => removeOwner(lock, owner);
      } catch (error) {
        const stat = fs.lstatSync(lock, { throwIfNoEntry: false });
        if (!stat) {
          if (attempt === 0 && ['ENOTEMPTY', 'EEXIST', 'EPERM'].includes(code(error) ?? '')) continue;
          throw error;
        }
        if (!stat.isDirectory()) throw busy();
        let markers: string[];
        try { markers = fs.readdirSync(lock); }
        catch (readError) {
          if (code(readError) === 'ENOENT') continue;
          throw readError;
        }
        if (markers.length === 1 && markers[0] === owner) return () => removeOwner(lock, owner);
        if (markers.length) {
          const match = markers.length === 1 && /^(\d+)-[\da-f-]{36}$/.exec(markers[0]!);
          const pid = match ? Number(match[1]) : 0;
          if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0x7fffffff) throw busy();
          try { process.kill(pid, 0); }
          catch (probeError) {
            if (code(probeError) !== 'ESRCH') throw busy();
            removeOwner(lock, markers[0]);
            continue;
          }
          throw busy();
        }
        removeOwner(lock);
      }
    }
    throw busy();
  } finally {
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* Cleanup cannot undo lock acquisition. */ }
  }
}

import * as fs from 'node:fs';
import { createHash, type Hash } from 'node:crypto';
import * as path from 'node:path';

type Checkpoint = { leaf: string | null; bytes: number; sha256: string };
type Snapshot = { frames: string[]; leaf: string | null };
type Waiter = { resolve(): void; reject(error: unknown): void };
type Pending = Snapshot & { waiters: Waiter[] };
type IO = Pick<typeof fs.promises, 'mkdir' | 'writeFile' | 'appendFile' | 'rename' | 'stat'>;

/** The existing SSE file remains readable by old clients. A byte count and hash
 * make the checkpoint the commit boundary: an interrupted append is never replayed. */
export function committedReplay(bytes: Buffer, saved: Record<string, unknown>): string {
  if (saved.bytes === undefined && saved.sha256 === undefined) return bytes.toString('utf8');
  if (!Number.isSafeInteger(saved.bytes) || (saved.bytes as number) < 0
      || (saved.bytes as number) > bytes.length || typeof saved.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(saved.sha256)) throw new SyntaxError('Invalid replay commit boundary');
  const committed = bytes.subarray(0, saved.bytes as number);
  if (createHash('sha256').update(committed).digest('hex') !== saved.sha256)
    throw new SyntaxError('Replay checkpoint does not match its contents');
  return committed.toString('utf8');
}

/** At most one write and one newest pending snapshot per session. Frames are
 * immutable strings; only their references are copied while waiting for disk.
 * Ordinary growth appends only new frames. In-place edits, rewind and branch
 * replacement keep the existing atomic snapshot path. */
export class ReplayWriter {
  private pending?: Pending;
  private running = false;
  private committed?: Snapshot & { bytes: number; hash: Hash; stamp: string };
  constructor(private file: string, private checkpoint: string, private io: IO = fs.promises,
    private allowed: () => boolean = () => true, private incremental = true) {}

  save(frames: readonly string[], leaf: string | null): Promise<void> {
    if (!this.allowed()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiters = this.pending?.waiters ?? [];
      waiters.push({ resolve, reject });
      // A newer complete projection subsumes pending older projections. Do not
      // serialize them before admission, or slow disks retain many full strings.
      this.pending = { frames: [...frames], leaf, waiters };
      if (!this.running) void this.drain();
    });
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      while (this.pending) {
        const next = this.pending;
        this.pending = undefined;
        try {
          if (this.allowed()) await this.write(next);
          for (const waiter of next.waiters) waiter.resolve();
        } catch (error) {
          // A partial append or a replaced file with an old checkpoint must be
          // repaired by an atomic snapshot before any later incremental write.
          this.committed = undefined;
          for (const waiter of next.waiters) waiter.reject(error);
        }
      }
    } finally { this.running = false; }
  }

  private async stamp(): Promise<string> {
    const stat = await this.io.stat(this.file);
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  }

  private async write(next: Snapshot): Promise<void> {
    const previous = this.committed;
    let append = this.incremental && !!previous && previous.frames.length <= next.frames.length
      && previous.frames.every((frame, i) => frame === next.frames[i]);
    if (append) {
      try { append = await this.stamp() === previous!.stamp; }
      catch { append = false; }
    }
    if (!this.allowed()) return;
    await this.io.mkdir(path.dirname(this.file), { recursive: true });
    const text = (append ? next.frames.slice(previous!.frames.length) : next.frames).join('');
    const hash = append ? previous!.hash.copy() : createHash('sha256');
    hash.update(text);
    const bytes = (append ? previous!.bytes : 0) + Buffer.byteLength(text);
    if (append) {
      if (text) await this.io.appendFile(this.file, text, 'utf8');
    } else {
      await this.io.writeFile(this.file + '.tmp', text, 'utf8');
      await this.io.rename(this.file + '.tmp', this.file);
    }
    const saved: Checkpoint = { leaf: next.leaf, bytes, sha256: hash.copy().digest('hex') };
    await this.io.writeFile(this.checkpoint + '.tmp', JSON.stringify(saved), 'utf8');
    await this.io.rename(this.checkpoint + '.tmp', this.checkpoint);
    this.committed = { frames: next.frames, leaf: next.leaf, bytes, hash, stamp: await this.stamp() };
  }
}

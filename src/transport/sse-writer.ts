import type { ServerResponse } from 'node:http';
import { setImmediate, clearImmediate, setTimeout, clearTimeout } from 'node:timers';
import { performance } from 'node:perf_hooks';

interface WriterOptions {
  /** Explicit live frames waiting behind a slow socket/history replay. */
  maxQueuedBytes?: number;
  maxQueuedFrames?: number;
  maxReplaySources?: number;
  batchBytes?: number;
  batchWrites?: number;
  batchMilliseconds?: number;
  drainTimeoutMs?: number;
}
type Frame = { kind: 'frame'; text: string; offset: number; bytes: number };
type Replay = { kind: 'replay'; source: Iterator<string>; current?: Frame; done(value: boolean): void };
type Barrier = { kind: 'barrier'; done(value: boolean): void };
type Item = Frame | Replay | Barrier;
const writers = new WeakMap<ServerResponse, SseWriter>();

/** One FIFO per HTTP connection, shared by all subscribed conversations.
 *
 * Live frames have bounded bytes/count; replay sources are read lazily and yield
 * between bounded batches. A false write means Node accepted that chunk: wait
 * for drain, never resend it. A slow consumer is disconnected, not allowed to
 * stall other clients or grow an unbounded socket buffer.
 *
 * Enqueue replay and its ending metadata synchronously, then attach live events
 * before awaiting the returned promise. Callers own a fixed replay snapshot:
 * yielding over a live, growing array would duplicate newly arriving events.
 */
export class SseWriter {
  private queue: Item[] = [];
  private queuedBytes = 0;
  private replaySources = 0;
  private blocked = false;
  private pumping = false;
  private stopped = false;
  private scheduled?: ReturnType<typeof setImmediate>;
  private drainTimer?: ReturnType<typeof setTimeout>;
  private readonly limits: Required<WriterOptions>;
  constructor(private response: ServerResponse, options: WriterOptions = {}) {
    this.limits = {
      maxQueuedBytes: 8 * 1024 * 1024, maxQueuedFrames: 1024, maxReplaySources: 1024,
      batchBytes: 256 * 1024, batchWrites: 64, batchMilliseconds: 4, drainTimeoutMs: 30_000,
      ...options,
    };
    for (const [key, value] of Object.entries(this.limits)) {
      if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) throw new Error(`Invalid SSE writer limit: ${key}`);
    }
    response.on('drain', this.onDrain);
    response.on('close', this.onClose);
    response.on('finish', this.onClose);
    // Retain this listener after disposal: an asynchronous socket error following
    // destroy must not become an unhandled EventEmitter error.
    response.on('error', this.onError);
  }
  get closed(): boolean { return this.stopped; }
  get pendingBytes(): number { return this.queuedBytes + (this.response.writableLength || 0); }
  get pendingFrames(): number { return this.queue.length; }

  write(text: string): boolean {
    if (!this.available()) return false;
    const bytes = Buffer.byteLength(text);
    // A single legitimate large image/result can be streamed without staging
    // its full bytes in Node's buffer. Only admit this exception at the head;
    // queued live traffic behind a stalled consumer remains strictly bounded.
    if (bytes > this.limits.maxQueuedBytes && !this.queue.length && !this.blocked) {
      void this.replay([text]);
      return !this.stopped;
    }
    if (this.queue.length >= this.limits.maxQueuedFrames || this.pendingBytes + bytes > this.limits.maxQueuedBytes) {
      this.close(); return false;
    }
    this.queuedBytes += bytes;
    this.queue.push({ kind: 'frame', text, offset: 0, bytes });
    this.pump();
    return !this.stopped;
  }

  /** Synchronously reserves the source's FIFO position; resolves false on close. */
  replay(frames: Iterable<string>): Promise<boolean> {
    if (!this.available()) return Promise.resolve(false);
    if (this.queue.length >= this.limits.maxQueuedFrames || this.replaySources >= this.limits.maxReplaySources) {
      this.close(); return Promise.resolve(false);
    }
    let source: Iterator<string>;
    try { source = frames[Symbol.iterator](); } catch { this.close(); return Promise.resolve(false); }
    return new Promise(resolve => {
      this.replaySources++;
      this.queue.push({ kind: 'replay', source, done: resolve });
      this.pump();
    });
  }

  /** A barrier for records already admitted; later live events do not delay it. */
  flush(): Promise<boolean> {
    if (!this.available()) return Promise.resolve(false);
    if (this.queue.length >= this.limits.maxQueuedFrames) { this.close(); return Promise.resolve(false); }
    return new Promise(resolve => { this.queue.push({ kind: 'barrier', done: resolve }); this.pump(); });
  }

  close(): void { this.dispose(true); }
  private available(): boolean {
    if (!this.stopped && (this.response.writableEnded || this.response.destroyed)) this.dispose(false);
    return !this.stopped;
  }
  private onDrain = () => {
    if (this.stopped) return;
    this.blocked = false;
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.drainTimer = undefined;
    this.pump();
  };
  private onClose = () => this.dispose(false);
  private onError = () => this.dispose(true);
  private dispose(destroy: boolean): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.scheduled) clearImmediate(this.scheduled);
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.scheduled = undefined; this.drainTimer = undefined;
    this.response.removeListener('drain', this.onDrain);
    this.response.removeListener('close', this.onClose);
    this.response.removeListener('finish', this.onClose);
    for (const item of this.queue.splice(0)) {
      if (item.kind === 'replay') {
        try { item.source.return?.(); } catch { /* No client remains to receive errors. */ }
        item.done(false);
      } else if (item.kind === 'barrier') item.done(false);
    }
    this.queuedBytes = 0; this.replaySources = 0;
    if (destroy && !this.response.destroyed) {
      try { this.response.destroy(); } catch { /* Already closed or test transport. */ }
    }
  }
  private later(): void {
    if (!this.scheduled && !this.stopped) this.scheduled = setImmediate(() => {
      this.scheduled = undefined; this.pump();
    });
  }
  private pump(): void {
    if (this.pumping || this.blocked || this.scheduled || !this.available()) return;
    this.pumping = true;
    let bytes = 0, writes = 0;
    const start = performance.now();
    try {
      while (this.queue.length && this.available() && !this.blocked) {
        if (writes >= this.limits.batchWrites || bytes >= this.limits.batchBytes
          || performance.now() - start >= this.limits.batchMilliseconds) { this.later(); break; }
        const item = this.queue[0]!;
        if (item.kind === 'barrier') { this.queue.shift(); item.done(true); continue; }
        let frame: Frame;
        if (item.kind === 'replay') {
          if (!item.current) {
            const next = item.source.next();
            if (next.done) { this.queue.shift(); this.replaySources--; item.done(true); continue; }
            if (typeof next.value !== 'string') throw new Error('Invalid SSE replay frame');
            item.current = { kind: 'frame', text: next.value, offset: 0, bytes: 0 };
          }
          frame = item.current;
        } else frame = item;
        // Bound Node's native buffer even when a history record contains a large
        // image/result. Keep valid UTF-16 pairs intact across individual writes.
        const chunkUnits = Math.max(2, Math.min(16_384, Math.floor(this.limits.maxQueuedBytes / 3)));
        let end = Math.min(frame.text.length, frame.offset + chunkUnits);
        if (end < frame.text.length && end > frame.offset) {
          const left = frame.text.charCodeAt(end - 1), right = frame.text.charCodeAt(end);
          if (left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff) end--;
        }
        const chunk = frame.text.slice(frame.offset, end), size = Buffer.byteLength(chunk);
        if (this.pendingBytes + (item.kind === 'replay' ? size : 0) > this.limits.maxQueuedBytes) { this.close(); break; }
        frame.offset = end;
        if (item.kind === 'frame') { this.queuedBytes -= size; frame.bytes -= size; }
        if (end === frame.text.length) {
          if (item.kind === 'replay') item.current = undefined;
          else this.queue.shift();
        }
        bytes += size; writes++;
        const writable = this.response.write(chunk);
        if (this.stopped) break;
        if (writable === false) {
          this.blocked = true;
          this.drainTimer = setTimeout(() => this.close(), this.limits.drainTimeoutMs);
          this.drainTimer.unref?.();
        }
      }
    } catch { this.close(); }
    finally { this.pumping = false; }
  }
}

export function getSseWriter(response: ServerResponse): SseWriter {
  let writer = writers.get(response);
  if (!writer) { writer = new SseWriter(response); writers.set(response, writer); }
  return writer;
}

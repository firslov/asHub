import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export interface ApprovalItem { title: string; fields: Array<{ label: string; value: string }> }
export interface ApprovalPreview { title: string; items: ApprovalItem[] }
export type Approve = (preview: ApprovalPreview, signal?: AbortSignal) => Promise<boolean>;
export interface HostAccess {
  catalog(signal?: AbortSignal): Promise<unknown>;
  execute(request: unknown, approve: Approve, signal?: AbortSignal): Promise<unknown>;
}
export interface Operation { type: string; input: Record<string, unknown> }
export interface PreparedOperation {
  preview: ApprovalItem;
  validate(): void | Promise<void>;
  execute(): Promise<unknown>;
}
type Receipt = { fingerprint: string; status: string; results: unknown[]; error?: string };
const stable = (v: any): string => JSON.stringify(v, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]])) : value);

/** Generic, source-bound operation gateway. Plugins never receive approval tokens.
 * Persist before side effects: after a crash, an uncertain operation is reported,
 * never replayed automatically. Results are durable receipts, not transactions. */
export class HostOperations {
  private pending = new Map<string, { fingerprint: string; promise: Promise<Receipt> }>();
  constructor(private directory: string) {}
  async run(sourceId: string, raw: unknown, prepare: (op: Operation) => Promise<PreparedOperation>, approve: Approve, signal?: AbortSignal): Promise<Receipt> {
    signal?.throwIfAborted();
    const json = JSON.stringify(raw);
    if (!json || Buffer.byteLength(json, 'utf8') > 100_000) throw new Error('Invalid operation request');
    // Detach every parameter from the caller before validation or approval.
    const request = JSON.parse(json);
    if (!request || typeof request.idempotencyKey !== 'string' || !/^[\w-]{8,100}$/.test(request.idempotencyKey)
      || !Array.isArray(request.operations) || !request.operations.length || request.operations.length > 12) throw new Error('Expected idempotencyKey and 1–12 operations');
    for (const op of request.operations) if (!op || typeof op.type !== 'string' || !op.input || typeof op.input !== 'object' || Array.isArray(op.input)) throw new Error('Invalid operation');
    const fingerprint = createHash('sha256').update(stable(request.operations)).digest('hex');
    const key = createHash('sha256').update(sourceId + ':' + request.idempotencyKey).digest('hex');
    const file = path.join(this.directory, key + '.json');
    const active = this.pending.get(key);
    if (active) {
      if (active.fingerprint !== fingerprint) throw new Error('Idempotency key already used with different parameters');
      return active.promise;
    }
    try {
      const receipt = JSON.parse(fs.readFileSync(file, 'utf8')) as Receipt;
      if (receipt.fingerprint !== fingerprint) throw new Error('Idempotency key already used with different parameters');
      return receipt.status === 'running' ? { ...receipt, status: 'interrupted', error: 'Execution was interrupted; inspect existing results before a new request' } : receipt;
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const work = async (): Promise<Receipt> => {
      const operations: PreparedOperation[] = [];
      for (const op of request.operations) { signal?.throwIfAborted(); operations.push(await prepare(op)); }
      const preview = { title: '确认操作 / Confirm operations', items: operations.map(op => op.preview) };
      if (!await approve(preview, signal)) return { fingerprint, status: 'denied', results: [] };
      signal?.throwIfAborted();
      // Revalidate all items before any side effect, and again per operation.
      for (const op of operations) await op.validate();
      signal?.throwIfAborted();
      const receipt: Receipt = { fingerprint, status: 'running', results: [] };
      const save = () => {
        fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        const tmp = file + '.' + randomUUID() + '.tmp';
        try { fs.writeFileSync(tmp, JSON.stringify(receipt), { mode: 0o600 }); fs.renameSync(tmp, file); }
        finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
      };
      save();
      try {
        for (const op of operations) {
          signal?.throwIfAborted(); await op.validate(); signal?.throwIfAborted();
          receipt.results.push(await op.execute()); save();
        }
        receipt.status = 'completed';
      } catch (e) { receipt.status = 'failed'; receipt.error = String(e); }
      try { save(); }
      catch (e) {
        // The initial running receipt already prevents replay. Return known
        // results even if storage fails after side effects have taken place.
        receipt.status = 'failed';
        receipt.error = [receipt.error, `Receipt persistence failed: ${String(e)}`].filter(Boolean).join('; ');
      }
      return receipt;
    };
    const promise = work(); this.pending.set(key, { fingerprint, promise });
    try { return await promise; } finally { this.pending.delete(key); }
  }
}

/** Explicit approvals are intentionally separate from file-tool auto-approval. */
export class ExplicitApprovals {
  private pending = new Map<string, (allowed: boolean) => void>();
  constructor(private emit: (name: string, payload: unknown) => void, private timeoutMs = 300_000) {}
  request(preview: ApprovalPreview, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    const requestId = randomUUID(), expiresAt = Date.now() + this.timeoutMs;
    return new Promise(resolve => {
      const finish = (allowed: boolean) => {
        if (!this.pending.delete(requestId)) return;
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        allowed = allowed && Date.now() < expiresAt && !signal?.aborted;
        this.emit('permission:resolved', { requestId, outcome: allowed ? 'approved' : 'denied' });
        resolve(allowed);
      };
      const abort = () => finish(false);
      const timer = setTimeout(abort, this.timeoutMs);
      this.pending.set(requestId, finish);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      this.emit('permission:request', { ...preview, kind: 'operation', requestId, expiresAt, durationMs: this.timeoutMs, explicit: true });
    });
  }
  decide(id: string, outcome: string): boolean {
    const finish = this.pending.get(id);
    if (!finish) return false;
    finish(outcome === 'approved'); return true;
  }
  cancel() { for (const finish of this.pending.values()) finish(false); }
}

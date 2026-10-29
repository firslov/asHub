import { randomUUID } from 'node:crypto';

export interface HostVersion { epoch: string; revision: number }
export interface HostInvalidation extends HostVersion {
  version: 1;
  kind: 'sessions' | 'projects' | 'network' | 'extensions' | 'configuration';
  id?: string;
}

/** Bounded, application-owned invalidations. Consumers refetch snapshots after
 * reconnecting; no conversation text, credentials or approval tokens are emitted. */
export class HostEvents {
  private readonly epoch = randomUUID();
  private revision = 0;
  private listeners = new Set<(event: HostInvalidation) => void>();
  private disposed = false;
  version(): HostVersion { return { epoch: this.epoch, revision: this.revision }; }
  publish(kind: HostInvalidation['kind'], id?: string): void {
    if (this.disposed) return;
    this.revision++;
    const event: HostInvalidation = Object.freeze({ version: 1, ...this.version(), kind, ...(id ? { id } : {}) });
    for (const listener of [...this.listeners]) {
      try { listener(event); } catch { /* A disconnected client cannot fail a committed command. */ }
    }
  }
  subscribe(listener: (event: HostInvalidation) => void): () => void {
    if (this.disposed) throw new Error('Host shutting down');
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  close(): void { this.disposed = true; this.listeners.clear(); }
}

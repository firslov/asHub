import type * as http from 'node:http';
import type { HostEvents } from '../services/host-events.js';
import { HOST_OPERATION_TYPES, type HostCapabilities } from '../services/host-contract.js';

export const HOST_CAPABILITIES = Object.freeze({
  version: 1, hostApi: 1,
  queries: ['capabilities', 'snapshot'],
  operations: HOST_OPERATION_TYPES,
  events: { transport: 'sse', path: '/api/host/events', mode: 'invalidation', reconnect: 'refetch-snapshot' },
  approval: 'source-bound-explicit', receipts: 'durable-partial-results',
} satisfies HostCapabilities);

export interface HostQueryRuntime { events: HostEvents; snapshot(): unknown; signal: AbortSignal }

/** Additive read-only protocol behind the same host/origin/auth gate as legacy
 * APIs. There is deliberately no HTTP shortcut around explicit approvals. */
export function handleHostQuery(req: http.IncomingMessage, res: http.ServerResponse, runtime: HostQueryRuntime): boolean {
  const pathname = (req.url ?? '').split('?')[0];
  if (!['/api/host/capabilities', '/api/host/snapshot', '/api/host/events'].includes(pathname)) return false;
  if (req.method !== 'GET') { res.writeHead(405); res.end('Method not allowed'); return true; }
  if (pathname !== '/api/host/events') {
    const body = JSON.stringify(pathname.endsWith('/capabilities') ? HOST_CAPABILITIES : runtime.snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(body);
    return true;
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  let ended = false;
  let dispose = () => {};
  const cleanup = () => {
    if (ended) return;
    ended = true; dispose(); clearInterval(heartbeat);
    runtime.signal.removeEventListener('abort', end);
    res.removeListener('close', cleanup);
  };
  const end = () => { cleanup(); res.end(); };
  const write = (name: string, value: unknown) => {
    if (ended) return;
    const version = runtime.events.version();
    // Slow/disconnected consumers refetch on reconnect instead of accumulating
    // an unbounded application-wide event queue in memory.
    try { if (!res.write(`id: ${version.epoch}:${version.revision}\nevent: ${name}\ndata: ${JSON.stringify(value)}\n\n`)) end(); }
    catch { end(); }
  };
  const heartbeat = setInterval(() => {
    if (res.writableEnded) { cleanup(); return; }
    try { if (!res.write(': heartbeat\n\n')) end(); } catch { end(); }
  }, 25_000);
  res.on('error', () => {});
  res.once('close', cleanup);
  runtime.signal.addEventListener('abort', end, { once: true });
  try { dispose = runtime.events.subscribe(event => write('invalidation', event)); }
  catch { end(); return true; }
  write('snapshot', { version: 1, ...runtime.events.version(), refetch: '/api/host/snapshot' });
  if (runtime.signal.aborted) end();
  return true;
}

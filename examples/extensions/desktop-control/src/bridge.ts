import { randomUUID } from 'node:crypto';
import { dataOf } from './mcp.js';
import type { DesktopService } from './service.js';
import { isChildExecution } from './isolation.js';
import { describeDesktopWindow } from './approval-window.js';
export const BRIDGE = 'desktop-control:bridge:v1';
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(Error('Desktop operation cancelled')); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    pending.then(v => { cleanup(); resolve(v); }, e => { cleanup(); reject(e); });
    if (signal.aborted) abort();
  });
}
/** Scoped public bridge: every consumer shares the existing service and queue. */
export function registerDesktopBridge(ctx: any, service: DesktopService): void {
  const lifetime = new AbortController();
  const clients = new Set<{ close(): Promise<void>; interrupt(): void }>();
  const guard = () => {
    if (lifetime.signal.aborted) throw Error('Desktop plugin is closed');
    if (isChildExecution()) throw Error('Desktop control is unavailable to subagents');
  };
  for (const event of ['agent:processing-done', 'agent:cancel-request', 'agent:error']) ctx.bus.on(event, () => {
    for (const client of clients) client.interrupt();
  });
  ctx.onDispose(() => { lifetime.abort(); for (const client of clients) void client.close(); clients.clear(); });
  // advise is tracked by PluginRuntime, whereas a bare define would outlive disposal.
  ctx.advise(BRIDGE, () => {
    guard();
    return Object.freeze({
      protocol: 1,
      // Capture once per compound operation, including time outside a desktop lease.
      get cancellationSignal() { guard(); return AbortSignal.any([lifetime.signal, service.cancellationSignal]); },
      async status() { guard(); return service.status(true); },
      python() { guard(); if (!service.runtime.installed) throw Error('Run /desktop install first'); return service.runtime.python; },
      connect({ bundleId, lifetime: consumerSignal }: { bundleId: string; lifetime: AbortSignal }) {
        guard();
        if (typeof bundleId !== 'string' || !/^[\w-]+(?:\.[\w-]+)+$/.test(bundleId) || !consumerSignal?.addEventListener) throw Error('Invalid desktop consumer');
        const owner = Symbol(bundleId), closed = new AbortController();
        let running = false, active: AbortController | undefined;
        const check = () => { guard(); if (closed.signal.aborted || consumerSignal.aborted) throw Error('Desktop consumer closed'); };
        const client = {
          async windows(signal: AbortSignal) { check(); return service.windows(bundleId, AbortSignal.any([signal, lifetime.signal, consumerSignal, closed.signal, service.cancellationSignal])); },
          interrupt() { active?.abort(); void service.finish(owner); },
          async close() { closed.abort(); consumerSignal.removeEventListener('abort', close); clients.delete(client); await service.finish(owner); },
          async withWindow<T>(options: { windowId: number; goal: string; signal: AbortSignal }, fn: (port: any) => Promise<T>): Promise<T> {
            check(); if (running) throw Error('Desktop consumer already has a task');
            if (typeof options.goal !== 'string' || !options.goal.trim() || options.goal.length > 500) throw Error('Invalid desktop goal');
            running = true; active = new AbortController();
            const signal = AbortSignal.any([options.signal, active.signal, lifetime.signal, consumerSignal, closed.signal, service.cancellationSignal]);
            let valid = true;
            const timings = { windowDiscoveryMs: 0, approvalMs: 0, acquisitionMs: 0, observeMs: 0, screenshotMs: 0, inputMs: 0, captures: 0, reusedObservations: 0 };
            const call = async (name: Parameters<DesktopService['call']>[1], args: Record<string, unknown>) => {
              check(); signal.throwIfAborted(); if (!valid) throw Error('Window handle expired');
              return service.call(owner, name, args, signal);
            };
            try {
              let started = performance.now();
              const available = await service.windows(bundleId, signal);
              timings.windowDiscoveryMs = performance.now() - started;
              const window = available.windows.find((w: any) => w.window_id === options.windowId);
              if (!window) throw Error('Select an existing window');
              started = performance.now();
              const permission: any = await abortable(ctx.bus.emitPipeAsync('permission:request', {
                signal, kind: `desktop-control:${bundleId}`, title: `Desktop control · ${bundleId}`,
                description: `${describeDesktopWindow(window)}\n${options.goal}\nRead and operate this window. Local screenshots may be analyzed and relevant text returned to the model.`,
                metadata: { application: bundleId, windowId: options.windowId },
              }), signal);
              timings.approvalMs = performance.now() - started;
              signal.throwIfAborted(); if (permission?.decision?.outcome !== 'approved') throw Error('Desktop control was not approved');
              started = performance.now();
              const acquired = await service.acquire(owner, bundleId, options.windowId, signal);
              timings.acquisitionMs = performance.now() - started;
              // Reuse only the immediately preceding, same-task observation, once.
              // Every capture still requests a new screenshot; driver stale-state checks remain in place.
              let observed: { snapshot: string; at: number } | undefined;
              const remember = (state: any) => {
                observed = state?.window_id === options.windowId && typeof state.snapshot === 'string'
                  ? { snapshot: state.snapshot, at: performance.now() } : undefined;
              };
              remember(acquired);
              let frame: { id: string; snapshot: string; at: number } | undefined;
              const port = {
                windowId: options.windowId, signal, timings,
                async capture() {
                  const cached = observed; observed = undefined; frame = undefined;
                  let state: any;
                  if (cached && performance.now() - cached.at <= 250) { state = cached; timings.reusedObservations++; }
                  else { const start = performance.now(); state = dataOf(await call('observe', {})); timings.observeMs += performance.now() - start; }
                  const start = performance.now();
                  const result = await call('screenshot', { snapshot: state.snapshot });
                  timings.screenshotMs += performance.now() - start; timings.captures++;
                  const geometry = dataOf(result).screenshot;
                  const image = result.content.find(c => c.type === 'image' && c.mimeType === 'image/png');
                  if (!image?.data) throw Error('Driver returned no PNG');
                  frame = { id: randomUUID(), snapshot: state.snapshot, at: Date.now() };
                  return { frameRef: frame.id, width: geometry.width, height: geometry.height, scale: geometry.scale, png: image.data, capturedAt: frame.at };
                },
                async input(input: any) {
                  check(); signal.throwIfAborted();
                  if (!frame || frame.id !== input.frameRef || Date.now() - frame.at > 5000) throw Error('Capture a fresh frame before input');
                  const snapshot = frame.snapshot; frame = undefined;
                  observed = undefined;
                  const operate = async (name: Parameters<DesktopService['call']>[1], args: Record<string, unknown>) => {
                    const start = performance.now();
                    try { const data = dataOf(await call(name, args)); remember(data.fresh); return data; }
                    finally { timings.inputMs += performance.now() - start; }
                  };
                  if (input.operation === 'click') {
                    if (![input.x,input.y].every(Number.isFinite)) throw Error('Invalid coordinates');
                    return operate('click_at', { snapshot, x: input.x, y: input.y });
                  }
                  if (input.operation === 'text') {
                    if (typeof input.text !== 'string' || !input.text || input.text.length > 10000 || !input.text.isWellFormed()) throw Error('Invalid input text');
                    return operate('type_text', { snapshot, text: input.text });
                  }
                  if (input.operation === 'keys' && ['MOD+A', 'BACKSPACE', 'ESC'].includes(input.keys)) {
                    return operate('press', { snapshot, keys: input.keys });
                  }
                  throw Error('Unsupported desktop input');
                },
              };
              const result = await fn(port); signal.throwIfAborted(); return result;
            } finally { valid = false; active?.abort(); await service.finish(owner); active = undefined; running = false; }
          },
        };
        const close = () => { void client.close(); };
        clients.add(client); consumerSignal.addEventListener('abort', close, { once: true });
        if (consumerSignal.aborted) close();
        return client;
      },
    });
  });
}

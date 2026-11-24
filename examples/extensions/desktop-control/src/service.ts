import { captureWindow, supportsModernCapture } from './capture.js';
import { StdioDriver, dataOf, type DriverClient, type McpResult } from './mcp.js';
import { DesktopRuntime } from './runtime.js';
import { readDesktopSettings, settingsRevision, writeDesktopSettings } from './settings.js';
export interface DesktopApp { pid: number; name: string; bundle_id: string }
type Ticket = { owner: symbol; bundle: string; window: number; signal?: AbortSignal; resolve: (r: any) => void; reject: (e: Error) => void; cleanup: () => void };
type WindowSize = { width: number; height: number };
type Capture = { metadata: WindowSize & { snapshot: string; scale: number }; windowSize?: WindowSize };
type Task = { owner: symbol; bundle: string; pid: number; window: number; controller: AbortController; snapshots: Set<string>; timer: ReturnType<typeof setTimeout>; finish?: Promise<void>; capture?: Capture };
const abortError = () => Object.assign(Error('Desktop task cancelled'), { name: 'AbortError' });
export class StaleWindowCaptureError extends Error {
  constructor() {
    super('Window size changed or could not be verified. Take a fresh screenshot before coordinate input.');
  }
}
export class DesktopService {
  readonly runtime: DesktopRuntime;
  private driver?: DriverClient;
  private serial: Promise<unknown> = Promise.resolve();
  private queue: Ticket[] = [];
  private active?: Task;
  private closed = false;
  private configuration = '';
  private currentConfiguration(): string {
    try { return settingsRevision(readDesktopSettings(this.file)); } catch { return 'invalid'; }
  }
  async syncSettings(): Promise<void> {
    const revision = this.currentConfiguration();
    if (revision !== this.configuration) { this.configuration = revision; await this.stop(); }
  }
  private cancellation = new AbortController();
  get cancellationSignal(): AbortSignal { return this.cancellation.signal; }
  constructor(readonly file: string, private options: { platform?: NodeJS.Platform; factory?: () => DriverClient; taskMs?: number; queueMs?: number; capture?: typeof captureWindow } = {}) {
    this.runtime = new DesktopRuntime(file, options.platform ?? process.platform);
    this.configuration = this.currentConfiguration();
  }
  private get platform() { return this.options.platform ?? process.platform; }
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.serial.then(fn); this.serial = next.catch(() => {}); return next;
  }
  private client(): DriverClient {
    if (this.closed) throw Error('Desktop service is closed');
    if (this.platform !== 'darwin') throw Error('Desktop control currently supports macOS only');
    if (!this.driver) {
      if (!this.options.factory && !this.runtime.installed) throw Error('Run /desktop install first');
      this.driver = this.options.factory?.() ?? new StdioDriver(this.runtime.python, ['-I', '-B', '-m', 'arc_cua', 'mcp']);
    }
    return this.driver;
  }
  private allowed(bundle: string): void {
    const config = readDesktopSettings(this.file);
    if (!config.enabled) throw Error('Desktop control is disabled; configure the plugin or run /desktop enable');
    if (!config.allowedApps.includes(bundle)) throw Error('This app is not allowed. Add its Bundle ID in the plugin configuration or use /desktop allow.');
  }
  private async rpc(name: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<McpResult> {
    const driver = this.client();
    try { return await driver.call(name, args, signal); }
    catch (e) {
      if (!signal?.aborted && this.driver === driver) {
        this.driver = undefined;
        // Snapshot IDs belong to this driver process. A replacement can reuse
        // them, so neither the task nor its captured coordinates may survive.
        const task = this.active;
        if (task) {
          task.snapshots.clear(); task.capture = undefined;
          // Queue cleanup after this RPC: awaiting it here would deadlock serial.
          void this.finish(task.owner);
        }
        await driver.close();
      }
      throw e;
    }
  }
  async status(inspect = false): Promise<any> {
    const config = readDesktopSettings(this.file);
    const signal = this.cancellationSignal;
    const runtime = await this.runtime.health();
    const result: any = { ...runtime, supported: this.platform === 'darwin', config, revision: settingsRevision(config), busy: !!this.active, application: this.active?.bundle, queued: this.queue.length, captureBackend: config.captureBackend === 'screencapturekit' ? 'ScreenCaptureKit' : 'CoreGraphics (legacy)' };
    if (inspect && !signal.aborted && result.supported && (runtime.healthy || this.options.factory)) {
      try {
        await this.exclusive(async () => {
          result.driver = dataOf(await this.rpc('status', {}, signal));
          result.apps = dataOf(await this.rpc('apps', {}, signal)).apps;
        });
      } catch (e) {
        if (!signal.aborted) { result.driverError = (e as Error).message; if (!this.active) await this.resetDriver(); }
      }
    }
    result.busy = !!this.active; result.application = this.active?.bundle; result.queued = this.queue.length;
    return result;
  }
  async save(config: unknown, revision: unknown): Promise<any> {
    writeDesktopSettings(this.file, config, revision);
    this.configuration = this.currentConfiguration();
    // Revoke immediately, including tasks already queued under earlier settings.
    await this.stop();
    return this.status();
  }
  async apps(signal?: AbortSignal): Promise<any> {
    if (!readDesktopSettings(this.file).enabled) throw Error('Enable desktop-control in the plugin configuration or run /desktop enable');
    return this.exclusive(async () => {
      const apps: DesktopApp[] = dataOf(await this.rpc('apps', {}, signal)).apps;
      const allowed = readDesktopSettings(this.file).allowedApps;
      return { apps: apps.filter(a => allowed.includes(a.bundle_id)) };
    });
  }
  async windows(bundle: string, signal?: AbortSignal): Promise<any> {
    this.allowed(bundle);
    return this.exclusive(async () => {
      this.allowed(bundle);
      const apps: DesktopApp[] = dataOf(await this.rpc('apps', {}, signal)).apps;
      const app = apps.find(a => a.bundle_id === bundle); if (!app) throw Error('Open the allowed app first');
      return dataOf(await this.rpc('windows', { pid: app.pid }, signal));
    });
  }
  acquire(owner: symbol, bundle: string, window: number, signal?: AbortSignal): Promise<any> {
    this.allowed(bundle);
    if (!Number.isSafeInteger(window) || window <= 0) return Promise.reject(Error('Choose a window_id from desktop_windows'));
    if (signal?.aborted || this.closed) return Promise.reject(abortError());
    if (this.active?.owner === owner || this.queue.some(t => t.owner === owner)) return Promise.reject(Error('This conversation already has a desktop task. Finish it before starting another.'));
    if (this.queue.length >= 32) return Promise.reject(Error('Desktop task queue is full'));
    return new Promise((resolve, reject) => {
      const abort = () => { this.queue = this.queue.filter(t => t !== ticket); cleanup(); reject(abortError()); if (this.active?.owner === owner) void this.finish(owner); };
      const timer = setTimeout(abort, this.options.queueMs ?? 600_000); timer.unref();
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      const ticket: Ticket = { owner, bundle, window, signal, resolve, reject, cleanup };
      this.queue.push(ticket); signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort(); else this.pump();
    });
  }
  private pump(): void {
    if (this.active || this.closed) return;
    const ticket = this.queue.shift(); if (!ticket) return;
    const controller = new AbortController();
    const timer = setTimeout(() => { void this.finish(ticket.owner); }, this.options.taskMs ?? 300_000); timer.unref();
    const task: Task = { owner: ticket.owner, bundle: ticket.bundle, pid: 0, window: ticket.window, controller, snapshots: new Set(), timer };
    this.active = task;
    void this.exclusive(async () => {
      this.allowed(task.bundle);
      const signal = ticket.signal ? AbortSignal.any([ticket.signal, controller.signal]) : controller.signal;
      const state = dataOf(await this.rpc('status', {}, signal));
      if (!state.permissions?.accessibility) throw Error('Grant Accessibility permission to asHub in macOS System Settings, then retry');
      if (!state.background_input) throw Error('Background control is unavailable on this macOS version');
      const apps: DesktopApp[] = dataOf(await this.rpc('apps', {}, signal)).apps;
      const app = apps.find(a => a.bundle_id === task.bundle); if (!app) throw Error('Target app has closed');
      task.pid = app.pid;
      const windows = dataOf(await this.rpc('windows', { pid: task.pid }, signal)).windows;
      if (!windows.some((w: any) => w.window_id === task.window)) throw Error('Target window has closed; list windows again');
      const result = dataOf(await this.rpc('observe', { pid: task.pid, window_id: task.window }, signal));
      if (signal.aborted) throw abortError();
      this.remember(task, result); return result;
    }).then(result => { ticket.cleanup(); ticket.resolve(result); }, async error => {
      ticket.cleanup(); await this.finish(task.owner); ticket.reject(error);
    });
  }
  private task(owner: symbol): Task {
    const task = this.active;
    if (!task || task.owner !== owner || task.finish || task.controller.signal.aborted) throw Error('No active desktop task in this conversation. Start a new task and observe again.');
    this.allowed(task.bundle); return task;
  }
  private remember(task: Task, value: any): void {
    const snapshot = value.fresh ?? value;
    // A settled action can open a new window. Do not silently adopt that target.
    if (snapshot.snapshot && snapshot.window_id === task.window) {
      task.snapshots.add(snapshot.snapshot);
      if (task.snapshots.size > 64) task.snapshots.delete(task.snapshots.values().next().value!);
    }
  }
  private async windowSize(task: Task, signal: AbortSignal, onScreenOnly = false): Promise<WindowSize | undefined> {
    const result = await this.rpc('windows', { pid: task.pid }, signal);
    if (result.isError) return;
    const { windows } = dataOf(result) ?? {};
    const window = Array.isArray(windows) ? windows.find(window => window?.window_id === task.window) : undefined;
    if (onScreenOnly && window?.on_screen !== true) return;
    const bounds = window?.bounds;
    if (!bounds) return;
    const { width, height } = bounds;
    if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) return { width, height };
  }
  async call(owner: symbol, name: 'observe' | 'act' | 'screenshot' | 'click_at' | 'drag' | 'scroll_at' | 'press' | 'type_text', args: Record<string, unknown>, signal?: AbortSignal): Promise<McpResult> {
    const task = this.task(owner);
    return this.exclusive(async () => {
      if (this.task(owner) !== task) throw abortError();
      const combined = signal ? AbortSignal.any([signal, task.controller.signal]) : task.controller.signal;
      if (combined.aborted) throw abortError();
      if (name !== 'observe' && (typeof args.snapshot !== 'string' || !task.snapshots.has(args.snapshot))) throw Error('Use a snapshot returned to this task by desktop_start or desktop_observe');
      if (Object.keys(args).some(k => ['pid', 'window_id', 'screenshot'].includes(k))) throw Error('Targets are fixed by desktop_start');
      const apps: DesktopApp[] = dataOf(await this.rpc('apps', {}, combined)).apps;
      if (!apps.some(a => a.pid === task.pid && a.bundle_id === task.bundle)) throw Error('Target application changed; start a new task');
      args = { ...args };
      if (['click_at', 'drag', 'scroll_at'].includes(name)) {
        const capture = task.capture;
        if (!capture || capture.metadata.snapshot !== args.snapshot) throw Error('Take a screenshot with this snapshot before coordinate input');
        const { metadata, windowSize: capturedSize } = capture;
        const point = (x: unknown, y: unknown) => {
          if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= metadata.width || y >= metadata.height) throw Error('Point is outside the captured image');
          return [x / metadata.scale, y / metadata.scale];
        };
        if (name === 'drag') args.points = (args.points as number[][]).map(p => point(p[0], p[1]));
        else [args.x, args.y] = point(args.x, args.y);
        if (name === 'scroll_at') { args.dx = Number(args.dx) / metadata.scale; args.dy = Number(args.dy) / metadata.scale; }
        // Inputs are window-relative and still valid after a move without resizing.
        const currentSize = capturedSize && await this.windowSize(task, combined);
        combined.throwIfAborted();
        if (!capturedSize || !currentSize || currentSize.width !== capturedSize.width || currentSize.height !== capturedSize.height) {
          task.capture = undefined;
          throw new StaleWindowCaptureError();
        }
      }
      const target = name === 'act' ? {} : { pid: task.pid, window_id: task.window };
      const input = { ...args, ...target, ...(!['observe', 'screenshot'].includes(name) ? { settle: true } : {}) };
      if (!['observe', 'screenshot'].includes(name)) task.capture = undefined;
      // New capture stays inside the same authorized task and serialized queue.
      // Native input continues to validate the original driver snapshot.
      if (name === 'screenshot') task.capture = undefined;
      const configuredModern = readDesktopSettings(this.file).captureBackend === 'screencapturekit';
      if (name === 'screenshot' && configuredModern && !this.options.capture && !supportsModernCapture()) throw Error('ScreenCaptureKit capture requires macOS 14 or newer');
      const modern = name === 'screenshot' && (this.options.capture || configuredModern);
      // A hidden window may be parked by the legacy capture driver, changing the reported bounds.
      const initialSize = name === 'screenshot' ? await this.windowSize(task, combined, true) : undefined;
      combined.throwIfAborted();
      const result = modern
        ? await (this.options.capture ?? captureWindow)(task.pid, task.window, combined)
        : await this.rpc(name, input, combined);
      combined.throwIfAborted();
      const data = dataOf(result);
      // arc may observe another window after an action closes the chosen one.
      // That window has not been selected by this task: do not expose its contents.
      const observed = data.fresh ?? (name === 'observe' ? data : undefined);
      if (observed && observed.window_id !== task.window) throw Error('Target window changed or closed. The action may have completed; choose a window and start a new task before continuing.');
      if (name === 'screenshot') {
        const c = data.screenshot;
        if (!c || c.window_id !== task.window || !Number.isFinite(c.scale) || c.scale <= 0 || !Number.isFinite(c.width) || !Number.isFinite(c.height)) throw Error('Invalid screenshot geometry');
        const windowSize = await this.windowSize(task, combined);
        combined.throwIfAborted();
        const resized = initialSize && windowSize && (initialSize.width !== windowSize.width || initialSize.height !== windowSize.height);
        task.capture = {
          metadata: { snapshot: String(args.snapshot), scale: c.scale, width: c.width, height: c.height },
          windowSize: resized ? undefined : windowSize,
        };
      }
      if (name === 'observe' && task.capture) {
        data.lastScreenshot = task.capture.metadata;
        result.structuredContent = data;
      }
      this.remember(task, data); return result;
    });
  }
  finish(owner: symbol): Promise<void> {
    for (const ticket of this.queue.filter(t => t.owner === owner)) { ticket.cleanup(); ticket.reject(abortError()); }
    this.queue = this.queue.filter(t => t.owner !== owner);
    const task = this.active;
    if (!task || task.owner !== owner) return Promise.resolve();
    if (task.finish) return task.finish;
    clearTimeout(task.timer); task.controller.abort();
    task.finish = this.exclusive(async () => {
      try { if (task.pid && this.driver) dataOf(await this.driver.call('release', { pid: task.pid })); }
      catch { await this.resetDriver(); }
      finally { if (this.active === task) this.active = undefined; this.pump(); }
    });
    return task.finish;
  }
  async stop(): Promise<void> {
    // Also cancel window discovery and approvals that have not entered the queue.
    const previous = this.cancellation; this.cancellation = new AbortController();
    previous.abort();
    const tickets = this.queue.splice(0);
    for (const t of tickets) { t.cleanup(); t.reject(abortError()); }
    if (this.active) await this.finish(this.active.owner);
  }
  private async resetDriver(): Promise<void> { const driver = this.driver; this.driver = undefined; await driver?.close(); }
  async close(): Promise<void> { this.closed = true; await Promise.all([this.runtime.close(), this.stop()]); await this.exclusive(() => this.resetDriver()); }
}

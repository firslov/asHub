import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBodyWithSignal } from '../transport/body-reader.js';
import { updateSettingsFile } from '../settings-store.js';
import { readPluginSettings, pluginCatalog, PLUGIN_DISABLED, setPluginEnabled as persistPluginEnabled } from '../plugins.js';

export const FEATURES_DISABLED = 'ashub.features.disabled';
export type ApplicationExtensionState = 'inactive' | 'starting' | 'active' | 'stopping' | 'error';
export interface ApplicationExtensionContext {
  readonly signal: AbortSignal;
  onDispose(cleanup: () => void | Promise<void>): void;
}
export interface ApplicationExtensionInstance {
  stop?(): void | Promise<void>;
  canStop?(): boolean;
}
export interface ApplicationExtensionDefinition {
  id: string;
  name: string;
  scope?: 'application' | 'frontend';
  capabilities?: string[];
  dependencies?: string[];
  requiresCapabilities?: string[];
  ui?: unknown;
  pluginId?: string;
  configNamespaces?: string[];
  initiallyEnabled?: boolean;
  /** A stable fingerprint used when rediscovering installed packages. */
  revision?: string;
  compatibilityError?: string;
  create?(context: ApplicationExtensionContext): void | ApplicationExtensionInstance | Promise<void | ApplicationExtensionInstance>;
}
interface Activation {
  controller: AbortController;
  cleanups: Array<() => void | Promise<void>>;
  instance?: ApplicationExtensionInstance;
  released: boolean;
  workPending: boolean;
  lateCleanups: Set<Promise<unknown>>;
  releaseError?: unknown;
  release?: Promise<void>;
}
interface RecordEntry {
  definition: ApplicationExtensionDefinition;
  enabled: boolean;
  state: ApplicationExtensionState;
  error?: string;
  activation?: Activation;
  inFlight: Set<Promise<unknown>>;
  admissionBlocked: boolean;
  /** Failed replacement retains the old instance until shutdown, never overlaps it. */
  reconcileError?: string;
}
const failure = (message: string, status = 409) => Object.assign(new Error(message), { status });
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** One registry is owned by one Hub. Factories receive injected services through closures;
 * this is a lifecycle boundary for trusted Node code, not an OS security sandbox. */
export class ApplicationExtensionRegistry {
  private entries = new Map<string, RecordEntry>();
  private tail: Promise<unknown> = Promise.resolve();
  private started = false;
  private booting = false;
  private activationOrder: string[] = [];
  private closed = false;
  private closing?: Promise<void>;
  private readonly httpController = new AbortController();
  private readonly timeout: number;
  constructor(private options: {
    settingsFile: string;
    definitions: ApplicationExtensionDefinition[];
    capabilities?: readonly string[];
    timeoutMs?: number;
    /** Re-evaluate installed manifests after install/disable/uninstall, without importing disabled code. */
    discover?: () => ApplicationExtensionDefinition[];
  }) {
    this.timeout = options.timeoutMs ?? 10_000;
    if (!Number.isFinite(this.timeout) || this.timeout <= 0) throw new Error('Invalid extension timeout');
    const disabled = this.disabled();
    for (const definition of options.definitions) this.add(definition, disabled);
  }
  private disabled(): Set<string> {
    const disabled = readPluginSettings(this.options.settingsFile)[FEATURES_DISABLED] ?? [];
    if (!Array.isArray(disabled) || disabled.some(id => typeof id !== 'string')) throw new Error(`Invalid ${FEATURES_DISABLED}`);
    return new Set(disabled);
  }
  private add(definition: ApplicationExtensionDefinition, disabled: Set<string>) {
    if (!/^[a-z][a-z0-9-]{0,79}$/.test(definition.id) || !definition.name || this.entries.has(definition.id)) throw new Error(`Invalid or duplicate extension: ${definition.id}`);
    this.entries.set(definition.id, { definition, enabled: definition.initiallyEnabled !== false && !disabled.has(definition.id), state: 'inactive', inFlight: new Set(), admissionBlocked: false });
  }
  private queue<T>(run: () => Promise<T>): Promise<T> {
    const task = this.tail.then(run);
    this.tail = task.catch(() => {});
    return task;
  }
  private entry(id: string) {
    const entry = this.entries.get(id);
    if (!entry) throw failure('Extension no longer installed; refresh the list', 404);
    return entry;
  }
  snapshot() {
    return { version: 1 as const, features: [...this.entries.values()].map(({ definition: d, enabled, state, error }) => ({
      id: d.id, name: d.name, enabled, state, scope: d.scope ?? 'application',
      ...(d.capabilities ? { capabilities: [...d.capabilities] } : {}), ...(d.ui ? { ui: d.ui } : {}),
      ...(d.pluginId ? { pluginId: d.pluginId, configNamespaces: [...(d.configNamespaces ?? [])] } : {}),
      ...(error ? { error } : {}),
    })) };
  }
  requireActive(id: string): void {
    const entry = this.entry(id);
    if (this.closed || entry.admissionBlocked || !entry.enabled || entry.state !== 'active') throw failure(`Extension ${id} is unavailable`);
  }
  async run<T>(id: string, fn: () => T | Promise<T>): Promise<T> {
    this.requireActive(id);
    const entry = this.entry(id);
    // Register admission before the first await (including a synchronous callback).
    const task = Promise.resolve().then(fn);
    entry.inFlight.add(task);
    try { return await task; } finally { entry.inFlight.delete(task); }
  }
  /** Installed package identities include transitive dependents, even if the
   * selected dependency only contributes session tools rather than an app entry. */
  private affectedPluginIds(pluginId: string): Set<string> {
    const catalog = pluginCatalog(this.options.settingsFile);
    const affected = new Set([pluginId]);
    let expanded = true;
    while (expanded) {
      expanded = false;
      const packageIds = new Set(catalog.filter(plugin => affected.has(plugin.id)).map(plugin => plugin.manifest?.id ?? plugin.packageName));
      for (const plugin of catalog) if (!affected.has(plugin.id) && plugin.manifest?.dependencies.some(dependency => packageIds.has(dependency.id))) {
        affected.add(plugin.id); expanded = true;
      }
    }
    // Also cover injected definitions used by application composition.
    let changed = true;
    while (changed) {
      changed = false;
      const features = new Set([...this.entries.values()].filter(entry => entry.definition.pluginId && affected.has(entry.definition.pluginId)).map(entry => entry.definition.id));
      for (const entry of this.entries.values()) if (entry.definition.pluginId && !affected.has(entry.definition.pluginId) && entry.definition.dependencies?.some(id => features.has(id))) {
        affected.add(entry.definition.pluginId); changed = true;
      }
    }
    return affected;
  }
  private busy(entry: RecordEntry): boolean {
    return !!(entry.reconcileError || entry.admissionBlocked || entry.inFlight.size > 0 || entry.state === 'starting' || entry.state === 'stopping'
      || entry.activation?.workPending || entry.activation?.lateCleanups.size || entry.activation?.releaseError || entry.activation?.instance?.canStop?.() === false);
  }
  isPluginBusy(pluginId: string): boolean {
    const affected = this.affectedPluginIds(pluginId);
    return [...this.entries.values()].some(entry => !!entry.definition.pluginId && affected.has(entry.definition.pluginId) && this.busy(entry));
  }
  /** The plugin manager and feature toggles share this queue. Refuse a busy
   * dependency closure BEFORE changing the kernel disable flags. */
  setPluginEnabled(pluginId: string, enabled: boolean): Promise<ReturnType<ApplicationExtensionRegistry['snapshot']>> {
    return this.queue(async () => {
      if (this.closed) throw failure('Application is shutting down', 503);
      if (typeof enabled !== 'boolean') throw failure('enabled must be a boolean', 400);
      await this.reconcile();
      const plugin = pluginCatalog(this.options.settingsFile).find(plugin => plugin.id === pluginId);
      if (!plugin) throw failure('Plugin no longer installed; refresh the list', 404);
      const affected = this.affectedPluginIds(pluginId);
      const entries = [...this.entries.values()].filter(entry => !!entry.definition.pluginId && affected.has(entry.definition.pluginId));
      if (entries.some(entry => this.busy(entry))) throw failure('Installed extension or its dependent is busy');
      const previous = readPluginSettings(this.options.settingsFile);
      for (const entry of entries) entry.admissionBlocked = true;
      let persisted = false;
      try {
        persistPluginEnabled(this.options.settingsFile, pluginId, enabled);
        persisted = true;
        await this.reconcile();
        return this.snapshot();
      } catch (error) {
        // Reconcile's busy rejection occurs before any teardown. If an external
        // change races the first check, restore only this package's flags while
        // preserving unrelated settings written by other callers.
        if (persisted && (error as {status?: number}).status === 409) {
          try {
            updateSettingsFile(this.options.settingsFile, data => {
              for (const [key, ids] of [[PLUGIN_DISABLED, [pluginId]], ['disabledExtensions', plugin.directoryNames]] as const) {
                const current = data[key] ?? [], before = previous[key] ?? [];
                if (!Array.isArray(current) || !Array.isArray(before)) throw new Error(`Invalid ${key}`);
                const values = new Set<string>(current);
                for (const id of ids) { if (before.includes(id)) values.add(id); else values.delete(id); }
                if (!Object.hasOwn(previous, key) && values.size === 0) delete data[key]; else data[key] = [...values];
              }
              return data;
            });
          } catch (restoreError) { throw new AggregateError([error, restoreError], 'Plugin update rejected; restoring its previous settings failed'); }
        }
        throw error;
      } finally { for (const entry of entries) entry.admissionBlocked = false; }
    });
  }
  private async bounded<T>(task: Promise<T>, label: string, signal?: AbortSignal): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([task, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out (${this.timeout}ms)`)), this.timeout);
        if (signal) {
          abort = () => reject(new Error(`${label} cancelled`));
          if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
        }
      })]);
    } finally { if (timer) clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort); }
  }
  private release(activation: Activation): Promise<void> {
    if (activation.releaseError) return Promise.reject(activation.releaseError);
    if (activation.release) return activation.release;
    activation.released = true;
    activation.controller.abort();
    activation.release = (async () => {
      const errors: unknown[] = [];
      if (activation.instance?.stop) {
        try { await this.bounded(Promise.resolve(activation.instance.stop()), 'Extension stop'); } catch (error) { errors.push(error); }
      }
      for (const cleanup of activation.cleanups.splice(0).reverse()) {
        try { await this.bounded(Promise.resolve().then(cleanup), 'Extension cleanup'); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, errors.map(message).join('; '));
    })().catch(error => { activation.releaseError = error; throw error; });
    return activation.release;
  }
  private async activate(entry: RecordEntry, visiting = new Set<string>(), attempts = new Set<string>()): Promise<void> {
    if (this.closed) throw failure('Application is shutting down', 503);
    if (entry.reconcileError) throw failure(entry.reconcileError);
    if (entry.state === 'active') return;
    const d = entry.definition;
    if (visiting.has(d.id)) throw new Error(`Extension dependency cycle: ${d.id}`);
    if (attempts.has(d.id)) throw new Error(entry.error ?? `Extension activation already failed: ${d.id}`);
    if (entry.activation?.releaseError) throw failure(`Extension ${d.id} cleanup failed; restart the application before enabling it again`);
    if (entry.activation?.released && (entry.activation.workPending || entry.activation.lateCleanups.size)) throw failure(`Extension ${d.id} previous activation is still finishing`);
    if (d.compatibilityError) throw new Error(d.compatibilityError);
    if (this.options.capabilities && d.requiresCapabilities?.some(c => !this.options.capabilities!.includes(c))) throw new Error(`Unsupported extension capability: ${d.id}`);
    visiting.add(d.id);
    attempts.add(d.id);
    for (const id of d.dependencies ?? []) {
      const dependency = this.entry(id);
      if (!dependency.enabled) throw new Error(`Required extension is disabled: ${id}`);
      await this.activate(dependency, new Set(visiting), attempts);
    }
    const activation: Activation = { controller: new AbortController(), cleanups: [], released: false, workPending: true, lateCleanups: new Set() };
    entry.activation = activation; entry.state = 'starting'; entry.error = undefined;
    const context: ApplicationExtensionContext = {
      signal: activation.controller.signal,
      onDispose: cleanup => {
        if (typeof cleanup !== 'function') throw new Error('Extension cleanup must be a function');
        if (activation.released) {
          // Late activations cannot leak resources merely by registering after timeout/exit.
          const pending = Promise.resolve().then(cleanup);
          activation.lateCleanups.add(pending);
          void pending.then(() => activation.lateCleanups.delete(pending), error => { activation.lateCleanups.delete(pending); activation.releaseError = error; });
          throw new Error('Extension activation has ended');
        }
        activation.cleanups.push(cleanup);
      },
    };
    const work = Promise.resolve().then(() => {
      if (context.signal.aborted) throw new Error('Extension activation has ended');
      return d.create?.(context);
    }).then(async instance => {
      if (activation.released) {
        if (instance?.stop) {
          try { await this.bounded(Promise.resolve(instance.stop()), 'Late extension stop'); }
          catch (error) { activation.releaseError = error; throw error; }
        }
        throw new Error('Extension activation has ended');
      }
      activation.instance = instance || undefined;
    }).finally(() => { activation.workPending = false; });
    try {
      await this.bounded(work, `Extension ${d.id} activation`, context.signal);
      if (this.closed) throw new Error('Application is shutting down');
      entry.state = 'active';
      this.activationOrder = this.activationOrder.filter(id => id !== d.id);
      this.activationOrder.push(d.id);
    } catch (error) {
      try { await this.release(activation); } catch (cleanupError) { error = new AggregateError([error, cleanupError], `${message(error)}; ${message(cleanupError)}`); }
      entry.state = 'error'; entry.error = message(error);
      throw error;
    }
  }
  private async deactivate(entry: RecordEntry): Promise<void> {
    if (!entry.activation) { entry.state = 'inactive'; entry.error = undefined; return; }
    entry.state = 'stopping';
    this.activationOrder = this.activationOrder.filter(id => id !== entry.definition.id);
    try {
      const activation = entry.activation;
      await this.release(activation); entry.state = 'inactive'; entry.error = undefined;
      // Retain a tombstone until timed-out code and late resource cleanup finish.
      if (!activation.workPending && !activation.lateCleanups.size) entry.activation = undefined;
    }
    catch (error) { entry.state = 'error'; entry.error = message(error); throw error; }
  }
  start(): Promise<void> {
    return this.queue(async () => {
      if (this.closed || this.started) return;
      this.booting = true;
      try {
        // Discover before marking started: reconcile must not also activate first-boot entries.
        await this.reconcile();
        this.started = true;
        const attempts = new Set<string>();
        for (const entry of this.entries.values()) {
          if (!entry.enabled || this.closed) continue;
          try { await this.activate(entry, new Set(), attempts); } catch (error) { entry.state = 'error'; entry.error = message(error); }
        }
      } finally { this.booting = false; }
    });
  }
  private async reconcile(): Promise<void> {
    if (!this.options.discover || this.closed) return;
    const discovered = this.options.discover();
    const ids = new Set<string>();
    for (const definition of discovered) {
      if (ids.has(definition.id) || this.options.definitions.some(d => d.id === definition.id)) throw new Error(`Duplicate installed extension: ${definition.id}`);
      ids.add(definition.id);
    }
    const disabled = this.disabled();
    const changed = new Set<string>();
    for (const [id, old] of this.entries) {
      if (!old.definition.pluginId) continue;
      const definition = discovered.find(d => d.id === id);
      if (!definition || definition.revision !== old.definition.revision || definition.initiallyEnabled !== old.definition.initiallyEnabled) changed.add(id);
    }
    // A dependency replacement also invalidates the instances holding its old services.
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const [id, entry] of this.entries) if (entry.definition.pluginId && !changed.has(id) && entry.definition.dependencies?.some(dependency => changed.has(dependency))) {
        changed.add(id); expanded = true;
      }
    }
    // A failed cleanup is a retained instance, not a reason to make the whole
    // catalog unreadable. Freeze its affected dependency component until restart.
    // Capture the graph before teardown removes successfully stopped entries.
    const dependencies = new Map([...changed].map(id => [id, this.entry(id).definition.dependencies ?? []]));
    const blocked = new Map<string, string>();
    const block = (id: string, error: unknown) => {
      const reason = `Extension cleanup failed; restart the application: ${message(error)}`;
      blocked.set(id, reason);
      let expanded = true;
      while (expanded) {
        expanded = false;
        for (const [dependent, parents] of dependencies) for (const parent of parents) {
          if (!changed.has(parent)) continue;
          if (blocked.has(dependent) && !blocked.has(parent)) { blocked.set(parent, reason); expanded = true; }
          if (blocked.has(parent) && !blocked.has(dependent)) { blocked.set(dependent, reason); expanded = true; }
        }
      }
    };
    for (const id of changed) {
      const old = this.entry(id);
      if (old.reconcileError || old.activation?.releaseError) block(id, old.reconcileError ?? old.activation!.releaseError);
    }
    // Preserve the all-or-nothing busy preflight for healthy live instances.
    for (const id of changed) {
      if (blocked.has(id)) continue;
      const old = this.entry(id);
      if (old.inFlight.size || old.activation?.workPending || old.activation?.lateCleanups.size || old.activation?.instance?.canStop?.() === false) throw failure('Installed extension is busy');
    }
    // Hold admission across every await in replacement, just as explicit
    // package toggles do. Preflight alone cannot prevent newly admitted work
    // while a dependent is stopping. Preserve any enclosing toggle's guard.
    const reservations = [...changed].map(id => {
      const entry = this.entry(id);
      const previous = entry.admissionBlocked;
      entry.admissionBlocked = true;
      return { entry, previous };
    });
    try {
      const errors: unknown[] = [];
      const ordered = [...this.activationOrder].reverse().filter(id => changed.has(id));
      for (const id of [...ordered, ...[...changed].filter(id => !ordered.includes(id))]) {
        if (blocked.has(id)) continue;
        try {
          await this.deactivate(this.entry(id));
          this.entries.delete(id);
        } catch (error) { block(id, error); errors.push(error); }
      }
      for (const definition of discovered) if (!this.entries.has(definition.id)) this.add(definition, disabled);
      for (const [id, reason] of blocked) {
        const entry = this.entries.get(id);
        if (!entry) continue;
        const definition = discovered.find(d => d.id === id);
        entry.enabled = !!definition && definition.initiallyEnabled !== false && !disabled.has(id);
        entry.reconcileError ??= reason;
        entry.state = 'error'; entry.error = entry.reconcileError;
      }
      const attempts = new Set<string>();
      if (this.started) for (const entry of this.entries.values()) {
        if (entry.enabled && entry.state === 'inactive') {
          try { await this.activate(entry, new Set(), attempts); } catch (error) { entry.state = 'error'; entry.error = message(error); }
        }
      }
      if (errors.length) throw new AggregateError(errors, errors.map(message).join('; '));
    } finally {
      for (const { entry, previous } of reservations) entry.admissionBlocked = previous;
    }
  }
  refresh(): Promise<void> { return this.queue(() => this.reconcile()); }
  private persist(id: string, enabled: boolean) {
    updateSettingsFile(this.options.settingsFile, data => {
      const value = data[FEATURES_DISABLED] ?? [];
      if (!Array.isArray(value) || value.some(id => typeof id !== 'string')) throw new Error(`Invalid ${FEATURES_DISABLED}`);
      const disabled = new Set<string>(value);
      if (enabled) disabled.delete(id); else disabled.add(id);
      return { ...data, [FEATURES_DISABLED]: [...disabled] };
    });
  }
  setEnabled(id: string, enabled: boolean): Promise<ReturnType<ApplicationExtensionRegistry['snapshot']>> {
    return this.queue(async () => {
      if (this.closed) throw failure('Application is shutting down', 503);
      if (typeof enabled !== 'boolean') throw failure('enabled must be a boolean', 400);
      const entry = this.entry(id);
      if (enabled) {
        if (entry.definition.initiallyEnabled === false) throw failure('Enable this installed plugin in the plugin manager first');
        if (entry.enabled && entry.state === 'active') return this.snapshot();
        const previous = entry.enabled;
        try {
          await this.activate(entry);
          this.persist(id, true);
          entry.enabled = true;
        } catch (error) {
          entry.enabled = previous;
          if (entry.state === 'active') await this.deactivate(entry);
          throw error;
        }
      } else {
        if (!entry.enabled && entry.state === 'inactive') return this.snapshot();
        if ([...this.entries.values()].some(e => e.enabled && e.definition.dependencies?.includes(id))) throw failure('An enabled extension depends on this feature');
        if (entry.inFlight.size || entry.activation?.instance?.canStop?.() === false) throw failure('Extension has operations in progress; try again after they finish');
        // Persist before teardown so a crash or failed cleanup cannot reactivate it next launch.
        this.persist(id, false);
        entry.enabled = false;
        await this.deactivate(entry);
      }
      return this.snapshot();
    });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.httpController.abort();
    for (const entry of this.entries.values()) entry.activation?.controller.abort();
    this.closing = this.queue(async () => {
      const errors: unknown[] = [];
      const ordered = [...this.activationOrder].reverse().map(id => this.entry(id));
      for (const entry of [...ordered, ...[...this.entries.values()].filter(e => !ordered.includes(e)).reverse()]) {
        try { await this.deactivate(entry); } catch (error) { errors.push(error); }
        try { await this.bounded(Promise.allSettled([...entry.inFlight]), `Extension ${entry.definition.id} drain`); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, errors.map(message).join('; '));
    });
    return this.closing;
  }
  /** Must be called only after the Hub's existing Host/Origin/authentication gate. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = (req.url ?? '/').split('?')[0]!;
    if (path !== '/api/extensions' && !path.startsWith('/api/extensions/')) return false;
    const reply = (status: number, body: unknown) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body));
    };
    try {
      if (!(req.method === 'GET' && this.booting)) await this.refresh();
      if (req.method === 'GET' && path === '/api/extensions') reply(200, this.snapshot());
      else if (req.method === 'POST' && /^\/api\/extensions\/[a-z][a-z0-9-]{0,79}\/enabled$/.test(path)) {
        const body = await readBodyWithSignal(req, async request => {
          let bytes = 0; const chunks: Buffer[] = [];
          for await (const chunk of request) { const value = Buffer.from(chunk); bytes += value.length; if (bytes > 1024) throw failure('Request too large', 413); chunks.push(value); }
          return Buffer.concat(chunks).toString('utf8');
        }, this.httpController.signal);
        let input: unknown;
        try { input = JSON.parse(body); } catch { throw failure('Invalid JSON', 400); }
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => k !== 'enabled') || typeof (input as any).enabled !== 'boolean') throw failure('enabled must be a boolean', 400);
        reply(200, await this.setEnabled(path.split('/')[3]!, (input as any).enabled));
      } else reply(path === '/api/extensions' ? 405 : 404, { error: 'Unsupported extension route' });
    } catch (error) { reply((error as any).status ?? 500, { error: message(error) }); }
    return true;
  }
}

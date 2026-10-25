import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ensureTsSupport } from 'agent-sh/extension-loader';
import type { AgentShellCore } from 'agent-sh';
import { pluginCatalog, readPluginSettings, type PluginStatus } from './plugins.js';
type Context = ReturnType<AgentShellCore['extensionContext']>;

type Register = (...args: any[]) => () => void;
const registrations = new WeakMap<Context, Map<string, Register>>();
const providerHookKeys = ['reasoningParams', 'cacheTokens', 'requestHeaders'] as const;
type ProviderHookKey = typeof providerHookKeys[number];
type ProviderOptions = Parameters<NonNullable<Context['agent']>['providers']['configure']>[1];
type HookEntry = { value: unknown; previous?: HookEntry; released: boolean };
const providerConfigurations = new WeakMap<Context, (id: string, options: ProviderOptions) => () => void>();

function prepareProviderConfigurations(ctx: Context) {
  const ready = providerConfigurations.get(ctx);
  if (ready) return ready;
  const active = new Map<string, Map<ProviderHookKey, HookEntry>>();
  const internalEvents = new WeakSet<object>();
  // Observe before activateAgent: native providers configure their hooks inside
  // activation, before ctx.agent is available to the registration wrapper.
  ctx.bus.on('provider:configure', payload => {
    if (internalEvents.has(payload)) return;
    let entries = active.get(payload.id);
    if (!entries) { entries = new Map(); active.set(payload.id, entries); }
    for (const key of providerHookKeys) {
      if (payload[key] !== undefined) entries.set(key, { value: payload[key], released: false });
    }
  });
  const emit = (payload: Record<string, unknown> & { id: string }) => {
    internalEvents.add(payload);
    try { ctx.bus.emit('provider:configure', payload as any); }
    finally { internalEvents.delete(payload); }
  };
  const configure = (id: string, options: ProviderOptions) => {
    let entries = active.get(id);
    if (!entries) { entries = new Map(); active.set(id, entries); }
    const owned = new Map<ProviderHookKey, HookEntry>();
    for (const key of providerHookKeys) {
      if (options[key] === undefined) continue;
      const entry = { value: options[key], previous: entries.get(key), released: false };
      entries.set(key, entry); owned.set(key, entry);
    }
    emit({ id, ...options });
    return () => {
      const restore: Record<string, unknown> & { id: string } = { id };
      for (const [key, entry] of owned) {
        if (entry.released) continue;
        entry.released = true;
        if (entries.get(key) !== entry) continue;
        let previous = entry.previous;
        while (previous?.released) previous = previous.previous;
        if (previous) entries.set(key, previous); else entries.delete(key);
        // The kernel ignores undefined updates; null clears an optional hook
        // and restores its default via the kernel's nullish/falsy fallback.
        restore[key] = previous?.value ?? null;
      }
      if (Object.keys(restore).length > 1) emit(restore);
    };
  };
  providerConfigurations.set(ctx, configure);
  return configure;
}

/** Call before activateAgent, then again before built-in extensions so rollback retains raw arguments,
 * rather than snapshotting values that already include instruction/skill advice. */
export function preparePluginRegistrations(ctx: Context): Map<string, Register> {
  prepareProviderConfigurations(ctx);
  const ready = registrations.get(ctx);
  if (ready) return ready;
  const methods = new Map<string, Register>();
  if (!ctx.agent) return methods;
  registrations.set(ctx, methods);
  for (const [target, add, remove, field] of [
    [ctx.agent, 'registerTool', 'unregisterTool', 'name'],
    [ctx.agent, 'registerInstruction', 'removeInstruction', ''],
    [ctx.agent, 'registerSkill', 'removeSkill', ''],
    [ctx.agent.providers, 'register', 'unregister', 'id'],
  ] as const) {
    const surface = target as any;
    const rawAdd = surface[add].bind(target), rawRemove = surface[remove].bind(target);
    type Entry = { args: any[]; previous?: Entry; released: boolean };
    const active = new Map<string, Entry>();
    // activateAgent registers native providers before this wrapper can attach.
    // Their pipe contributions are raw registrations (unlike advised tool,
    // instruction and skill views), so retain them as the initial baseline.
    if (add === 'register') {
      for (const provider of ctx.bus.emitPipe('agent:providers', { providers: [] }).providers) {
        active.set(provider.id, { args: [provider], released: false });
      }
    }
    const register = (args: any[], owned: boolean): (() => void) => {
      const key = field ? args[0][field] : args[0];
      const prior = active.get(key);
      const entry: Entry = { args, previous: owned ? prior : undefined, released: false };
      active.set(key, entry);
      try { rawAdd(...args); }
      catch (e) {
        if (active.get(key) === entry) {
          // Rejection is not a replacement, including for host registrations.
          if (prior) active.set(key, prior); else active.delete(key);
        }
        throw e;
      }
      return () => {
        if (entry.released) return;
        entry.released = true;
        if (active.get(key) !== entry) return;
        let previous = entry.previous;
        while (previous?.released) previous = previous.previous;
        if (previous) {
          active.set(key, previous);
          rawAdd(...previous.args);
        } else {
          active.delete(key);
          rawRemove(key);
        }
      };
    };
    methods.set(add, (...args) => register(args, true));
    surface[add] = (...args: any[]) => {
      // Host updates replace the baseline; only plugin overrides are reversible.
      const release = register(args, false);
      // Only provider registration exposes a disposer in the kernel API.
      return add === 'register' ? release : undefined;
    };
    surface[remove] = (key: string) => { active.delete(key); rawRemove(key); };
  }
  return methods;
}

/** Registrations belong to this activation, never to a process-global plugin name. */
export function pluginScope(ctx: Context) {
  let disposed = false, disposing = false;
  const cleanups: Array<() => void> = [];
  const remember = (fn: () => void) => { if (disposed) fn(); else cleanups.push(fn); };
  const guard = (fn: (...args: any[]) => any) => (...args: any[]) => {
    if (disposed && !disposing) throw new Error('Plugin activation has ended');
    return fn(...args);
  };
  const tracked = (target: any, key: string) => guard((...args) => {
    const off = target[key](...args); if (typeof off === 'function') remember(off); return off;
  });
  const commands = new Map<string, Array<() => void>>();
  const commandKey = (name: string) => `command:${name.startsWith('/') ? name : '/' + name}`;
  const bus = Object.create(ctx.bus);
  for (const [on, off] of [['on', 'off'], ['onPipe', 'offPipe'], ['onPipeAsync', 'offPipeAsync']]) {
    if (typeof (ctx.bus as any)[on] !== 'function') continue;
    const subscriptions = new Map<string, Map<(...args: any[]) => any, Array<() => void>>>();
    bus[on] = guard((event, fn) => {
      let released = false;
      // The kernel removes listeners by callback identity. Give each scoped
      // subscription its own identity, even when plugins share a callback.
      const listener = (payload: any) => released ? payload : fn(payload);
      (ctx.bus as any)[on](event, listener);
      let callbacks = subscriptions.get(event);
      if (!callbacks) { callbacks = new Map(); subscriptions.set(event, callbacks); }
      const releases = callbacks.get(fn) ?? [];
      callbacks.set(fn, releases);
      const release = () => {
        if (released) return;
        released = true;
        (ctx.bus as any)[off](event, listener);
        const index = releases.indexOf(release);
        if (index !== -1) releases.splice(index, 1);
      };
      releases.push(release); remember(release);
    });
    bus[off] = guard((event, fn) => {
      const releases = subscriptions.get(event)?.get(fn);
      // Retain the empty entry: repeated off calls must not target the host.
      if (releases) releases[0]?.();
      else (ctx.bus as any)[off](event, fn);
    });
  }
  bus.onAny = guard((fn) => {
    let released = false;
    const off = ctx.bus.onAny((...args) => { if (!released) fn(...args); });
    const release = () => { if (!released) { released = true; off(); } };
    remember(release);
    return release;
  });
  for (const method of ['emitPipe', 'emitPipeAsync']) bus[method] = guard((...args) => (ctx.bus as any)[method](...args));
  bus.emit = guard((event, payload) => {
    const owned = event === 'command:unregister' && typeof payload?.name === 'string' ? commands.get(commandKey(payload.name)) : undefined;
    if (owned) { for (const release of owned.splice(0).reverse()) release(); }
    else (ctx.bus.emit as any)(event, payload);
  });
  const scoped: any = { ...ctx, bus, onDispose: remember, advise: tracked(ctx, 'advise'), adviseCommand: tracked(ctx, 'adviseCommand'),
    define: guard(ctx.define), call: guard(ctx.call), quit: guard(ctx.quit), registerCommand: guard((name, description, handler) => {
      // The kernel dispatches registration synchronously, but its bus catches
      // duplicate-command errors. Only own cleanup after the registry actually
      // defines our handler; otherwise a failed plugin could remove /help.
      const key = commandKey(name);
      const define = ctx.define;
      let registered = false, active = false;
      const retired = ({ name: removed }: { name: string }) => {
        if (commandKey(removed) === key) active = false;
      };
      const cleanup = () => {
        ctx.bus.off('command:unregister', retired);
        if (active) { active = false; ctx.bus.emit('command:unregister', { name }); }
      };
      // A command name can be reused after explicit unregistration. Once
      // retired, this activation must never remove a later registration.
      ctx.bus.on('command:unregister', retired);
      ctx.define = (definedName, fn) => {
        define(definedName, fn);
        if (definedName === key && fn === handler) { registered = true; active = true; }
      };
      try { ctx.registerCommand(name, description, handler); }
      catch (e) { cleanup(); throw e; }
      finally { ctx.define = define; }
      if (!registered) {
        cleanup();
        throw new Error(`Command "${name}" could not be registered; use adviseCommand for existing commands`);
      }
      const owned = commands.get(key) ?? [];
      owned.push(cleanup); commands.set(key, owned);
      remember(cleanup);
    }) };
  if (ctx.agent) {
    const agent: any = scoped.agent = { ...ctx.agent };
    const managed = preparePluginRegistrations(ctx);
    agent.providers = { ...ctx.agent.providers, configure: guard((id, options) => {
      remember(prepareProviderConfigurations(ctx)(id, options));
    }) };
    for (const [target, source, add, remove, field] of [
      [agent, ctx.agent, 'registerTool', 'unregisterTool', 'name'],
      [agent, ctx.agent, 'registerInstruction', 'removeInstruction', ''],
      [agent, ctx.agent, 'registerSkill', 'removeSkill', ''],
      [agent.providers, ctx.agent.providers, 'register', 'unregister', 'id'],
    ] as const) {
      const owned = new Map<string, Array<() => void>>();
      target[add] = guard((...args) => {
        const release = managed.get(add)!(...args), key = field ? args[0][field] : args[0];
        const releases = owned.get(key) ?? [];
        releases.push(release); owned.set(key, releases); remember(release);
        return add === 'register' ? release : undefined;
      });
      target[remove] = guard((key) => {
        const releases = owned.get(key);
        // Explicit onDispose cleanup must obey the same ownership rules.
        if (releases) { for (const release of releases.splice(0).reverse()) release(); }
        else (source as any)[remove](key);
      });
    }
    for (const method of ['adviseTool', 'adviseToolSchema', 'adviseInstruction', 'adviseSkill', 'registerContextProducer']) agent[method] = tracked(ctx.agent, method);
  }
  if (ctx.shell) scoped.shell = { ...ctx.shell, adviseInputMode: tracked(ctx.shell, 'adviseInputMode') };
  return { ctx: scoped as Context, dispose() {
    if (disposed) return;
    disposed = true;
    disposing = true;
    try { for (const fn of cleanups.splice(0).reverse()) { try { fn(); } catch {} } }
    finally { disposing = false; }
  } };
}

export class PluginRuntime {
  private scopes = new Set<ReturnType<typeof pluginScope>>();
  private closed = false;
  readonly status: PluginStatus[] = [];
  constructor(private file: string, private timeout = 10_000) {}
  async load(ctx: Context): Promise<string[]> {
    let entries, settings: Record<string, any>;
    try { entries = pluginCatalog(this.file).filter(p => p.enabled); settings = readPluginSettings(this.file); }
    catch (e) {
      ctx.bus.emit('ui:error', { message: `Could not discover plugins: ${e instanceof Error ? e.message : String(e)}` });
      return [];
    }
    for (const plugin of entries) {
      if (this.closed) break;
      const state: PluginStatus = { id: plugin.id, name: plugin.name, state: 'loading', configNamespaces: [] };
      this.status.push(state);
      const scope = pluginScope(ctx); this.scopes.add(scope);
      // Snapshot per kernel: new kernels see saved edits without resetting the
      // process-wide kernel settings cache or changing running conversations.
      scope.ctx.getExtensionSettings = (namespace, defaults) => {
        if (!state.configNamespaces!.includes(namespace)) state.configNamespaces!.push(namespace);
        const value = Object.hasOwn(settings, namespace) ? settings[namespace] : undefined;
        return value && typeof value === 'object' && !Array.isArray(value) ? { ...defaults, ...value } : defaults;
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          (async () => {
            const spec = plugin.specifier;
            if (/\.(ts|tsx|mts)$/.test(spec)) {
              // Match the kernel's ESM setup for directory-discovered TS plugins.
              const root = path.join(path.dirname(this.file), 'extensions');
              if (plugin.directoryNames.length && !fs.existsSync(path.join(root, 'package.json'))) fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}\n');
              await ensureTsSupport();
            }
            const mod = await import(path.isAbsolute(spec) ? pathToFileURL(spec).href : spec);
            if (this.closed || state.state === 'error') return;
            const activate = typeof mod.default === 'function' ? mod.default : typeof mod.default?.default === 'function' ? mod.default.default : mod.activate;
            if (typeof activate !== 'function') throw new Error('Missing activate(ctx) export');
            await activate(scope.ctx);
          })(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Plugin activation timed out (${this.timeout}ms)`)), this.timeout); }),
        ]);
        if (this.closed) { scope.dispose(); break; }
        state.state = 'loaded';
      } catch (e) {
        scope.dispose(); this.scopes.delete(scope);
        state.state = 'error'; state.error = e instanceof Error ? e.message : String(e);
        if (!this.closed) ctx.bus.emit('ui:error', { message: `Plugin ${plugin.name}: ${state.error}` });
      } finally { if (timer) clearTimeout(timer); }
    }
    return this.status.filter(s => s.state === 'loaded').map(s => s.name);
  }
  close(): void { this.closed = true; for (const scope of [...this.scopes].reverse()) scope.dispose(); this.scopes.clear(); }
}

import { AsyncLocalStorage } from 'node:async_hooks';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Agent } from 'undici';
import { updateSettingsFile } from './settings-store.js';

const KEY = 'ashub.network';
export interface NetworkPolicy { proxyEnabled: boolean; sessions: Record<string, boolean> }
const context = new AsyncLocalStorage<string>();
const direct = new Agent();
const policyFile = () => path.join(process.env.AGENT_SH_HOME ? path.resolve(process.env.AGENT_SH_HOME) : path.join(os.homedir(), '.agent-sh'), 'settings.json');
export function readNetworkPolicy(file = policyFile()): NetworkPolicy {
  let data: any;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8'))[KEY]; } catch {}
  const sessions: Record<string, boolean> = {};
  if (data?.sessions && typeof data.sessions === 'object') {
    for (const [id, value] of Object.entries(data.sessions)) {
      if (/^[0-9a-f]{4,32}$/.test(id) && typeof value === 'boolean') sessions[id] = value;
    }
  }
  return { proxyEnabled: data?.proxyEnabled !== false, sessions };
}
export function writeNetworkPolicy(enabled: boolean | null, session?: string, file = policyFile()): NetworkPolicy {
  updateSettingsFile(file, data => {
    const policy = readNetworkPolicy(file);
    if (session) {
      if (enabled === null) delete policy.sessions[session];
      else policy.sessions[session] = enabled;
    } else policy.proxyEnabled = enabled !== false;
    return { ...data, [KEY]: policy };
  });
  return readNetworkPolicy(file);
}
export function withNetworkSession<T>(id: string | undefined, run: () => T): T {
  return context.run(id || '', run);
}

// Codex's local HTTP conversion server has a separate async context. Match its
// upstream URL AND session header, never apply a different conversation's mode.
const endpoints = new Map<string, Map<string, number>>();
export function registerNetworkEndpoint(url: string, id: string): () => void {
  url = new URL(url).href;
  const sessions = endpoints.get(url) ?? new Map<string, number>();
  endpoints.set(url, sessions); sessions.set(id, (sessions.get(id) ?? 0) + 1);
  let active = true;
  return () => {
    if (!active) return; active = false;
    const count = (sessions.get(id) ?? 0) - 1;
    if (count > 0) sessions.set(id, count); else sessions.delete(id);
    if (!sessions.size) endpoints.delete(url);
  };
}
export function createPolicyFetch(proxied: typeof fetch, nodeFetch: typeof fetch, read = readNetworkPolicy): typeof fetch {
  return (input, init) => {
    let url = input instanceof Request ? input.url : String(input);
    try { url = new URL(url).href; } catch { /* Let fetch report invalid URLs. */ }
    const headerId = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get('session_id');
    const id = headerId && endpoints.get(url)?.has(headerId) ? headerId : context.getStore();
    const policy = read();
    const enabled = (id ? policy.sessions[id] : undefined) ?? policy.proxyEnabled;
    // Explicit dispatcher bypasses the environment proxy without mutating global
    // state. In-flight requests keep their transport; later requests use the new mode.
    return enabled ? proxied(input, init) : nodeFetch(input, { ...init, dispatcher: direct } as RequestInit);
  };
}

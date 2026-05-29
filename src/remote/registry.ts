/**
 * Per-host BridgeFactory registry.  Reads ~/.agent-sh/ashub-hosts.json,
 * lazily opens an SSH tunnel on first session per host, and exposes a
 * lookup the hub uses to dispatch POST /sessions by host id.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { connectRemote } from "./ssh.js";
import { RemoteBridge } from "../bridges/remote.js";
import { TerminalBridge } from "../bridges/terminal.js";
import type { BridgeFactory } from "../bridges/types.js";
import type { RemoteHost, ConnectedRemote, RemoteReadiness } from "./types.js";

interface HostsFile { hosts?: RemoteHost[] }

export interface HostInfo {
  id: string;
  label: string;
  local: boolean;
}

export const LOCAL_HOST_ID = "local";

export function hostsPath(): string {
  const home = process.env.AGENT_SH_HOME
    ? path.resolve(process.env.AGENT_SH_HOME)
    : path.join(os.homedir(), ".agent-sh");
  return path.join(home, "ashub-hosts.json");
}

export function loadHostsFromDisk(): RemoteHost[] {
  try {
    const raw = fs.readFileSync(hostsPath(), "utf-8");
    const j = JSON.parse(raw) as HostsFile;
    return Array.isArray(j.hosts) ? j.hosts : [];
  } catch { return []; }
}

export interface HostRegistry {
  list(): HostInfo[];
  factory(hostId: string): BridgeFactory | null;
  /** Ids of the configured remote hosts (excludes "local"). */
  remoteIds(): string[];
  /** Base URL of an already-connected host, or null if not yet connected.
   *  Never triggers a connect — used by federation so listing sessions
   *  doesn't SSH to every configured host. */
  connectedBaseUrl(hostId: string): string | null;
  /** Connects (if needed) and returns the base URL. */
  ensureBaseUrl(hostId: string): Promise<string | null>;
  /** Connects (if needed) and returns current readiness.  Null for "local"
   *  or hosts using directBaseUrl (no SSH layer to probe). */
  status(hostId: string): Promise<RemoteReadiness | null>;
  /** Connects (if needed) and pushes local config to fill in missing
   *  keys/providers.  Returns updated readiness. */
  bootstrap(hostId: string): Promise<RemoteReadiness | null>;
  shutdown(): Promise<void>;
}

export function createHostRegistry(localFactory: BridgeFactory, hosts: RemoteHost[]): HostRegistry {
  const tunnels = new Map<string, Promise<ConnectedRemote>>();
  // Settled tunnels, so connectedBaseUrl() can answer without awaiting.
  const connected = new Map<string, ConnectedRemote>();
  const factories = new Map<string, BridgeFactory>();
  const hostById = new Map<string, RemoteHost>();
  factories.set(LOCAL_HOST_ID, localFactory);
  const ensure = (h: RemoteHost): Promise<ConnectedRemote> => {
    let p = tunnels.get(h.id);
    if (!p) {
      p = connectRemote(h).then((c) => { connected.set(h.id, c); return c; });
      // A failed connect shouldn't poison the slot forever — drop it so a
      // later attempt retries instead of re-throwing the cached rejection.
      p.catch(() => { if (tunnels.get(h.id) === p) tunnels.delete(h.id); });
      tunnels.set(h.id, p);
    }
    return p;
  };
  const baseUrlOf = (h: RemoteHost, c?: ConnectedRemote): string | null => {
    if (h.directBaseUrl) return h.directBaseUrl.replace(/\/$/, "");
    return c ? `http://127.0.0.1:${c.localPort}` : null;
  };
  // Close a host's tunnel (and its tethered remote process) so the next
  // ensure() rebuilds fresh — recovery from a dead remote.
  const dropTunnel = async (id: string): Promise<void> => {
    const p = tunnels.get(id);
    tunnels.delete(id);
    connected.delete(id);
    if (p) { try { const c = await p; await c.close(); } catch {} }
  };
  for (const h of hosts) {
    if (h.id === LOCAL_HOST_ID) continue;
    hostById.set(h.id, h);
    factories.set(h.id, (opts) => {
      if (opts.kind === "terminal") return new TerminalBridge(opts);
      const getBaseUrl = async (o?: { reconnect?: boolean }): Promise<string> => {
        if (h.directBaseUrl) return h.directBaseUrl.replace(/\/$/, "");
        if (o?.reconnect) await dropTunnel(h.id);
        const c = await ensure(h);
        return `http://127.0.0.1:${c.localPort}`;
      };
      return new RemoteBridge({ ...opts, baseUrl: getBaseUrl });
    });
  }
  return {
    list(): HostInfo[] {
      const out: HostInfo[] = [{ id: LOCAL_HOST_ID, label: "local", local: true }];
      for (const h of hosts) {
        if (h.id === LOCAL_HOST_ID) continue;
        out.push({ id: h.id, label: h.user ? `${h.user}@${h.host}` : h.host, local: false });
      }
      return out;
    },
    factory(id: string): BridgeFactory | null {
      return factories.get(id) ?? null;
    },
    remoteIds(): string[] {
      return hosts.filter((h) => h.id !== LOCAL_HOST_ID).map((h) => h.id);
    },
    connectedBaseUrl(id: string): string | null {
      const h = hostById.get(id);
      if (!h) return null;
      if (h.directBaseUrl) return h.directBaseUrl.replace(/\/$/, "");
      return baseUrlOf(h, connected.get(id));
    },
    async ensureBaseUrl(id: string): Promise<string | null> {
      const h = hostById.get(id);
      if (!h) return null;
      if (h.directBaseUrl) return h.directBaseUrl.replace(/\/$/, "");
      const c = await ensure(h);
      return baseUrlOf(h, c);
    },
    async status(id: string): Promise<RemoteReadiness | null> {
      const h = hostById.get(id);
      if (!h || h.directBaseUrl) return null;
      const c = await ensure(h);
      return c.readiness;
    },
    async bootstrap(id: string): Promise<RemoteReadiness | null> {
      const h = hostById.get(id);
      if (!h || h.directBaseUrl) return null;
      const c = await ensure(h);
      return await c.bootstrapConfig();
    },
    async shutdown(): Promise<void> {
      const ps = [...tunnels.values()];
      tunnels.clear();
      connected.clear();
      for (const p of ps) {
        try { const c = await p; await c.close(); } catch {}
      }
    },
  };
}

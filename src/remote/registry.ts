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
import type { RemoteHost, ConnectedRemote } from "./types.js";

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
  shutdown(): Promise<void>;
}

export function createHostRegistry(localFactory: BridgeFactory, hosts: RemoteHost[]): HostRegistry {
  const tunnels = new Map<string, Promise<ConnectedRemote>>();
  const factories = new Map<string, BridgeFactory>();
  factories.set(LOCAL_HOST_ID, localFactory);
  for (const h of hosts) {
    if (h.id === LOCAL_HOST_ID) continue;
    factories.set(h.id, (opts) => {
      if (opts.kind === "terminal") return new TerminalBridge(opts);
      const getBaseUrl = async (): Promise<string> => {
        if (h.directBaseUrl) return h.directBaseUrl.replace(/\/$/, "");
        let p = tunnels.get(h.id);
        if (!p) { p = connectRemote(h); tunnels.set(h.id, p); }
        const c = await p;
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
    async shutdown(): Promise<void> {
      const ps = [...tunnels.values()];
      tunnels.clear();
      for (const p of ps) {
        try { const c = await p; await c.close(); } catch {}
      }
    },
  };
}

/**
 * asHub CLI entrypoint.
 *
 *   ashub                                 # default: in-process ash
 *   ashub --port 8080
 *   ashub --backend acp --cmd "claude-code-acp"
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { startHub, shutdownHub, type HubOpts } from "./hub.js";
import { AshBridge } from "./bridges/ash.js";
import { AcpBridge } from "./bridges/acp.js";
import { TerminalBridge } from "./bridges/terminal.js";
import { RemoteBridge } from "./bridges/remote.js";
import { connectRemote } from "./remote/ssh.js";
import type { ConnectedRemote, RemoteHost } from "./remote/types.js";
import type { BridgeFactory } from "./bridges/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

interface Args {
  port: number;
  host: string;
  webRoot: string;
  backend: "ash" | "acp" | "remote";
  cmd: string;
  model?: string;
  provider?: string;
  remote?: string;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const out: Args = {
    port: 7878,
    host: "127.0.0.1",
    webRoot: path.join(REPO_ROOT, "web"),
    backend: "ash",
    cmd: "agent-sh-acp",
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const v = args[i + 1];
    if (a === "--port" && v) { out.port = parseInt(v, 10); i++; }
    else if (a === "--host" && v) { out.host = v; i++; }
    else if (a === "--web" && v) { out.webRoot = path.resolve(v); i++; }
    else if (a === "--backend" && v) {
      if (v !== "ash" && v !== "acp" && v !== "remote") { console.error(`unknown backend: ${v}`); process.exit(2); }
      out.backend = v; i++;
    }
    else if (a === "--cmd" && v) { out.cmd = v; i++; }
    else if (a === "--model" && v) { out.model = v; i++; }
    else if (a === "--provider" && v) { out.provider = v; i++; }
    else if (a === "--remote" && v) { out.remote = v; out.backend = "remote"; i++; }
    else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
  }
  return out;
}

function printHelp(): void {
  console.log(`asHub — supervise headless agent sessions over HTTP

Usage:
  ashub [options]

Options:
  --backend ash|acp|remote   Bridge implementation (default ash)
  --port N                   HTTP port (default 7878)
  --host HOST                Bind host (default 127.0.0.1)
  --web PATH                 Static web root (default ./web)
  --model NAME               Model override (ash backend)
  --provider NAME            Provider override (ash backend)
  --cmd "CMD ARGS"           Spawn command for acp backend (default "agent-sh-acp")
  --remote [user@]host[:port]  SSH target; implies --backend remote
  -h, --help                 Show this help

Backends:
  ash     In-process agent-sh kernel. No subprocess; one less hop.
  acp     Spawn a JSON-RPC ACP child (agent-sh-acp, claude-code, etc.) per session.
  remote  Bootstrap ashub-server on a remote host over SSH, then proxy via RemoteBridge.

Endpoints:
  GET  /                 Redirect to first session, or auto-spawn one
  GET  /sessions         JSON list of live sessions
  POST /sessions         Spawn a new session   { cwd?: string }
  GET  /<id>/            Web UI for session <id>
  GET  /<id>/events      SSE event stream
  POST /<id>/submit      Submit a query        { query: string }
  DELETE /<id>/          Close session
`);
}

function makeFactory(args: Args): BridgeFactory {
  if (args.backend === "ash") {
    return (opts) => {
      if (opts.kind === "terminal") return new TerminalBridge(opts);
      return new AshBridge({ ...opts, model: opts.model ?? args.model, provider: opts.provider ?? args.provider });
    };
  }
  const [command, ...spawnArgs] = args.cmd.split(/\s+/);
  return (opts) => {
    if (opts.kind === "terminal") return new TerminalBridge(opts);
    return new AcpBridge({
      ...opts,
      extra: { command: command!, args: spawnArgs },
    });
  };
}

function parseRemoteTarget(spec: string): RemoteHost {
  // [user@]host[:port]
  let user: string | undefined;
  let rest = spec;
  const at = rest.indexOf("@");
  if (at !== -1) { user = rest.slice(0, at); rest = rest.slice(at + 1); }
  let port: number | undefined;
  const colon = rest.lastIndexOf(":");
  if (colon !== -1) {
    const tail = rest.slice(colon + 1);
    if (/^\d+$/.test(tail)) { port = parseInt(tail, 10); rest = rest.slice(0, colon); }
  }
  return { id: spec, host: rest, user, port };
}

function makeRemoteFactory(remote: ConnectedRemote): BridgeFactory {
  const baseUrl = `http://127.0.0.1:${remote.localPort}`;
  return (opts) => {
    if (opts.kind === "terminal") return new TerminalBridge(opts);
    return new RemoteBridge({ ...opts, baseUrl });
  };
}

const args = parseArgs();

let activeRemote: ConnectedRemote | null = null;

async function main(): Promise<void> {
  let makeBridge: BridgeFactory;
  if (args.backend === "remote") {
    if (!args.remote) { console.error("--remote requires [user@]host[:port]"); process.exit(2); }
    activeRemote = await connectRemote(parseRemoteTarget(args.remote));
    console.error(`[ashub] remote ${args.remote} → 127.0.0.1:${activeRemote.localPort}`);
    makeBridge = makeRemoteFactory(activeRemote);
  } else {
    makeBridge = makeFactory(args);
  }
  const opts: HubOpts = { port: args.port, host: args.host, webRoot: args.webRoot, makeBridge };
  startHub(opts);
}

main().catch((err) => {
  console.error(`[ashub] startup failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});

let _shuttingDown = false;
async function gracefulExit(): Promise<void> {
  if (_shuttingDown) return;
  _shuttingDown = true;
  try { await shutdownHub(); } catch {}
  if (activeRemote) { try { await activeRemote.close(); } catch {} }
  process.exit(0);
}
process.on("SIGINT", () => { void gracefulExit(); });
process.on("SIGTERM", () => { void gracefulExit(); });

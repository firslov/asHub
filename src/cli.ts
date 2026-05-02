/**
 * agent-sh-hub CLI entrypoint.
 *
 *   agent-sh-hub                                 # default: in-process ash
 *   agent-sh-hub --port 8080
 *   agent-sh-hub --backend acp --cmd "claude-code-acp"
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { startHub, type HubOpts } from "./hub.js";
import { AshBridge } from "./bridges/ash.js";
import { AcpBridge } from "./bridges/acp.js";
import type { BridgeFactory } from "./bridges/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

interface Args {
  port: number;
  host: string;
  webRoot: string;
  backend: "ash" | "acp";
  cmd: string;
  model?: string;
  provider?: string;
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
      if (v !== "ash" && v !== "acp") { console.error(`unknown backend: ${v}`); process.exit(2); }
      out.backend = v; i++;
    }
    else if (a === "--cmd" && v) { out.cmd = v; i++; }
    else if (a === "--model" && v) { out.model = v; i++; }
    else if (a === "--provider" && v) { out.provider = v; i++; }
    else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
  }
  return out;
}

function printHelp(): void {
  console.log(`agent-sh-hub — supervise headless agent sessions over HTTP

Usage:
  agent-sh-hub [options]

Options:
  --backend ash|acp     Bridge implementation (default ash)
  --port N              HTTP port (default 7878)
  --host HOST           Bind host (default 127.0.0.1)
  --web PATH            Static web root (default ./web)
  --model NAME          Model override (ash backend)
  --provider NAME       Provider override (ash backend)
  --cmd "CMD ARGS"      Spawn command for acp backend (default "agent-sh-acp")
  -h, --help            Show this help

Backends:
  ash   In-process agent-sh kernel. No subprocess; one less hop.
  acp   Spawn a JSON-RPC ACP child (agent-sh-acp, claude-code, etc.) per session.

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
    return (opts) => new AshBridge({ ...opts, model: opts.model ?? args.model, provider: opts.provider ?? args.provider });
  }
  const [command, ...spawnArgs] = args.cmd.split(/\s+/);
  return (opts) => new AcpBridge({
    ...opts,
    extra: { command: command!, args: spawnArgs },
  });
}

const args = parseArgs();

const opts: HubOpts = {
  port: args.port,
  host: args.host,
  webRoot: args.webRoot,
  makeBridge: makeFactory(args),
};

startHub(opts);

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

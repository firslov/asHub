/**
 * asHub CLI entrypoint.
 *
 *   ashub                                 # default: in-process ash
 *   ashub --port 8080
 *   ashub --backend acp --cmd "claude-code-acp"
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { HubOpts } from "./hub.js";
import type { BridgeFactory } from "./bridges/types.js";

// Check before loading any runtime dependencies: on Node 26, the built-in
// fetch does not use the proxy dispatcher configured by our installed Undici.
const nodeVersion = process.versions.node;
const [nodeMajor, nodeMinor] = nodeVersion.split(".").map(Number);
if (!((nodeMajor === 22 && nodeMinor >= 12) || (nodeMajor > 22 && nodeMajor < 26))) {
  console.error(`[ashub] Unsupported Node.js ${nodeVersion}. The asHub CLI requires Node.js >=22.12.0 <26. Use Node.js 22 or 24.`);
  process.exit(1);
}

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
  console.log(`asHub — supervise headless agent sessions over HTTP

Usage:
  ashub [options]

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

/** Split a command string respecting double quotes. */
function splitCommand(input: string): { command: string; args: string[] } {
  const args: string[] = [];
  let current = "";
  let inQuotes = false, hasArgument = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      hasArgument = true;
    } else if (ch === ' ' && !inQuotes) {
      if (hasArgument) { args.push(current); current = ""; hasArgument = false; }
    } else {
      hasArgument = true;
      current += ch;
    }
  }
  if (hasArgument) args.push(current);
  const command = args.shift() ?? "";
  return { command, args };
}

function makeFactory(args: Args): BridgeFactory {
  if (args.backend === "ash") {
    return (opts) => {
      if (opts.kind === "terminal") return new TerminalBridge(opts);
      return new AshBridge({ ...opts, model: opts.model ?? args.model, provider: opts.provider ?? args.provider });
    };
  }
  const { command, args: spawnArgs } = splitCommand(args.cmd);
  return (opts) => {
    if (opts.kind === "terminal") return new TerminalBridge(opts);
    return new AcpBridge({
      ...opts,
      extra: { command, args: spawnArgs },
    });
  };
}

const args = parseArgs();

// Keep the bootstraps ahead of the Hub and its providers on supported runtimes.
await import("./windows-bootstrap.js");
await import("./network-bootstrap.js");
const { startHub } = await import("./hub.js");
const { AshBridge } = await import("./bridges/ash.js");
const { AcpBridge } = await import("./bridges/acp.js");
const { TerminalBridge } = await import("./bridges/terminal.js");

const opts: HubOpts = {
  port: args.port,
  host: args.host,
  webRoot: args.webRoot,
  makeBridge: makeFactory(args),
};

const { shutdown } = startHub(opts);

let _shuttingDown = false;
async function gracefulExit(): Promise<void> {
  if (_shuttingDown) return;
  _shuttingDown = true;
  try { await shutdown(); } catch {}
  process.exit(0);
}
process.on("SIGINT", () => { void gracefulExit(); });
process.on("SIGTERM", () => { void gracefulExit(); });

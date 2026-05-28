/**
 * SSH bootstrap — VS Code-style remote install + tunnel.
 *
 * Sketch: leverages system `ssh` (reuses ~/.ssh/config and ssh-agent) via a
 * control-master so probe/install/launch/forward all share one auth.  Not
 * wired into the hub yet.  Production gaps flagged inline as TODO.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as net from "node:net";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { RemoteHost, ConnectedRemote } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
// Bundled builds substitute ASHUB_VERSION via esbuild's `define`; dev runs
// read package.json off disk.
declare const ASHUB_VERSION: string | undefined;
const LOCAL_VERSION: string = typeof ASHUB_VERSION === "string"
  ? ASHUB_VERSION
  : require_(path.join(__dirname, "..", "..", "package.json")).version;

// TODO: real release URL once the per-arch server tarballs ship.  See
// docs/remote-ssh.md §1 ("Portable server artifact").
const TARBALL_URL = (version: string, platform: string, arch: string): string =>
  `https://github.com/firslov/ashub/releases/download/v${version}/ashub-server-${platform}-${arch}.tar.gz`;

function controlSocketPath(hostId: string): string {
  return path.join(os.tmpdir(), `ashub-ssh-${hostId}-${process.pid}.sock`);
}

function sshTarget(host: RemoteHost): string {
  return host.user ? `${host.user}@${host.host}` : host.host;
}

function sshBaseArgs(host: RemoteHost): string[] {
  const a: string[] = [];
  if (host.port) a.push("-p", String(host.port));
  if (host.identityFile) a.push("-i", host.identityFile);
  return a;
}

function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

interface RunResult { stdout: string; stderr: string; code: number }

async function runOverCtrl(host: RemoteHost, ctrl: string, cmd: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const args = [...sshBaseArgs(host), "-T", "-S", ctrl, sshTarget(host), cmd];
    const child = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }));
  });
}

async function openControlMaster(host: RemoteHost, ctrl: string): Promise<void> {
  const args = [
    ...sshBaseArgs(host),
    "-MNf",
    "-o", "ControlPersist=600",
    "-o", "ExitOnForwardFailure=yes",
    "-S", ctrl,
    sshTarget(host),
  ];
  const r = spawnSync("ssh", args, { stdio: ["ignore", "ignore", "pipe"] });
  if (r.status !== 0) {
    const err = r.stderr?.toString().trim() ?? "";
    throw new Error(`ssh control master failed for ${host.host}: ${err || r.status}`);
  }
}

function closeControlMaster(host: RemoteHost, ctrl: string): void {
  const args = [...sshBaseArgs(host), "-S", ctrl, "-O", "exit", sshTarget(host)];
  spawnSync("ssh", args, { stdio: "ignore" });
  try { fs.rmSync(ctrl, { force: true }); } catch {}
}

interface ProbedPlatform { platform: "linux" | "darwin"; arch: "x64" | "arm64" }

async function probePlatform(host: RemoteHost, ctrl: string): Promise<ProbedPlatform> {
  const probe = await runOverCtrl(host, ctrl, "uname -sm");
  if (probe.code !== 0) throw new Error(`uname failed: ${probe.stderr.trim()}`);
  const [unameS, unameM] = probe.stdout.trim().split(/\s+/);
  const platform = unameS === "Darwin" ? "darwin" : unameS === "Linux" ? "linux" : null;
  const arch = (unameM === "arm64" || unameM === "aarch64") ? "arm64"
    : (unameM === "x86_64" || unameM === "amd64") ? "x64"
    : null;
  if (!platform || !arch) throw new Error(`unsupported remote: ${unameS}/${unameM}`);
  return { platform, arch };
}

async function ensureServer(host: RemoteHost, ctrl: string, version: string): Promise<string> {
  const installDir = `$HOME/.ashub-server/${version}`;
  const check = await runOverCtrl(host, ctrl, `test -x ${installDir}/bin/ashub && echo ok`);
  if (check.code === 0 && check.stdout.trim() === "ok") return installDir;

  const { platform, arch } = await probePlatform(host, ctrl);
  const url = TARBALL_URL(version, platform, arch);
  // TODO: checksum verification, scp-push fallback for air-gapped remotes.
  const installCmd = [
    `set -e`,
    `mkdir -p ${installDir}`,
    `tmp=$(mktemp)`,
    `trap 'rm -f $tmp' EXIT`,
    `curl -fsSL '${url}' -o "$tmp"`,
    `tar -xzf "$tmp" -C ${installDir} --strip-components=1`,
  ].join("; ");
  const install = await runOverCtrl(host, ctrl, installCmd);
  if (install.code !== 0) throw new Error(`install failed: ${install.stderr.trim()}`);
  return installDir;
}

interface LaunchedServer { remotePort: number; child: ChildProcess }

async function launchServer(host: RemoteHost, ctrl: string, installDir: string): Promise<LaunchedServer> {
  // Server prints "asHub listening on http://127.0.0.1:N/" to stderr (see
  // src/hub.ts startup log).  Needs the hub patch that logs the actual
  // bound port — required so --port 0 yields a parseable line.
  const remoteCmd = `${installDir}/bin/ashub --host 127.0.0.1 --port 0`;
  const args = [...sshBaseArgs(host), "-T", "-S", ctrl, sshTarget(host), remoteCmd];
  const child = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });

  const remotePort = await new Promise<number>((resolve, reject) => {
    let buf = "";
    const onChunk = (d: Buffer): void => {
      buf += d.toString();
      const m = buf.match(/listening on https?:\/\/[^:]+:(\d+)/i);
      if (m) {
        child.stdout?.off("data", onChunk);
        child.stderr?.off("data", onChunk);
        resolve(parseInt(m[1]!, 10));
      }
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    const onExit = (code: number | null): void => reject(new Error(`server exited (code ${code}) before printing listen line`));
    child.once("close", onExit);
    setTimeout(() => reject(new Error("server startup timeout (15s)")), 15_000);
  });

  return { remotePort, child };
}

async function addForward(host: RemoteHost, ctrl: string, localPort: number, remotePort: number): Promise<void> {
  const args = [
    ...sshBaseArgs(host),
    "-S", ctrl,
    "-O", "forward",
    "-L", `${localPort}:127.0.0.1:${remotePort}`,
    sshTarget(host),
  ];
  const r = spawnSync("ssh", args, { stdio: ["ignore", "ignore", "pipe"] });
  if (r.status !== 0) {
    const err = r.stderr?.toString().trim() ?? "";
    throw new Error(`ssh forward failed: ${err || r.status}`);
  }
}

export async function connectRemote(host: RemoteHost): Promise<ConnectedRemote> {
  const version = host.serverVersion ?? LOCAL_VERSION;
  const ctrl = controlSocketPath(host.id);
  try { fs.rmSync(ctrl, { force: true }); } catch {}

  await openControlMaster(host, ctrl);
  let server: LaunchedServer | null = null;
  try {
    const installDir = await ensureServer(host, ctrl, version);
    server = await launchServer(host, ctrl, installDir);
    const localPort = await pickFreePort();
    await addForward(host, ctrl, localPort, server.remotePort);
    const launched = server;
    return {
      host,
      localPort,
      close: async (): Promise<void> => {
        try { launched.child.kill("SIGTERM"); } catch {}
        closeControlMaster(host, ctrl);
      },
    };
  } catch (err) {
    if (server) { try { server.child.kill("SIGTERM"); } catch {} }
    closeControlMaster(host, ctrl);
    throw err;
  }
}

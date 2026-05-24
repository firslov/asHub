/**
 * Per-agent shell — spawns a node-pty alongside an AshBridge core, delegates
 * rc generation to agent-sh's shell strategies (zsh/bash/fish + fallback),
 * and parses the PTY stream to emit shell:cwd-change / shell:command-start /
 * shell:command-done.
 *
 * The shell is owned by the agent: commands typed via the composer's `!`
 * prefix flow into this PTY.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import { randomBytes } from "node:crypto";
import * as pty from "node-pty";
import { pickStrategy, FALLBACK_STRATEGY } from "agent-sh/shell/strategies";

const OSC_PROMPT = (tag: string) => new RegExp(`\\x1b\\]9999;id=${tag};PROMPT\\x07`);
const OSC_PREEXEC = (tag: string) => new RegExp(`\\x1b\\]9997;id=${tag};([^\\x07]*)\\x07`);
const OSC_CWD = /\x1b\]7;file:\/\/[^/]*(\/[^\x07\x1b]*)/;
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[PX^_].*?\x1b\\|\x1b[()][AB012]/g;

const stripAnsi = (s: string): string => s.replace(ANSI_RE, "").replace(/\r/g, "");

interface ShellBus {
  emit(name: string, payload: Record<string, unknown>): void;
}

/** Parses PTY output to detect cwd + command boundaries. */
export class AgentShellParser {
  private cwd: string;
  private tag: string;
  private capture = "";
  private lastCommand = "";
  private foregroundBusy = false;
  private promptRe: RegExp;
  private preexecRe: RegExp;
  constructor(private bus: ShellBus, initialCwd: string, tag: string) {
    this.cwd = initialCwd;
    this.tag = tag;
    this.promptRe = OSC_PROMPT(tag);
    this.preexecRe = OSC_PREEXEC(tag);
  }
  getCwd(): string { return this.cwd; }
  processData(data: string): void {
    this.parseCwd(data);
    data = this.parsePreexec(data);
    this.parsePrompt(data);
  }
  private parseCwd(data: string): void {
    const m = data.match(OSC_CWD);
    if (!m?.[1]) return;
    const next = decodeURIComponent(m[1]);
    if (next !== this.cwd) {
      this.cwd = next;
      this.bus.emit("shell:cwd-change", { cwd: next });
    }
  }
  private parsePreexec(data: string): string {
    const m = this.preexecRe.exec(data);
    if (!m) return data;
    this.lastCommand = m[1] ?? "";
    this.capture = "";
    if (!this.foregroundBusy) {
      this.foregroundBusy = true;
      this.bus.emit("shell:foreground-busy", { busy: true });
    }
    this.bus.emit("shell:command-start", { command: this.lastCommand, cwd: this.cwd });
    return data.slice(0, m.index) + data.slice(m.index + m[0].length);
  }
  private parsePrompt(data: string): void {
    const m = this.promptRe.exec(data);
    if (!m) {
      this.capture += data;
      if (this.capture.length > 128 * 1024) this.capture = this.capture.slice(-128 * 1024);
      return;
    }
    if (m.index > 0) this.capture += data.slice(0, m.index);
    if (this.foregroundBusy) {
      this.foregroundBusy = false;
      this.bus.emit("shell:foreground-busy", { busy: false });
    }
    if (this.lastCommand) {
      const output = cleanCapture(this.capture, this.lastCommand);
      this.bus.emit("shell:command-done", {
        command: this.lastCommand,
        output,
        cwd: this.cwd,
        exitCode: null,
      });
    }
    this.lastCommand = "";
    this.capture = "";
  }
}

const PROMPT_MARKER_RE = /^[>$❯%][ \t]*$/;
const PATH_LINE_RE = /^(?:\/|~)[\w\-./~ ]*$/;
const ZSH_PARTIAL_TAIL_RE = /(?:\x1b\[[0-9;?]*[A-Za-z])*[ \t]*%[ \t]*(?:\x1b\[[0-9;?]*[A-Za-z]|\x1b\[K)*$/;

function cleanCapture(capture: string, command: string): string {
  const lines = capture.replace(/\r/g, "").split("\n");
  if (lines.length && stripAnsi(lines[0]).includes(command.slice(0, 20))) {
    lines.shift();
  }
  while (lines.length) {
    const tail = stripAnsi(lines[lines.length - 1]).trim();
    if (tail === "" || PROMPT_MARKER_RE.test(tail) || PATH_LINE_RE.test(tail)) {
      lines.pop();
      continue;
    }
    break;
  }
  if (lines.length) {
    const last = lines[lines.length - 1];
    if (/[ \t]*%[ \t]*$/.test(stripAnsi(last))) {
      lines[lines.length - 1] = last.replace(ZSH_PARTIAL_TAIL_RE, "");
    }
  }
  return lines.join("\n");
}

interface SpawnConfig {
  pty: pty.IPty;
  tag: string;
  tmpDir: string;
  shellPath: string;
}

/** Spawn the user's shell via agent-sh's strategy system (zsh/bash/fish + fallback). */
export function spawnAgentShell(opts: {
  cwd: string;
  cols?: number;
  rows?: number;
}): SpawnConfig {
  const tag = randomBytes(4).toString("hex");
  const shellPath = process.env.SHELL || (process.platform === "win32" ? (process.env.COMSPEC ?? "cmd.exe") : "/bin/bash");

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") env[k] = v;
  env.TERM = env.TERM && env.TERM !== "dumb" ? env.TERM : "xterm-256color";

  const strategy = pickStrategy(shellPath) ?? FALLBACK_STRATEGY;
  const spawnCfg = strategy.prepareSpawn({
    tmpDirRoot: os.tmpdir(),
    instanceTag: `id=${tag}`,
    showIndicator: false,
    userHome: env.HOME || os.homedir(),
    env,
  });
  Object.assign(env, spawnCfg.envOverrides);

  const proc = pty.spawn(shellPath, spawnCfg.args, {
    name: env.TERM,
    cols: opts.cols ?? 100,
    rows: opts.rows ?? 30,
    cwd: opts.cwd,
    env,
  });

  return { pty: proc, tag, tmpDir: spawnCfg.tmpDir ?? "", shellPath };
}

export function cleanupAgentShell(cfg: SpawnConfig): void {
  try { cfg.pty.kill(); } catch {}
  if (cfg.tmpDir) {
    try { fs.rmSync(cfg.tmpDir, { recursive: true, force: true }); } catch {}
  }
}

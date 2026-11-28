import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { AcpBridge, type AcpBridgeExtra } from "../../bridges/acp.js";
import type { BridgeOpts, CollaborationTurn } from "../../bridges/types.js";
import { RuntimeEnvironment } from "../../services/runtime-environment.js";
import { MAX_REVIEW_CHARS, reviewDelivery, reviewPrompt } from "./review.js";

export const ANTIGRAVITY_SERVICE_URL = "https://daily-cloudcode-pa.googleapis.com";
type ResolveProxy = () => Promise<string> | undefined;

export function createAntigravityPlugin(resolveProxy?: ResolveProxy) {
  const experimental = process.env.ASHUB_EXPERIMENTAL_ANTIGRAVITY_WORKER === "1";
  return {
    projectSessionBackends: experimental ? [{ id: "google-antigravity", label: "Google Antigravity (Experimental)", kind: "antigravity", taskProfile: "inline-review", authorization: "project" }] as const : [],
    makeBridge(opts: BridgeOpts) {
      if (opts.projectWorker && !experimental) throw new Error("Google Antigravity project reviews require the experimental flag.");
      return createAntigravityBridge(opts, resolveProxy);
    },
  };
}

export function antigravityProxyUrl(resolution: string): string | undefined {
  // Chromium returns the preferred route first. DIRECT is an explicit bypass.
  const [, scheme, authority] = /^(PROXY|HTTPS|SOCKS5)\s+(\S+)$/.exec(resolution.split(";")[0]?.trim() ?? "") ?? [];
  if (!authority) return;
  try {
    const proxy = new URL(`${scheme === "PROXY" ? "http" : scheme.toLowerCase()}://${authority}`);
    if (!proxy.hostname || proxy.username || proxy.password || proxy.pathname !== "/" && proxy.pathname !== ""
      || proxy.search || proxy.hash) return;
    return proxy.href;
  } catch { return; }
}

function resolveSystemProxy(resolveProxy: ResolveProxy, signal: AbortSignal): Promise<string | undefined> {
  return new Promise(resolve => {
    const finish = (proxy?: string) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", fallback);
      resolve(proxy);
    };
    const fallback = () => finish();
    const timer = setTimeout(fallback, 2000);
    signal.addEventListener("abort", fallback, { once: true });
    Promise.resolve().then(() => signal.aborted ? undefined : resolveProxy()).then(finish, fallback);
  });
}

function contains(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`));
}

function workerDirectory(opts: BridgeOpts): { cwd: string; name: string } {
  const restoring = opts.isRestored || !!opts.restoreState?.acpSessionId;
  const name = restoring ? opts.restoreState?.antigravityWorkerDir : `ashub-agy-${randomUUID()}`;
  if (typeof name !== "string" || !/^ashub-agy-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(name)) {
    throw new Error("Antigravity project worker has no valid isolated directory; create a new worker session.");
  }
  const root = fs.realpathSync(os.tmpdir());
  const cwd = path.join(root, name);
  const appRoot = fs.realpathSync(fileURLToPath(new URL("../../../", import.meta.url)));
  const projectRoot = fs.realpathSync(opts.cwd ?? process.cwd());
  if ([appRoot, projectRoot].some(dir => contains(dir, cwd) || contains(cwd, dir))) {
    throw new Error("Antigravity project worker requires a temporary directory outside the project and application.");
  }
  try { fs.mkdirSync(cwd, { mode: 0o700 }); }
  catch (error) {
    if (!restoring || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = fs.lstatSync(cwd);
  if (!stat.isDirectory() || fs.realpathSync(cwd) !== cwd
    || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700))
    || fs.readdirSync(cwd).length > 0) {
    throw new Error("Antigravity project worker temporary directory is not private and empty.");
  }
  return { cwd, name };
}

const CANCEL_GRACE_MS = 2000;

class AntigravityWorkerBridge extends AcpBridge {
  private activeTurn?: AbortController;
  private cancelTimer?: ReturnType<typeof setTimeout>;

  constructor(opts: BridgeOpts, extra: AcpBridgeExtra, private readonly directory: ReturnType<typeof workerDirectory>) {
    super({ ...opts, cwd: directory.cwd, extra: {
      ...extra,
      args: [...(extra.args ?? []), "--sandbox", "--include-default-customizations=false"],
      denyPermissions: true,
      freshTextTurns: true,
    } });
    this.onClose(() => this.activeTurn?.abort());
  }

  override getRestoreState(): Record<string, unknown> {
    return { antigravityWorkerDir: this.directory.name };
  }

  override async submit(_text: string): Promise<{ stopReason: string }> {
    throw new Error("Antigravity project workers only accept authorized collaboration tasks.");
  }

  async submitTask(turn: CollaborationTurn): Promise<{ stopReason: string }> {
    turn.signal.throwIfAborted();
    if (this.activeTurn) throw new Error("Antigravity project worker already has an active task.");
    const scope = this.activeTurn = new AbortController();
    const abort = () => this.cancel();
    turn.signal.addEventListener("abort", abort, { once: true });
    try {
      await this.ready();
      scope.signal.throwIfAborted();
      const { id, message } = turn.read();
      const validate = () => {
        scope.signal.throwIfAborted();
        const current = turn.read();
        if (current.id !== id || current.message !== message) throw new Error("Antigravity review materials changed after approval.");
      };
      turn.assertExternalSendAllowed();
      const nonce = randomUUID();
      const result = await this.submitFreshTextPrompt(this.directory.cwd, reviewPrompt(message, nonce), scope.signal, MAX_REVIEW_CHARS, () => {
        validate();
        turn.assertExternalSendAllowed();
      });
      validate();
      if (result.stopReason !== "end_turn") throw new Error("Antigravity review did not end normally.");
      const delivery = reviewDelivery(result.text, nonce);
      await turn.deliver(delivery);
      return { stopReason: "end_turn" };
    } finally {
      this.clearCancelTimer();
      scope.abort();
      turn.signal.removeEventListener("abort", abort);
      this.activeTurn = undefined;
    }
  }

  override cancel(): void {
    const scope = this.activeTurn;
    if (!scope || scope.signal.aborted) return;
    scope.abort();
    // Before the prompt is sent, its abort check is enough. Once sent,
    // session/cancel is a notification; the prompt response is the ack.
    if (!this.isProcessing()) return;
    this.cancelTimer = setTimeout(() => {
      if (this.activeTurn === scope && this.isProcessing()) this.close();
    }, CANCEL_GRACE_MS);
    super.cancel();
  }

  private clearCancelTimer(): void {
    clearTimeout(this.cancelTimer);
    this.cancelTimer = undefined;
  }

  override close(): void {
    this.clearCancelTimer();
    this.activeTurn?.abort();
    super.close();
  }
}

export function createAntigravityBridge(opts: BridgeOpts, resolveProxy?: ResolveProxy): AcpBridge & Partial<Pick<AntigravityWorkerBridge, "submitTask">> {
  const runtime = new RuntimeEnvironment();
  const command = runtime.resolveCommand("agy");
  if (!command) throw new Error("Antigravity CLI (agy) is missing. Install it and run agy acp --login.");
  const inherited = runtime.commandEnvironment();
  // Workers need normal OS/login/proxy settings, not the host's other API keys,
  // asHub access token, Node preload options, or agent-sh home override.
  const env = opts.projectWorker ? Object.fromEntries(Object.entries(inherited).filter(([key]) =>
    /^(PATH|HOME|USER|LOGNAME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|SYSTEMROOT|WINDIR|COMSPEC|PROGRAMFILES(\(X86\))?|PATHEXT|TEMP|TMP|TMPDIR|LANG|LANGUAGE|LC_[A-Z_]+|TZ|XDG_(CONFIG|DATA|CACHE|STATE)_HOME|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR)$/i.test(key)
  )) : inherited;
  for (const key of ["AGY_ADC_AUTH", "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_CLOUD_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_APPLICATION_CREDENTIALS"]) {
    delete env[key];
  }
  const extra: AcpBridgeExtra = {
    command, args: ["acp"], env,
    promptFormat: "text",
    emitCancelledEvent: true,
    initializeTimeoutMessage: "Antigravity session startup timed out. Check your Google sign-in and system proxy, then try again.",
    formatRpcError: error => error.code === -32000 && /auth|sign.in|log.in/i.test(error.message)
      ? "Sign in to Antigravity with your Google account in Terminal using agy acp --login, then try again."
      : error.message,
    prepareEnv: resolveProxy && !env.HTTPS_PROXY && !env.https_proxy ? async signal => {
      // The CLI is a subprocess and needs Chromium's current route in its own environment.
      const proxy = antigravityProxyUrl(await resolveSystemProxy(resolveProxy, signal) ?? "");
      if (proxy) env.HTTPS_PROXY = proxy;
      return env;
    } : undefined,
  };
  const acpOpts: BridgeOpts = {
    cwd: opts.cwd,
    isRestored: opts.isRestored,
    restoreBackend: opts.restoreBackend,
    restoreState: opts.restoreState,
  };
  return opts.projectWorker
    ? new AntigravityWorkerBridge(acpOpts, extra, workerDirectory(opts))
    : new AcpBridge({ ...acpOpts, extra: { ...extra } });
}

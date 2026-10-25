import { registerNetworkEndpoint } from "../network-policy.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR, getSettings } from "agent-sh/settings";
import { BUILTIN_EXTENSIONS } from "agent-sh/extensions";
import type { AgentShellCore } from "agent-sh";
import { observeCodexUsage, type CodexUsage } from "./codex-usage.js";
import type { RequestDiagnostic } from "../request-diagnostics.js";

type Context = ReturnType<AgentShellCore["extensionContext"]>;

/** Only return readiness, never credentials, to the hub or renderer. */
export function codexStatus() {
  const settings = getSettings();
  const enabled = !settings.disabledBuiltins?.includes("codex-provider");
  const config = (settings as unknown as Record<string, unknown>)["codex-provider"] as { providerId?: string } | undefined;
  const providerId = config?.providerId || "codex";
  let configured = false;
  if (enabled) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, "codex-provider", "auth.json"), "utf8"));
      configured = !!c && [c.access, c.refresh, c.accountId].every(v => typeof v === "string" && v.length > 0)
        && typeof c.expires === "number" && Number.isFinite(c.expires);
      // An expired access token can still be renewed with the refresh token.
    } catch { /* Signed out, missing or invalid credentials. */ }
  }
  return { enabled, configured, providerId };
}

/** Give the upstream built-in a real per-session lifetime and stable commands.
 * Re-activate when another session signs in/out; each session owns its proxy.
 */
export class CodexProviderHost {
  private closed = false;
  private signature = "";
  private pending: Promise<void> | null = null;
  private dispose: (() => void) | null = null;
  private commands = new Map<string, (args: string) => void | Promise<void>>();

  constructor(private ctx: Context, private onUsage?: (usage: CodexUsage) => void, private onRequest?: (event: RequestDiagnostic) => void) {}

  sync(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.pending) return this.pending.then(() => this.sync());
    const status = codexStatus();
    const signature = JSON.stringify([status, (getSettings() as unknown as Record<string, unknown>)["codex-provider"]]);
    if (signature === this.signature) return Promise.resolve();
    const work = this.activate(status.enabled, signature);
    this.pending = work;
    return work.finally(() => { if (this.pending === work) this.pending = null; });
  }

  private async activate(enabled: boolean, signature: string): Promise<void> {
    // Once the old activation is released, its signature is no longer valid,
    // including when loading the replacement fails and settings are reverted.
    this.signature = "";
    this.dispose?.();
    this.dispose = null;
    this.commands.clear();
    if (!enabled || this.closed) { this.signature = signature; return; }
    const active = this.ctx.call("agent:get-model") as { provider?: string; model?: string } | undefined;
    const builtin = BUILTIN_EXTENSIONS.find(ext => ext.name === "codex-provider");
    if (!builtin) throw new Error("Kernel is missing the Codex provider");
    const activate = await builtin.load();
    if (this.closed) return;
    let disposed = false;
    const cleanups: Array<() => void> = [];
    const dispose = () => {
      disposed = true;
      // The upstream proxy is assigned asynchronously. Re-running its closer
      // also handles login completing after the session was closed.
      for (const cleanup of cleanups) {
        try { cleanup(); } catch { /* Continue releasing other resources. */ }
      }
    };
    this.dispose = dispose;
    const agent = this.ctx.agent;
    if (!agent) return;
    const sessionId = this.ctx.call("session:current-id");
    if (typeof sessionId === "string" && sessionId) {
      const config = this.ctx.getExtensionSettings("codex-provider", {
        upstreamURL: "https://chatgpt.com/backend-api/codex/responses",
      });
      cleanups.push(registerNetworkEndpoint(config.upstreamURL, sessionId));
      if (this.onUsage || this.onRequest) cleanups.push(observeCodexUsage(config.upstreamURL, sessionId, this.onUsage ?? (() => {}), this.onRequest));
    }
    const context = {
      ...this.ctx,
      agent: {
        ...agent,
        providers: {
          ...agent.providers,
          register: (reg: Parameters<typeof agent.providers.register>[0]) => {
            if (disposed || this.closed) { dispose(); return () => {}; }
            const unregister = agent.providers.register(reg);
            let registered = true;
            return () => {
              // Upstream unregisters by provider id. A repeated old cleanup
              // would otherwise remove a newer activation with the same id.
              if (!registered) return;
              registered = false;
              unregister();
            };
          },
        },
      },
      onDispose: (fn: () => void) => { cleanups.push(fn); if (disposed) dispose(); },
      registerCommand: (name: string, description: string, handler: (args: string) => void | Promise<void>) => {
        if (disposed || this.closed) return;
        const key = name.startsWith("/") ? name : `/${name}`;
        this.commands.set(key, handler);
        if (this.ctx.list().includes(`command:${key}`)) return;
        this.ctx.registerCommand(name, description, async (args: string) => {
          await this.sync();
          if (!this.closed) await this.commands.get(key)?.(args);
          await this.sync();
        });
      },
    } as Context;
    try {
      await activate(context);
      if (this.closed) dispose();
      else {
        this.signature = signature;
        // Replacing a proxy changes its port and secret. The active LLM client
        // must resolve the new endpoint even when the model id is unchanged.
        if (codexStatus().configured && active?.provider === codexStatus().providerId && active.model) {
          this.ctx.bus.emit("config:switch-model", { id: active.model, provider: active.provider });
        }
      }
    } catch (err) { dispose(); throw err; }
  }

  close(): void {
    this.closed = true;
    this.commands.clear();
    this.dispose?.();
  }
}

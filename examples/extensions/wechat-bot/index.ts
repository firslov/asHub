/**
 * wechat-bot — send WeChat messages from agent-sh.
 *
 * Bridges agent-sh to a running `wechat-ilink-bot` webhook service so the
 * agent can send text messages to WeChat contacts on the user's behalf.
 *
 * Prerequisites (all via the wechat-ilink-bot Python SDK):
 *   1. Install:      pip install "wechat-ilink-bot[webhook]"
 *   2. Log in once:  wechat-bot login      # scan the QR code; state persists
 *   3. Start:        wechat-bot webhook --api-key your-secret
 *
 * Configure in ~/.agent-sh/settings.json:
 *   {
 *     "wechat-bot": {
 *       "baseUrl": "http://127.0.0.1:8787",
 *       "apiKey": "your-secret",
 *       "defaultTo": ""
 *     }
 *   }
 *
 * `defaultTo` (optional) is the recipient used when the tool is called
 * without a `to` argument. Leave it empty to send to the bot owner.
 */
import type { AgentContext } from "agent-sh/types";

// Object-literal type (not an explicit interface) so it carries an implicit
// index signature and satisfies getExtensionSettings' Record<string, unknown>.
const DEFAULT_CONFIG = {
  baseUrl: "http://127.0.0.1:8787",
  apiKey: "",
  defaultTo: "",
};

const REQUEST_TIMEOUT_MS = 10_000;

export default function activate(ctx: AgentContext) {
  const config = ctx.getExtensionSettings("wechat-bot", DEFAULT_CONFIG);
  const baseUrl = (config.baseUrl || DEFAULT_CONFIG.baseUrl).replace(/\/+$/, "");

  ctx.agent.registerTool({
    name: "send_wechat_message",
    displayName: "WeChat",
    description:
      "Send a text message to WeChat through the wechat-ilink-bot webhook. " +
      "Use this when the user asks to notify, remind, or message someone on WeChat. " +
      "Omit `to` to send to the default recipient (the bot owner). " +
      "Confirm the recipient and content are clear before sending.",
    input_schema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Message content to send.",
        },
        to: {
          type: "string",
          description:
            "Optional recipient (e.g. o9xxx@im.wechat). Omit for the default recipient.",
        },
      },
      required: ["text"],
    },
    // Sending has an external side effect: don't cache, parallelize, or
    // retry it as if it were a read-only operation.
    modifiesFiles: true,
    readOnly: false,
    formatCall: (args) => {
      const to = args.to ? String(args.to) : "owner";
      const preview = String(args.text ?? "").replace(/\s+/g, " ").slice(0, 40);
      return `→ ${to}: ${preview}`;
    },
    async execute(args) {
      const text = String(args.text ?? "").trim();
      if (!text) {
        return { content: "Error: message text is empty", exitCode: 1, isError: true };
      }
      const to = args.to ? String(args.to).trim() : (config.defaultTo || "").trim();

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const res = await fetch(`${baseUrl}/send`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(config.apiKey ? { "X-Webhook-Key": config.apiKey } : {}),
          },
          body: JSON.stringify({ text, ...(to ? { to } : {}) }),
          signal: controller.signal,
        });

        const data = (await res.json().catch(() => ({}))) as {
          status?: number;
          detail?: string;
        };

        if (res.ok && data.status === 200) {
          return {
            content: `WeChat message sent${to ? ` to ${to}` : " to the default recipient"}.`,
            exitCode: 0,
            isError: false,
          };
        }

        return {
          content: `Error: failed to send WeChat message (HTTP ${res.status}): ${data.detail || JSON.stringify(data)}`,
          exitCode: 1,
          isError: true,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isTimeout = err instanceof Error && err.name === "AbortError";
        const hint = isTimeout
          ? `wechat-bot webhook timed out at ${baseUrl}.`
          : `could not reach wechat-bot webhook at ${baseUrl} (${msg}).`;
        return {
          content: `Error: ${hint} Is the service running? Start it with: wechat-bot webhook --api-key <key>`,
          exitCode: 1,
          isError: true,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  });

  ctx.agent.registerInstruction(
    "wechat-bot",
    "You have a `send_wechat_message` tool for sending WeChat messages. " +
      "When the user asks to send or notify something on WeChat, use it; " +
      "keep the message concise and confirm the recipient before sending.",
  );
}

import type { AgentShellCore } from "agent-sh";

// https://api-docs.deepseek.com/api/list-models/
// Legacy Flash IDs are still routed to V4.1 Flash by the official endpoint.
export const DEEPSEEK_MODELS = [
  { id: "deepseek-flash", modalities: ["text", "image"] },
  { id: "deepseek-v4-pro", modalities: ["text"] },
  { id: "deepseek-v4-flash", modalities: ["text", "image"] },
  { id: "deepseek-v4-flash-vision-exp", modalities: ["text", "image"] },
].map(model => ({
  ...model,
  modalities: model.modalities as ("text" | "image")[],
  reasoning: true,
  echoReasoning: true,
  contextWindow: 1_048_576,
  maxTokens: 393_216,
}));

export function deepSeekReasoningParams(level: string): Record<string, unknown> {
  if (level === "off") return { thinking: { type: "disabled" } };
  // agent-sh 0.15.17 stores the highest level as xhigh; older presets use medium.
  const effort = level === "xhigh" || level === "max" ? "max" : level === "low" ? "low" : "high";
  return { thinking: { type: "enabled" }, reasoning_effort: effort };
}

export function configureDeepSeek(ctx: ReturnType<AgentShellCore["extensionContext"]>): void {
  if (!ctx.agent?.providers) return;
  const previous = ctx.bus.emitPipe("agent:providers", { providers: [] }).providers.find(p => p.id === "deepseek");
  if (!previous) return;
  // Keep credentials, endpoint and the native cache hook. Explicit user settings
  // remain authoritative through agent-sh's settings overlay.
  ctx.agent.providers.configure("deepseek", { reasoningParams: deepSeekReasoningParams });
  ctx.agent.providers.register({ ...previous, defaultModel: "deepseek-flash", models: DEEPSEEK_MODELS });
}

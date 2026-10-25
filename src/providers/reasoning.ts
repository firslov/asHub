import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getSettings, resolveProvider } from "agent-sh/settings";

export interface ReasoningModel { id: string; provider: string; reasoning?: boolean; supportsReasoningEffort?: boolean }
export interface ReasoningProfile { levels: string[]; format: "effort" | "thinking" | "router"; defaultLevel?: string }
export interface ThinkingState { model: string; provider: string; level: string; levels: string[]; supported: boolean; defaultLevel?: string }
const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

// Codex app metadata may include client modes (ultra delegates tasks). Only
// backend reasoning.effort values are valid for asHub's single model request.
// Read metadata only; do not expose or read authentication files here.
let cacheStamp = "", cachedModels: Record<string, unknown>[] = [];
function codexModels(): Record<string, unknown>[] {
  const file = path.join(os.homedir(), ".codex", "models_cache.json");
  try {
    const stat = fs.statSync(file), stamp = `${file}:${stat.mtimeMs}:${stat.size}`;
    if (stamp !== cacheStamp) {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      cachedModels = Array.isArray(data?.models) ? data.models.filter((m: unknown) => m && typeof m === "object") : [];
      cacheStamp = stamp;
    }
    return cachedModels;
  } catch { cacheStamp = ""; cachedModels = []; return []; }
}

// Exact known families, never a generic five-step ladder for unknown models.
// Sources: developers.openai.com/api/docs/models; api-docs.deepseek.com/guides/thinking_mode;
// docs.z.ai/guides/capabilities/thinking-mode; github.com/zai-org/GLM-5.
export function reasoningProfile(model: ReasoningModel): ReasoningProfile | null {
  if (model.reasoning === false || model.supportsReasoningEffort === false) return null;
  const settings = getSettings() as unknown as Record<string, unknown>;
  const codex = settings["codex-provider"] as { providerId?: string } | undefined;
  const isCodex = model.provider === (codex?.providerId || "codex");
  const shape = isCodex ? "codex" : resolveProvider(model.provider)?.reasoningShape || model.provider;
  const id = model.id.toLowerCase().replace(/-\d{4}-\d{2}-\d{2}$/, "");
  const make = (levels: string[], format: ReasoningProfile["format"] = "effort", defaultLevel?: string) => ({ levels, format, defaultLevel });
  if (shape === "codex") {
    const entry = codexModels().find(m => m.slug === model.id);
    if (Array.isArray(entry?.supported_reasoning_levels)) {
      const levels = [...new Set(entry.supported_reasoning_levels.map((v: { effort?: unknown }) => v?.effort)
        .filter((v): v is string => typeof v === "string" && EFFORTS.has(v)))];
      return levels.length ? make(levels, "effort", typeof entry.default_reasoning_level === "string" && levels.includes(entry.default_reasoning_level) ? entry.default_reasoning_level : undefined) : null;
    }
    if (/^(?:gpt-6-(?:astra|sol|luna)|gpt-6\.1-sol)$/.test(id)) return make(["low", "medium", "high", "xhigh", "max"], "effort", "medium");
    if (/^gpt-5(?:\.1)?-codex(?:-mini)?$/.test(id)) return make(["low", "medium", "high"]);
    if (/^gpt-5\.(?:2|3)-codex$|^gpt-5\.1-codex-max$|^gpt-5\.(?:4|5)(?:-mini)?$/.test(id)) return make(["low", "medium", "high", "xhigh"]);
    return null;
  }
  if (shape === "deepseek" && /^(deepseek-flash|deepseek-v4-(?:pro|flash)(?:-vision-exp)?)$/.test(id)) {
    return make(["off", "low", "high", "max"], "thinking", "high");
  }
  if (shape === "zai-coding-plan") {
    if (/^glm-5\.3(?:-flash)?$/.test(id)) return make(["low", "high", "max"], "thinking", "max");
    if (id === "glm-5.2") return make(["off", "high", "max"], "thinking", "max");
    if (/^glm-(?:5(?:\.1|-turbo)?|4\.[567](?:-flash)?)$/.test(id)) return make(["off", "on"], "thinking", "on");
    return null;
  }
  if (shape === "openai" || shape === "openai-compatible" || shape === "openrouter") {
    // A router may translate the OpenAI reasoning vocabulary, but unknown
    // third-party families must not inherit OpenAI's effort choices.
    const target = shape === "openrouter" && id.startsWith("openai/") ? id.slice(7) : id;
    const format = shape === "openrouter" ? "router" : "effort";
    if (/^gpt-5(?:-mini|-nano)?$/.test(target)) return make(["minimal", "low", "medium", "high"], format, "medium");
    if (target === "gpt-5.1") return make(["none", "low", "medium", "high"], format, "none");
    if (/^gpt-5\.(?:2|4)(?:-mini|-nano)?$/.test(target)) return make(["none", "low", "medium", "high", "xhigh"], format, "none");
    if (/^(?:o1|o3|o3-mini|o4-mini)$/.test(target)) return make(["low", "medium", "high"], format, "medium");
  }
  return null;
}

export function nativeReasoningParams(profile: ReasoningProfile, level: string): Record<string, unknown> {
  if (level === "default") return {};
  if (!profile.levels.includes(level)) throw new Error(`Unsupported thinking level: ${level}`);
  if (profile.format === "thinking") return level === "off" ? { thinking: { type: "disabled" } }
    : { thinking: { type: "enabled" }, ...(level === "on" ? {} : { reasoning_effort: level }) };
  if (profile.format === "router") return { reasoning: { effort: level } };
  return { reasoning_effort: level };
}

/** Per-conversation selections; native values never go through the kernel's
 * fixed five-level validator. Applied at its main-loop llm:request event only,
 * leaving subagents and title generation with their own reasoning budgets. */
export class SessionThinking {
  private selections = new Map<string, string>();
  constructor(saved?: unknown) {
    if (!Array.isArray(saved)) return;
    for (const item of saved.slice(-128)) {
      if (Array.isArray(item) && item.length === 2 && item.every(v => typeof v === "string")
        && item[0].length < 512 && /^(default|off|on|none|minimal|low|medium|high|xhigh|max|ultra)$/.test(item[1])) this.selections.set(item[0], item[1]);
    }
  }
  restoreState() { return this.selections.size ? [...this.selections] : undefined; }
  private key(model: ReasoningModel) { return JSON.stringify([model.provider, model.id]); }
  state(model: ReasoningModel, legacy = "off"): ThinkingState {
    const profile = reasoningProfile(model), levels = profile?.levels ?? [];
    let saved = this.selections.get(this.key(model));
    const codex = (getSettings() as unknown as Record<string, any>)["codex-provider"];
    if (saved === "ultra" && model.provider === (codex?.providerId || "codex") && levels.includes("max")) {
      // Repair persisted selections from the old client-mode/backend mismatch.
      saved = "max"; this.selections.set(this.key(model), saved);
    }
    let level = saved ?? legacy;
    if (!saved) {
      // Preserve existing off settings when the model has an actual disabled
      // (or minimal) mode. Codex and mandatory-reasoning models use default.
      if (legacy === "off") level = ["off", "none", "minimal"].find(v => levels.includes(v)) ?? "default";
      // Existing DeepSeek preferences used xhigh to send max, medium to send high.
      if (profile?.format === "thinking" && model.provider === "deepseek") {
        if (legacy === "xhigh") level = "max";
        if (legacy === "medium") level = "high";
      }
    }
    if (!levels.includes(level)) level = "default";
    return { model: model.id, provider: model.provider, level, levels, supported: levels.length > 0, defaultLevel: profile?.defaultLevel };
  }
  set(model: ReasoningModel, level: string) {
    const profile = reasoningProfile(model);
    if (!profile || (level !== "default" && !profile.levels.includes(level))) throw new Error(`Unsupported thinking level for ${model.id}: ${level}`);
    this.selections.set(this.key(model), level);
    if (this.selections.size > 128) this.selections.delete(this.selections.keys().next().value!);
  }
  apply(request: Record<string, unknown>, model: ReasoningModel, legacy: string) {
    const profile = reasoningProfile(model);
    if (!profile) return;
    const params = nativeReasoningParams(profile, this.state(model, legacy).level);
    delete request.reasoning_effort; delete request.reasoning; delete request.thinking;
    Object.assign(request, params);
  }
}

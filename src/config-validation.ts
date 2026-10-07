// Validate the structural fields consumed by Hub and agent-sh before writing.
// Extension-owned fields remain open-ended and are preserved verbatim.
export function settingsValidationError(value: unknown): string | null {
  const record = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
  const strings = (v: unknown) => Array.isArray(v) && v.every(x => typeof x === "string");
  if (!record(value)) return "settings must be an object";
  for (const key of ["defaultProvider", "defaultBackend", "thinkingLevel", "toolMode"]) {
    if (value[key] != null && typeof value[key] !== "string") return `${key} must be a string`;
  }
  for (const key of ["skillPaths", "extensions", "coreTools", "disabledBuiltins", "disabledExtensions"]) {
    if (value[key] != null && !strings(value[key])) return `${key} must be an array of strings`;
  }
  if (value.providers === undefined) return null;
  if (!record(value.providers)) return "providers must be an object";
  for (const [name, provider] of Object.entries(value.providers)) {
    const at = `providers.${name}`;
    if (!name.trim() || !record(provider)) return `${at} must be an object`;
    for (const key of ["apiKey", "baseURL", "defaultModel", "reasoningShape"]) {
      if (provider[key] != null && typeof provider[key] !== "string") return `${at}.${key} must be a string`;
    }
    if (provider.contextWindow != null && !(typeof provider.contextWindow === "number" && Number.isFinite(provider.contextWindow) && provider.contextWindow > 0)) return `${at}.contextWindow must be a positive number`;
    if (provider.echoReasoningPatterns != null && !strings(provider.echoReasoningPatterns)) return `${at}.echoReasoningPatterns must be an array of strings`;
    if (provider.models == null) continue;
    if (!Array.isArray(provider.models)) return `${at}.models must be an array`;
    for (const [index, model] of provider.models.entries()) {
      const loc = `${at}.models[${index}]`;
      if (typeof model === "string" && model.trim()) continue;
      if (!record(model) || typeof model.id !== "string" || !model.id.trim()) return `${loc} must be a model id or an object with a nonempty id`;
      for (const key of ["contextWindow", "maxTokens"]) {
        if (model[key] != null && !(typeof model[key] === "number" && Number.isFinite(model[key]) && model[key] > 0)) return `${loc}.${key} must be a positive number`;
      }
      for (const key of ["reasoning", "echoReasoning"]) {
        if (model[key] != null && typeof model[key] !== "boolean") return `${loc}.${key} must be a boolean`;
      }
      if (model.modalities != null && !strings(model.modalities)) return `${loc}.modalities must be an array of strings`;
    }
  }
  return null;
}

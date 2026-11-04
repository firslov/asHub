export function catalog(payload) {
  if (!Array.isArray(payload?.data)) throw Error("Kimi 模型列表格式无效");
  const seen = new Set(),
    models = [];
  for (const m of payload.data) {
    if (
      !m ||
      typeof m.id !== "string" ||
      !m.id ||
      m.id.length > 200 ||
      seen.has(m.id) ||
      ["anthropic", "response"].includes(m.protocol) ||
      m.supports_tool_use === false
    )
      continue;
    const context = Number(m.limit?.context ?? m.context_length);
    if (!Number.isSafeInteger(context) || context <= 0) continue;
    const type = m.reasoning?.type ?? m.supports_thinking_type,
      valid = m.reasoning?.effort?.valid ?? m.think_efforts?.valid_efforts,
      efforts = Array.isArray(valid)
        ? valid.filter((v) => typeof v === "string" && /^[a-z]+$/.test(v))
        : [];
    seen.add(m.id);
    models.push({
      id: m.id,
      contextWindow: context,
      maxTokens:
        Number.isSafeInteger(m.limit?.output) && m.limit.output > 0
          ? m.limit.output
          : 32768,
      reasoning: type === "only" || type === "both",
      modalities: m.modalities?.input?.includes("image")
        ? ["text", "image"]
        : ["text"],
      thinkingType: type,
      efforts,
      defaultEffort: m.reasoning?.effort?.default,
    });
  }
  if (!models.length)
    throw Error("Kimi 未返回可用的 Chat Completions 编程模型");
  return models;
}
export function registration(models) {
  return models.map(({ thinkingType, efforts, defaultEffort, ...m }) => ({
    ...m,
    echoReasoning: true,
  }));
}
export function prepare(body, models, effort = "default") {
  if (!body || !Array.isArray(body.messages) || typeof body.model !== "string")
    throw Error("无效的模型请求");
  const model = models.find((m) => m.id === body.model);
  if (!model) throw Error("Kimi 模型不可用，请执行 /kimi-refresh");
  const out = { ...body };
  delete out.reasoning_effort;
  delete out.reasoning;
  delete out.thinking;
  if (effort !== "default") {
    if (effort === "off") {
      if (model.thinkingType !== "both")
        throw Error("该 Kimi 模型不支持关闭思考");
      out.thinking = { type: "disabled" };
    } else {
      if (!model.efforts.includes(effort))
        throw Error(`该 Kimi 模型不支持思考等级 ${effort}`);
      out.thinking = { type: "enabled", effort };
    }
  }
  const requested = out.max_completion_tokens ?? out.max_tokens;
  if (
    requested !== undefined &&
    (!Number.isSafeInteger(requested) || requested <= 0)
  )
    throw Error("无效的输出 token 上限");
  out.max_completion_tokens = Math.min(
    requested ?? model.maxTokens,
    model.maxTokens,
  );
  delete out.max_tokens;
  return out;
}

// Preserve the kernel's persisted vocabulary while displaying provider-native levels.
export const reasoningLevels = (provider) => provider === "deepseek"
  ? ["off", "low", "high", "xhigh"]
  : ["off", "low", "medium", "high", "xhigh"];

export const normalizeReasoning = (level, provider) => {
  if (level === "max") return "xhigh";
  return provider === "deepseek" && level === "medium" ? "high" : level;
};

export const reasoningLabel = (level, provider) => {
  const value = normalizeReasoning(level, provider);
  return provider === "deepseek" && value === "xhigh" ? "max" : value;
};

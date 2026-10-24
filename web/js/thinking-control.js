import { t } from "./i18n.js";

export const thinkingLabel = level => ({ default: t("model.thinking.default"), off: t("model.thinking.off"), none: t("model.thinking.off"), on: t("model.thinking.on") })[level] || level;
export const thinkingChoices = info => Array.isArray(info?.thinkingLevels) && info.thinkingLevels.length
  ? ["default", ...info.thinkingLevels] : [];

const isCurrentRequest = (session, seq, identity) => seq === session._thinkingRequestSeq
  && session.agentInfo.model === identity.model && session.agentInfo.provider === identity.provider;

function applyState(session, data, seq, identity) {
  if (!isCurrentRequest(session, seq, identity)) return false;
  if (data.model !== identity.model || data.provider !== identity.provider || typeof data.level !== "string"
    || !Array.isArray(data.levels) || !data.levels.every(v => typeof v === "string")) throw new Error("Invalid thinking capabilities");
  Object.assign(session.agentInfo, { thinkingLevel: data.level, thinkingLevels: data.levels,
    thinkingSupported: data.supported === true, thinkingDefault: data.defaultLevel });
  document.dispatchEvent(new CustomEvent("ash:thinking-changed", { detail: { session } }));
  return true;
}
export async function loadThinking(session) {
  // Reopening the picker must not supersede an in-flight selection with an
  // older GET response. The save completion refreshes all visible controls.
  if (session._thinkingPending) return false;
  const identity = { model: session.agentInfo.model, provider: session.agentInfo.provider };
  const seq = session._thinkingRequestSeq = (session._thinkingRequestSeq || 0) + 1;
  try {
    const res = await fetch(`/${session.id}/thinking`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return applyState(session, await res.json(), seq, identity);
  } catch (err) {
    // An obsolete failure is no more authoritative than an obsolete success.
    if (!isCurrentRequest(session, seq, identity)) return false;
    throw err;
  }
}
export async function saveThinking(session, level) {
  if (session._thinkingPending) return false;
  const identity = { model: session.agentInfo.model, provider: session.agentInfo.provider };
  if (!thinkingChoices(session.agentInfo).includes(level)) return false;
  const seq = session._thinkingRequestSeq = (session._thinkingRequestSeq || 0) + 1;
  session._thinkingPending = true;
  try {
    const res = await fetch(`/${session.id}/thinking`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ level, ...identity }) });
    if (!res.ok) throw new Error(await res.text() || `HTTP ${res.status}`);
    const applied = applyState(session, await res.json(), seq, identity);
    // Our own SSE acknowledgement can arrive before the POST response. It is
    // still a confirmed save, unless a later event changed the model or level.
    return applied || (session.agentInfo.model === identity.model && session.agentInfo.provider === identity.provider
      && session.agentInfo.thinkingLevel === level);
  } finally {
    session._thinkingPending = false;
    document.dispatchEvent(new CustomEvent("ash:thinking-changed", { detail: { session } }));
  }
}

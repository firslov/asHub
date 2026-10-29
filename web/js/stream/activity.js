import { t } from "../i18n.js";
import "../conversation-presentation.js";

const { toolActivityKey } = globalThis.AsHubConversationPresentation;

// Presentation only: every original node, result and event listener is retained.
// Explicit lifecycle hooks avoid observing or rescanning streaming log text.
const sessions = new WeakMap();
const records = new WeakMap();
const technical = (node) => ["tool-group", "thinking-block", "subagent-block", "reasoning-phase"]
  .some((name) => node.classList?.contains(name));

export function resetActivity(session) {
  sessions.set(session, { current: null, turn: new Set(), waiting: false, requestLabel: null });
}
export function disposeActivity(session) { sessions.delete(session); }

const toolLabel = (row) => toolActivityKey({ kind: row?.dataset.kind, name: row?.dataset.toolName });

const setText = (node, value) => { if (node.textContent !== value) node.textContent = value; };

function refresh(record) {
  const { box, body, label, changes, hint, arrow } = record;
  const rows = Array.from(body.querySelectorAll(".tool-row"));
  const pending = rows.filter((row) => !row.classList.contains("ok") && !row.classList.contains("err"));
  const delegated = body.querySelector(".subagent-spinner");
  const thinking = Array.from(body.querySelectorAll(".thinking-block"))
    .some((block) => block.dataset.activityDone !== "1");
  const running = !record.waiting && (!record.finished
    ? !record.sealed || pending.length > 0 || thinking || !!delegated
    : record.finished === "done" && !!delegated);
  box.dataset.state = record.waiting ? "waiting" : running ? "running" : "settled";
  // Failed attempts and child-task limits are diagnostic details, not the
  // outcome of the reply: the model may recover or use another approach.
  // Only a terminal error from the main agent warrants an outer warning.
  box.dataset.attention = record.finished === "error" ? "true" : "false";
  const key = record.waiting ? "activity.waiting" : running
    ? delegated ? "activity.delegating" : pending.length ? toolLabel(pending.at(-1)) : record.requestLabel || "activity.thinking"
    : record.finished === "stopped" ? "activity.stopped"
    : record.finished === "error" ? "activity.interrupted"
    : record.finished === "done" ? "activity.done"
    : pending.length || thinking ? "activity.ended" : "activity.done";
  setText(label, t(key));
  // Report only actual returned diffs, never infer successful edits from a tool name.
  const paths = new Set(Array.from(body.querySelectorAll(".diff-path"))
    .map((el) => el.textContent.trim()).filter(Boolean));
  changes.hidden = paths.size === 0;
  changes.textContent = paths.size ? t("activity.files", { n: paths.size }) : "";
  hint.textContent = t(body.hidden ? "activity.details" : "activity.hide");
  arrow.textContent = body.hidden ? "›" : "⌄";
}

export function refreshActivity(node) {
  const box = node?.closest?.(".execution-activity");
  const record = box && records.get(box);
  if (record) refresh(record);
}

export function setRequestActivity(session, key) {
  const state = sessions.get(session);
  if (!state) return false;
  state.requestLabel = key;
  const record = state.current;
  if (!record || record.finished || record.sealed) return false;
  record.requestLabel = key;
  refresh(record);
  return true;
}

// Called before normal stream insertion. Null means the node joined an
// existing disclosure; otherwise return the node/shell to insert in order.
export function prepareActivityNode(session, node, target) {
  const state = sessions.get(session);
  if (!state) return node;
  if (!technical(node)) {
    // Thinking dots are a transient idle indicator, not a content boundary.
    if (!node.classList?.contains("thinking") && state.current) {
      state.current.sealed = true;
      refresh(state.current);
      state.current = null;
    }
    return node;
  }
  // The real progress disclosure replaces the initial waiting placeholder.
  // Replay can leave that placeholder BEFORE replies, so sibling CSS cannot
  // reliably hide it after a session switch. Clear its ownership as well.
  if (session.thinking?.el) {
    session.thinking.el.remove();
    session.thinking.el = null;
  }
  let record = state.current;
  if (record && record.box.parentNode !== target) record = null;
  let newBox = null;
  if (!record) {
    const box = document.createElement("div");
    box.className = "execution-activity";
    const head = document.createElement("button");
    head.type = "button";
    head.className = "execution-activity-head";
    head.setAttribute("aria-expanded", "false");
    const dot = document.createElement("span");
    dot.className = "execution-activity-dot";
    dot.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.className = "execution-activity-label";
    label.setAttribute("role", "status");
    const changes = document.createElement("span");
    changes.className = "execution-activity-changes";
    const hint = document.createElement("span");
    hint.className = "execution-activity-hint";
    const arrow = document.createElement("span");
    arrow.className = "execution-activity-arrow";
    arrow.setAttribute("aria-hidden", "true");
    head.append(dot, label, changes, hint, arrow);
    const body = document.createElement("div");
    body.className = "execution-activity-body";
    body.hidden = true;
    box.append(head, body);
    record = { box, head, body, label, changes, hint, arrow, sealed: false, finished: "", waiting: state.waiting, requestLabel: state.requestLabel };
    records.set(box, record);
    state.current = record;
    state.turn.add(record);
    head.addEventListener("click", () => {
      body.hidden = !body.hidden;
      head.setAttribute("aria-expanded", String(!body.hidden));
      refresh(record);
    });
    newBox = box;
  }
  record.body.appendChild(node);
  refresh(record);
  return newBox;
}

export function activityEvent(session, name) {
  const state = sessions.get(session);
  if (!state) return;
  if (name === "agent:processing-start") {
    state.current = null;
    state.turn.clear();
    state.waiting = false;
    state.requestLabel = null;
    return;
  }
  if (name === "permission:request" || name === "permission:resolved" || name === "permission:request-cleanup") {
    const root = (session.state?.replaying && session._replayFrag) || session.streamEl;
    state.waiting = Array.from(root?.querySelectorAll(".permission-card") ?? [])
      .some((card) => !card.classList.contains("decided"));
    for (const record of state.turn) { record.waiting = state.waiting; refresh(record); }
    return;
  }
  const finished = { "agent:processing-done": "done", "agent:cancelled": "stopped", "agent:error": "error" }[name];
  if (!finished) return;
  for (const record of state.turn) {
    // Cleanup emits processing-done after cancellation/errors as well.
    // It ends the turn, but must not overwrite its terminal outcome.
    if (finished !== "done" || !["stopped", "error"].includes(record.finished)) {
      record.finished = finished;
    }
    record.waiting = false;
    record.requestLabel = null;
    refresh(record);
  }
  state.current = null;
  state.waiting = false;
  state.requestLabel = null;
}

document.addEventListener("langchange", () => {
  for (const box of document.querySelectorAll(".execution-activity")) {
    const record = records.get(box);
    if (record) refresh(record);
  }
});

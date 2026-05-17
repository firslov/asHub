import { escape } from "./utils.js";
import { currentSessionId, state } from "./state.js";
import { activeSession } from "./session-manager.js";
import { setComposerText } from "./composer.js";
import { t } from "./i18n.js";

const rewindToTurn = async (turn) => {
  const res = await fetch(`/${currentSessionId()}/context/rewind-to-turn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ turn }),
  });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(msg || t("rewind.failed", { status: res.status }));
  }
};

const rewindFromBox = async (box) => {
  if (state.isProcessing) return;
  const turn = Number(box.dataset.turn);
  if (!Number.isInteger(turn) || turn < 0) return;
  try {
    await rewindToTurn(turn);
  } catch (e) {
    alert(t("rewind.action.failed", { msg: e.message ?? e }));
    return;
  }
  setComposerText(box._queryText ?? "");
  activeSession.peek()?.resync();
};

export const createUserBox = (queryText) => {
  const box = document.createElement("div");
  box.className = "agent-box";
  box.innerHTML = `
    <div class="agent-box-head">
      <span class="abh-l">&gt;</span>
      <span class="abh-r">${t("you")}</span>
    </div>
    <div class="q-text">${escape(queryText)}</div>`;
  const actions = document.createElement("div");
  actions.className = "msg-actions";
  actions.innerHTML =
    `<button class="msg-action-btn" data-action="rewind" title="${t("rewind.here")}">↶</button>`;
  actions.querySelector('[data-action="rewind"]')?.addEventListener("click", () => rewindFromBox(box));
  box.appendChild(actions);
  box._queryText = queryText;
  return box;
};

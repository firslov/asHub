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
  activeSession.peek()?.resync({ force: true });
};

export const createUserBox = (queryText, images, ts) => {
  const box = document.createElement("div");
  box.className = "agent-box";
  let imagesHtml = "";
  if (images && images.length > 0) {
    imagesHtml = images.map((img) =>
      `<img class="agent-box-img" src="data:${img.mimeType};base64,${img.data}" alt="attached image">`
    ).join("");
  }
  const timestamp = typeof ts === "number" ? ts : Date.now();
  box._ts = timestamp;
  const dateStr = new Date(timestamp).toLocaleString([], {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
  box.innerHTML = `
    <div class="agent-box-head">
      <span class="abh-l">&gt;</span>
      <span class="abh-r">${t("you")}</span>
    </div>
    ${imagesHtml}
    <span class="msg-time">${dateStr}</span>
    <div class="q-text">${escape(queryText)}</div>`;
  const actions = document.createElement("div");
  actions.className = "msg-actions";
  actions.innerHTML =
    `<button class="msg-action-btn" data-action="rewind" title="${t("rewind.here")}">↶</button>`;
  actions.querySelector('[data-action="rewind"]')?.addEventListener("click", () => rewindFromBox(box));
  box.appendChild(actions);
  box._queryText = queryText;
  // Image lightbox
  box.querySelectorAll(".agent-box-img").forEach((img) => {
    img.addEventListener("click", () => {
      const overlay = document.createElement("div");
      overlay.className = "img-lightbox";
      const full = document.createElement("img");
      full.src = img.src;
      overlay.appendChild(full);
      overlay.addEventListener("click", () => overlay.remove());
      document.body.appendChild(overlay);
    });
  });
  return box;
};

// Refresh timestamps when language changes
document.addEventListener("langchange", () => {
  document.querySelectorAll(".msg-time").forEach((el) => {
    const box = el.closest(".agent-box");
    if (box?._ts) {
      el.textContent = new Date(box._ts).toLocaleString([], {
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit",
      });
    }
  });
});

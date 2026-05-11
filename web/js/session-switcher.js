import {
  sessionId, setSessionId, parseSessionId, state, resetSessionState,
} from "./state.js";
import { connectSse, disconnectSse } from "./sse.js";
import { resetReplyState } from "./stream/reply.js";
import { resetToolGroupState } from "./stream/tool-group.js";
import { resetThinkingState } from "./stream/thinking.js";
import { resetLiveOutputState } from "./stream/live-output.js";

const stream = document.getElementById("stream");
const conn = document.getElementById("conn");
const dot = document.querySelector(".live-dot");
const sessionList = document.getElementById("sessions");

const updateSidebarHighlight = (id) => {
  if (!sessionList) return;
  for (const li of sessionList.querySelectorAll("li.current")) {
    li.classList.remove("current");
  }
  for (const li of sessionList.querySelectorAll("li")) {
    const a = li.querySelector("a");
    if (a?.getAttribute("href") === `/${id}/`) {
      li.classList.add("current");
      break;
    }
  }
};

const clearStreamContent = () => {
  const empty = document.getElementById("stream-empty");
  for (const child of Array.from(stream.children)) {
    if (child === empty) continue;
    child.remove();
  }
  if (empty) empty.hidden = false;
};

const resetStreamModules = () => {
  resetReplyState();
  resetToolGroupState();
  resetThinkingState();
  resetLiveOutputState();
};

export const switchTo = (newId, { push = true } = {}) => {
  if (!newId) return;
  if (newId === sessionId) return;

  disconnectSse();
  resetStreamModules();
  resetSessionState();
  clearStreamContent();

  if (push) {
    history.pushState({ sessionId: newId }, "", `/${newId}/`);
  }
  setSessionId(newId);

  if (conn) conn.textContent = "";
  if (dot) dot.classList.remove("stale");

  updateSidebarHighlight(newId);
  connectSse();
};

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);

document.addEventListener("keydown", (ev) => {
  const primary = IS_MAC ? ev.metaKey : ev.ctrlKey;
  const other = IS_MAC ? ev.ctrlKey : ev.metaKey;
  if (!primary || other || ev.shiftKey || ev.altKey) return;
  if (ev.key < "1" || ev.key > "9") return;
  const links = sessionList?.querySelectorAll("li a") ?? [];
  const a = links[parseInt(ev.key, 10) - 1];
  if (!a) return;
  const m = a.getAttribute("href")?.match(/^\/([0-9a-f]+)\/?$/);
  if (!m) return;
  ev.preventDefault();
  switchTo(m[1]);
});

window.addEventListener("popstate", (ev) => {
  const id = ev.state?.sessionId ?? parseSessionId(location.pathname);
  if (!id) return;
  if (id === sessionId) return;
  switchTo(id, { push: false });
});

if (sessionId && !history.state?.sessionId) {
  history.replaceState({ sessionId }, "", location.pathname);
}

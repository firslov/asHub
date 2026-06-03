import { pauseSSE, resumeSSE } from "./session-manager.js";

let _paused = false;
let _resumeTimer = null;

const pause = () => {
  if (_paused) return;
  _paused = true;

  // Close SSE connections so the server doesn't accumulate stale
  // connections during prolonged sleep.
  pauseSSE();
};

const resume = () => {
  if (!_paused) return;
  _paused = false;

  // Stagger reconnect: 1–3 seconds of jitter prevents connection
  // storms when the system wakes.
  if (_resumeTimer) clearTimeout(_resumeTimer);
  _resumeTimer = setTimeout(() => {
    _resumeTimer = null;
    resumeSSE();
  }, 1000 + Math.random() * 2000);
};

// Browser tab visibility changes (also covers system sleep on some OS).
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    pause();
  } else {
    resume();
  }
});

// Back/forward cache restore — reconnect SSE if paused.
window.addEventListener("pageshow", (ev) => {
  if (ev.persisted && _paused) resume();
});

window.addEventListener("pagehide", () => {
  pause();
});

// Electron main process suspend/resume signals.
if (window.electronAPI?.onSuspend) {
  window.electronAPI.onSuspend(() => pause());
  window.electronAPI.onResume(() => resume());
}

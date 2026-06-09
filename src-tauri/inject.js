// Injected into the asHub WebView before page scripts run.
// Bridges the Electron `window.electronAPI` surface the web UI expects onto
// Tauri, and works around WKWebView lacking `-webkit-app-region: drag`.
(function () {
  function applyChrome() {
    var tb = document.querySelector(".title-bar");
    if (!tb) return;
    // WKWebView ignores `-webkit-app-region: drag`; Tauri drags elements
    // carrying this attribute instead.
    tb.setAttribute("data-tauri-drag-region", "");
    // Inset content past the overlaid macOS traffic lights (matches Electron).
    tb.style.paddingLeft = "80px";
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", applyChrome);
  } else {
    applyChrome();
  }
  window.addEventListener("load", applyChrome);

  var BLOCKED = ["javascript:", "file:", "data:", "vbscript:"];
  window.electronAPI = {
    openExternal: function (url) {
      try {
        if (BLOCKED.indexOf(new URL(url).protocol) !== -1) return Promise.resolve();
      } catch (e) {
        return Promise.resolve();
      }
      return window.__TAURI__.core.invoke("plugin:opener|open_url", { url: url });
    },
  };
})();

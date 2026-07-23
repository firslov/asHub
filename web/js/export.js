// Export the active conversation as a Markdown file download.
// Loaded as its own module from index.html — client.js is not involved.

import { currentSessionId } from "./state.js";
import { activeSessionId } from "./session-manager.js";
import { effect } from "../vendor/signals-core.js";
import { t } from "./i18n.js";
import { toast } from "./toast.js";

const exportBtn = document.getElementById("export-btn");

// Disabled while no session is active.
effect(() => {
  if (exportBtn) exportBtn.disabled = !activeSessionId.value;
});

const stripContextWrappers = (s) => {
  let out = String(s ?? "");
  for (;;) {
    const next = out.replace(/^\s*<(query_context|dynamic_context)>[\s\S]*?<\/\1>\s*/, "");
    if (next === out) return out;
    out = next;
  }
};

const textOf = (m) => {
  if (typeof m?.content === "string") return m.content;
  if (Array.isArray(m?.content)) {
    return m.content
      .map((p) => (typeof p === "string" ? p : p?.text ?? p?.content ?? ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
};

// One-line summary for a tool call, e.g. `[tool: read src/app.ts]`.
const toolSummary = (tc) => {
  const fn = tc?.function ?? {};
  const name = fn.name ?? t("tool");
  let arg = "";
  try {
    const parsed = typeof fn.arguments === "string" ? JSON.parse(fn.arguments) : fn.arguments;
    if (parsed && typeof parsed === "object") {
      arg = parsed.path ?? parsed.file_path ?? parsed.command ?? parsed.query ?? parsed.pattern ?? "";
    }
  } catch {}
  return `[tool: ${name}${arg ? " " + arg : ""}]`;
};

const quoteBlock = (text) =>
  text.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n");

const toMarkdown = (meta, msgs) => {
  const lines = [`# ${meta.title}`, ""];
  lines.push(`- session: ${meta.id}`);
  if (meta.cwd) lines.push(`- cwd: ${meta.cwd}`);
  lines.push(`- exported: ${new Date().toISOString()}`, "");
  for (const m of msgs) {
    const role = String(m?.role ?? "");
    if (role === "system") continue;
    if (role === "user") {
      const text = stripContextWrappers(textOf(m)).trim();
      if (!text) continue;
      lines.push(quoteBlock(text), "");
    } else if (role === "assistant") {
      const text = textOf(m).trim();
      if (text) lines.push(text, "");
      for (const tc of m?.tool_calls ?? []) lines.push(toolSummary(tc), "");
    } else if (role === "tool") {
      lines.push(`[tool: ${m?.name ?? t("tool")}]`, "");
    }
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
};

const fileNameFor = (title, id) => {
  const base = (title || "conversation")
    .replace(/[\\/:*?"<>|]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60) || "conversation";
  return `${base}-${id}.md`;
};

const download = (name, text) => {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

exportBtn?.addEventListener("click", async () => {
  const sid = currentSessionId();
  if (!sid) {
    toast(t("export.no.session"), { type: "info" });
    return;
  }
  exportBtn.disabled = true;
  try {
    const [ctxRes, sessRes] = await Promise.all([fetch(`/${sid}/context`), fetch("/sessions")]);
    if (!ctxRes.ok) throw new Error(await ctxRes.text());
    const data = await ctxRes.json();
    const msgs = Array.isArray(data.messages) ? data.messages : [];
    let meta = { id: sid, title: t("untitled"), cwd: "" };
    if (sessRes.ok) {
      const list = await sessRes.json();
      const s = Array.isArray(list) ? list.find((x) => x.instanceId === sid) : null;
      if (s) {
        // Terminal sessions have no conversation messages — nothing to export.
        if (s.kind === "terminal" || s.kind === "ash-terminal") {
          toast(t("export.terminal"), { type: "info" });
          return;
        }
        const hasTitle = s.title && s.title !== s.instanceId;
        meta = { id: sid, title: hasTitle ? s.title : t("untitled"), cwd: s.cwd ?? "" };
      }
    }
    download(fileNameFor(meta.title, sid), toMarkdown(meta, msgs));
  } catch (e) {
    toast(t("export.failed"), { type: "error", detail: String(e?.message ?? e) });
  } finally {
    exportBtn.disabled = !activeSessionId.peek();
  }
});

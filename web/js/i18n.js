const LS_LANG = "ash.lang";

const translations = {
  en: {
    // ── HTML static strings ────────────────────────────────────────
    "sessions": "Sessions",
    "new.session": "New session",
    "collapse.sidebar": "Collapse sidebar",
    "working.dir": "Working directory path",
    "connecting": "connecting…",
    "checking.updates": "checking for updates…",
    "interrupt": "Interrupt response (Esc)",
    "ready": "ready when you are.",
    "ready.sub": "ask anything — the agent can explore files, run commands, <em>reason</em>, and edit code.",
    "start.typing": "start typing below…",
    "shortcuts": "<kbd>⌘K</kbd> focus · <kbd>↑</kbd> recall · <kbd>Esc</kbd> cancel · <kbd>⌘\\</kbd> context",
    "new.output": "new output",
    "ask.agent": "ask the agent…",
    "context": "Context",
    "refresh": "Refresh",
    "close": "Close",
    "ctx.all": "all",
    "ctx.system": "system",
    "ctx.user": "user",
    "ctx.assistant": "assistant",
    "ctx.tool": "tool",
    "drop": "drop",
    "files": "Files",
    "loading": "loading…",
    "browse.files": "Browse files",
    "inspect.context": "Inspect context",
    "settings": "Settings",
    "toggle.theme": "Toggle theme",
    "toggle.lang": "Switch language",
    "simple": "Simple",
    "advanced": "Advanced",
    "reset.defaults": "Reset to defaults",
    "provider": "Provider",
    "api.key": "API Key",
    "provider.desc.deepseek": "DeepSeek V4 models with 1M context window",
    "provider.desc.zhipu": "GLM models with 200K context window",
    "provider.desc.openrouter": "Aggregator — pick any model in the OpenRouter catalog",
    "model": "Model",
    "model.hint": "Type to search the OpenRouter catalog",
    "model.loading": "Loading models…",
    "model.load.failed": "Couldn't load models — using cached/manual entry",
    "apikey.hint": "Your API key is stored locally in ~/.agent-sh/settings.json",
    "save.reload": "save & reload",
    "valid.json": "✓ valid json",
    "invalid.json": "✗ invalid json",
    "format": "format",
    "show.hide.apikey": "Show/hide API key",

    // ── Quick Prompts ──────────────────────────────────────────────
    "quick.prompts": "Quick Prompts",
    "prompts.add.prompt": "add prompt",
    "prompts.add": "add",
    "prompts.save": "save",
    "prompts.edit": "Edit",
    "prompts.delete": "Delete",
    "prompts.empty": "No quick prompts yet — add one below.",
    "prompts.name.placeholder": "Prompt name (shown in list)",
    "prompts.content.placeholder": "Prompt content (inserted on #Tab)",

    // ── Sidebar ────────────────────────────────────────────────────
    "edit.title": "edit title",
    "close.session": "close session",
    "close.session.confirm": "Close session {title}?",

    // ── Actions / user box ─────────────────────────────────────────
    "you": "you",
    "edit.message": "Edit message",
    "regen.response": "Regenerate response",
    "delete.turn": "Delete turn",
    "save": "Save (Enter)",
    "cancel": "Cancel (Esc)",
    "delete.turn.confirm": "Delete this turn and everything after it?",
    "delete.failed": "Delete failed: {msg}",
    "rewind.failed": "rewind failed ({status})",
    "regen.failed": "Regenerate failed: {msg}",
    "regen.resubmit.failed": "Regenerate: message resubmit failed.\n{msg}",
    "edit.failed": "Edit failed: {msg}",
    "edit.resubmit.failed": "Edit: message resubmit failed.\n{msg}",

    // ── Composer / SSE connection ──────────────────────────────────
    "reconnecting": "reconnecting…",
    "no.session": "no session — click + to create",

    // ── Renderers: errors, diffs, tools ────────────────────────────
    "error": "Error",
    "show.details": "show details",
    "hide.details": "hide details",
    "wrap": "wrap",
    "copy": "copy",
    "copied": "copied",
    "show.less": "show less",
    "show.n.more": "show {n} more",
    "tool": "tool",
    "click.expand.cmd": "click to expand command",
    "click.collapse.cmd": "click to collapse command",
    "shell.failed": "shell command failed (exit {code})",
    "command.failed": "command failed",
    "usage.input": "input tokens",
    "usage.output": "output tokens",
    "usage.total": "total tokens",
    "usage.context": "context usage",
    "diff.toggle.wrap": "toggle wrap",
    "diff.copy.patch": "copy patch",
    "usage.cache": "cache hit / miss",

    // ── Thinking ───────────────────────────────────────────────────
    "thinking": "thinking…",
    "thought": "thought",

    // ── Tool group ─────────────────────────────────────────────────
    "n.tools": "{n} tools",

    // ── Reply ──────────────────────────────────────────────────────
    "cancelled": "cancelled",

    // ── Context panel ──────────────────────────────────────────────
    "ctx.no.session": "no session",
    "ctx.loading": "loading…",
    "ctx.n.msgs": "{n} msgs",
    "ctx.empty": "empty",
    "ctx.drop.n": "drop {n}",
    "ctx.expand": "▾ expand",
    "ctx.collapse": "▴ collapse",
    "ctx.drop.failed": "drop failed: {msg}",

    // ── Files panel ────────────────────────────────────────────────
    "files.no.session": "no session",
    "files.no.session.hint": "create a session from the sidebar to browse files",
    "files.loading": "loading…",
    "files.empty.dir": "empty directory",
    "files.no.files": "no files",
    "files.empty.hint": "the working directory is empty or contains only hidden files",
    "files.failed": "failed to load",
    "files.failed.hint": "check that the working directory exists",
    "files.dblclick.hint": "double-click to insert \"{name}\"",

    // ── Config panel ───────────────────────────────────────────────
    "config.save.failed": "save failed: {msg}",

    // ── Compact / reasoning ────────────────────────────────────────
    "n.reasoning.rounds": "{n} reasoning rounds",
    "n.tools.compact": "{n} tools",

    // ── Version ────────────────────────────────────────────────────
    "version.available": "v{ver} available",
    "version.update.hint": "Update to v{ver} — click to download",
  },

  zh: {
    // ── HTML static strings ────────────────────────────────────────
    "sessions": "会话列表",
    "new.session": "新建会话",
    "collapse.sidebar": "折叠侧边栏",
    "working.dir": "工作目录路径",
    "connecting": "连接中…",
    "checking.updates": "检查更新中…",
    "interrupt": "中断响应 (Esc)",
    "ready": "准备好了。",
    "ready.sub": "随便问 — agent 可以浏览文件、运行命令、<em>推理</em>和编辑代码。",
    "start.typing": "在下方开始输入…",
    "shortcuts": "<kbd>⌘K</kbd> 聚焦 · <kbd>↑</kbd> 回溯 · <kbd>Esc</kbd> 取消 · <kbd>⌘\\</kbd> 上下文",
    "new.output": "新输出",
    "ask.agent": "向 agent 提问…",
    "context": "上下文",
    "refresh": "刷新",
    "close": "关闭",
    "ctx.all": "全部",
    "ctx.system": "系统",
    "ctx.user": "用户",
    "ctx.assistant": "助手",
    "ctx.tool": "工具",
    "drop": "删除",
    "files": "文件",
    "loading": "加载中…",
    "browse.files": "浏览文件",
    "inspect.context": "检查上下文",
    "settings": "设置",
    "toggle.theme": "切换主题",
    "toggle.lang": "切换语言",
    "simple": "简单",
    "advanced": "高级",
    "reset.defaults": "恢复默认",
    "provider": "提供商",
    "api.key": "API 密钥",
    "provider.desc.deepseek": "DeepSeek V4 模型，1M 上下文窗口",
    "provider.desc.zhipu": "GLM 模型，200K 上下文窗口",
    "provider.desc.openrouter": "聚合服务 — 可选 OpenRouter 目录中的任意模型",
    "model": "模型",
    "model.hint": "输入以搜索 OpenRouter 目录",
    "model.loading": "加载模型中…",
    "model.load.failed": "加载失败 — 使用缓存或手动输入",
    "apikey.hint": "API 密钥存储在本地 ~/.agent-sh/settings.json",
    "save.reload": "保存并重载",
    "valid.json": "✓ JSON 有效",
    "invalid.json": "✗ JSON 无效",
    "format": "格式化",
    "show.hide.apikey": "显示/隐藏 API 密钥",

    // ── Quick Prompts ──────────────────────────────────────────────
    "quick.prompts": "快捷提示词",
    "prompts.add.prompt": "添加提示词",
    "prompts.add": "添加",
    "prompts.save": "保存",
    "prompts.edit": "编辑",
    "prompts.delete": "删除",
    "prompts.empty": "还没有快捷提示词 — 在下方添加一个吧。",
    "prompts.name.placeholder": "提示词名称（列表中显示）",
    "prompts.content.placeholder": "提示词内容（输入 #Tab 时插入）",

    // ── Sidebar ────────────────────────────────────────────────────
    "edit.title": "编辑标题",
    "close.session": "关闭会话",
    "close.session.confirm": "关闭会话 {title}？",

    // ── Actions / user box ─────────────────────────────────────────
    "you": "你",
    "edit.message": "编辑消息",
    "regen.response": "重新生成",
    "delete.turn": "删除轮次",
    "save": "保存 (Enter)",
    "cancel": "取消 (Esc)",
    "delete.turn.confirm": "删除此轮次及之后的所有内容？",
    "delete.failed": "删除失败：{msg}",
    "rewind.failed": "回退失败 ({status})",
    "regen.failed": "重新生成失败：{msg}",
    "regen.resubmit.failed": "重新生成：消息重新提交失败。\n{msg}",
    "edit.failed": "编辑失败：{msg}",
    "edit.resubmit.failed": "编辑：消息重新提交失败。\n{msg}",

    // ── Composer / SSE connection ──────────────────────────────────
    "reconnecting": "重连中…",
    "no.session": "无会话 — 点击 + 创建",

    // ── Renderers: errors, diffs, tools ────────────────────────────
    "error": "错误",
    "show.details": "显示详情",
    "hide.details": "隐藏详情",
    "wrap": "换行",
    "copy": "复制",
    "copied": "已复制",
    "show.less": "收起",
    "show.n.more": "展开 {n} 条",
    "tool": "工具",
    "click.expand.cmd": "点击展开命令",
    "click.collapse.cmd": "点击收起命令",
    "shell.failed": "Shell 命令失败 (exit {code})",
    "command.failed": "命令执行失败",
    "usage.input": "输入 tokens",
    "usage.output": "输出 tokens",
    "usage.total": "总计 tokens",
    "usage.context": "上下文用量",
    "diff.toggle.wrap": "切换换行",
    "diff.copy.patch": "复制补丁",
    "usage.cache": "缓存命中 / 未命中",

    // ── Thinking ───────────────────────────────────────────────────
    "thinking": "思考中…",
    "thought": "已思考",

    // ── Tool group ─────────────────────────────────────────────────
    "n.tools": "{n} 个工具",

    // ── Reply ──────────────────────────────────────────────────────
    "cancelled": "已取消",

    // ── Context panel ──────────────────────────────────────────────
    "ctx.no.session": "无会话",
    "ctx.loading": "加载中…",
    "ctx.n.msgs": "{n} 条消息",
    "ctx.empty": "空",
    "ctx.drop.n": "删除 {n} 条",
    "ctx.expand": "▾ 展开",
    "ctx.collapse": "▴ 收起",
    "ctx.drop.failed": "删除失败：{msg}",

    // ── Files panel ────────────────────────────────────────────────
    "files.no.session": "无会话",
    "files.no.session.hint": "从侧边栏创建会话以浏览文件",
    "files.loading": "加载中…",
    "files.empty.dir": "空目录",
    "files.no.files": "无文件",
    "files.empty.hint": "工作目录为空或仅包含隐藏文件",
    "files.failed": "加载失败",
    "files.failed.hint": "请检查工作目录是否存在",
    "files.dblclick.hint": "双击插入 \"{name}\"",

    // ── Config panel ───────────────────────────────────────────────
    "config.save.failed": "保存失败：{msg}",

    // ── Compact / reasoning ────────────────────────────────────────
    "n.reasoning.rounds": "{n} 轮推理",
    "n.tools.compact": "{n} 个工具",

    // ── Version ────────────────────────────────────────────────────
    "version.available": "v{ver} 可用",
    "version.update.hint": "更新到 v{ver} — 点击下载",
  },
};

let currentLang = "en";

/**
 * Translate a key with optional substitutions.
 * Usage: t("key") or t("key", { n: 5, msg: "error" })
 */
export const t = (key, subs) => {
  const map = translations[currentLang] ?? translations.en;
  let text = map[key];
  if (text === undefined) {
    // Fall back to English
    text = (translations.en ?? {})[key];
    if (text === undefined) return key;
  }
  if (subs) {
    for (const [k, v] of Object.entries(subs)) {
      text = text.replaceAll(`{${k}}`, String(v ?? ""));
    }
  }
  return text;
};

/**
 * Get the current language code.
 */
export const lang = () => currentLang;

/**
 * Set language and re-scan the DOM for data-i18n attributes.
 */
export const setLang = (code) => {
  if (!translations[code]) return;
  currentLang = code;
  document.documentElement.setAttribute("lang", code === "zh" ? "zh-CN" : "en");
  try { localStorage.setItem(LS_LANG, code); } catch {}
  scanI18n();
  // Notify other modules so they can refresh dynamically-managed text
  document.dispatchEvent(new CustomEvent("langchange", { detail: { lang: code } }));
};

/**
 * Walk the DOM and update every element with `data-i18n` or `data-i18n-*`.
 *
 * Supported attributes:
 *   data-i18n            → element.textContent
 *   data-i18n-title      → element.title
 *   data-i18n-placeholder→ element.placeholder
 *   data-i18n-html       → element.innerHTML (use sparingly)
 *   data-i18n-label      → element.textContent (for <label>, etc.)
 */
export const scanI18n = (root = document) => {
  // textContent
  root.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    if (key) el.textContent = t(key);
  });
  // title
  root.querySelectorAll("[data-i18n-title]").forEach((el) => {
    const key = el.getAttribute("data-i18n-title");
    if (key) el.title = t(key);
  });
  // placeholder
  root.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    const key = el.getAttribute("data-i18n-placeholder");
    if (key) el.placeholder = t(key);
  });
  // innerHTML
  root.querySelectorAll("[data-i18n-html]").forEach((el) => {
    const key = el.getAttribute("data-i18n-html");
    if (key) el.innerHTML = t(key);
  });
  // label (same as textContent but separate attribute to avoid conflicts)
  root.querySelectorAll("[data-i18n-label]").forEach((el) => {
    const key = el.getAttribute("data-i18n-label");
    if (key) el.textContent = t(key);
  });
};

// ── Init ───────────────────────────────────────────────────────────
try {
  const stored = localStorage.getItem(LS_LANG);
  if (stored && translations[stored]) currentLang = stored;
} catch {}

// Apply lang attribute on load
document.documentElement.setAttribute("lang", currentLang === "zh" ? "zh-CN" : "en");

// Scan on DOM ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => scanI18n());
} else {
  scanI18n();
}

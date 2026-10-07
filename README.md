# asHub

[English](#ashub) | [简体中文](README_CN.md)

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.12.0-brightgreen.svg)](package.json)

Desktop app for [agent-sh](https://github.com/guanyilun/agent-sh) — it spawns and supervises
agent-sh sessions and exposes them through a browser UI on a single port.

![asHub](pic/asHub_0.min.png)

The desktop window and a plain browser are the *same* client: the Electron app embeds the hub
described below, so opening `http://localhost:7878` in any browser shows exactly what the
window shows.

## Features

- **Multi-session** — sidebar to spawn, switch, search, pin, archive, and close sessions
- **Workspaces** — sessions grouped by working directory, with terminals and the archive in their own views
- **Terminal sessions** — real PTY shells side by side with agent sessions, tabbed like them
- **Session persistence** — conversations survive restarts
- **Auto-title** — LLM-generated session titles with plain-text fallback
- **Live streaming** — SSE with Markdown, syntax-highlighted code, diff views, and tool calls
- **Reasoning compaction** — consecutive think→tool rounds auto-collapse into a single expandable block
- **Todo list** — agent-managed task tracking, rendered as a progress card pinned atop the stream
- **Subagents** — five specialists (plan / explore / review / research / implement) with permission gating, cancellation, concurrency limits, per-type model overrides, and budgets
- **Branch tree** — rewind and fork through conversation history; non-destructive time travel with a visual tree panel
- **Permission gate** — file-modification approvals with countdown, full-diff preview, and a session-wide option
- **Export** — one-click export of any conversation to Markdown
- **Skills marketplace** — browse and install skills from GitHub or Gitee
- **Extensions** — user extensions load from `~/.agent-sh/extensions`; see [`examples/extensions`](examples/extensions)
- **System notifications** — get notified when approvals are requested or replies finish in the background
- **Image support** — paste/upload images for multimodal models with automatic compression and Blob URL rendering
- **Model picker** — searchable dropdown with a live OpenRouter catalog (300+ models) grouped by provider
- **Vision indicator** — icon in the input bar shows when the active model supports images
- **Collapsible status bar** — toggle to hide/show model, cache, and balance info
- **Cache hit ratio** — circular progress ring showing prompt cache efficiency
- **Provider balance** — per-session balance for DeepSeek and OpenRouter
- **Hot reload** — apiKey and provider config changes take effect immediately, no restart needed
- **Streaming perf** — block-level incremental rendering, debounced highlighting, SPA DOM cache
- **Sleep resilience** — SSE and rendering auto-pause on system sleep
- **Auto-update** — in-app updater served from the mirror, falling back to GitHub
- **Bilingual UI** — English and 简体中文, plus a display-scale setting
- **Cross-platform** — packaged for macOS (Apple Silicon and Intel), Windows (x64), and Linux (AppImage)

## How it works

`src/hub.ts` is the core: a **bridge-agnostic** HTTP + SSE server that spawns and supervises one
*bridge* per session. Whatever runs the conversation just has to emit `BusEvent`s and implement
`submit` / `cancel` / `close` — see [`src/bridges/types.ts`](src/bridges/types.ts).

```
Electron shell (electron/main.cjs)          browser (any modern browser)
        │                                             │
        └──────────────► hub (src/hub.ts) ◄───────────┘
                     one HTTP port, path routing /<id>/events, /<id>/submit
                                 │
        ┌────────────────────────┼────────────────────────┐
        ▼                        ▼                        ▼
   AshBridge               AcpBridge               TerminalBridge
   agent-sh kernel         child process           PTY shell
   in-process              speaking ACP            (node-pty)
```

| Bridge | Runs | Selected by |
|---|---|---|
| `AshBridge` | agent-sh's kernel in-process — no subprocess, one less hop | default (`--backend ash`) |
| `AcpBridge` | a child process speaking ACP, e.g. `agent-sh-acp` or `claude-code-acp` | `--backend acp [--cmd "CMD ARGS"]` |
| `TerminalBridge` | a PTY shell session (agent-sh's shell or a plain terminal) | session kind `terminal` |

Adding a backend therefore means implementing one interface; the hub, the SSE protocol, and the
web client stay untouched.

## Install

### macOS (Apple Silicon and Intel)

One-line install, no Gatekeeper prompt:

```sh
curl -fsSL https://raw.githubusercontent.com/firslov/ashub/main/install.sh | bash
```

Installs to `/Applications` and clears the quarantine flag. `install.sh` detects `arm64` vs
`x86_64` and fetches the matching build.

<details>
<summary>Prefer the .dmg?</summary>

Download from [Releases](https://github.com/firslov/ashub/releases), drag to Applications, then:

- run `/usr/bin/xattr -dr com.apple.quarantine "/Applications/asHub.app"`, **or**
- launch once, then open **System Settings → Privacy & Security**, scroll to the bottom and click **Open Anyway**.

</details>

### Windows

Download the installer from [Releases](https://github.com/firslov/ashub/releases).
Terminal sessions use the system shell (`%COMSPEC%`, or PowerShell).

### Linux

Download the AppImage from [Releases](https://github.com/firslov/ashub/releases).

Downloads are also served by the project's own mirror (see [Downloads and mirror](#downloads-and-mirror)),
which is what the one-line installer and the in-app updater use by default.

## Run from source

Requires **Node.js ≥ 22.12.0** (the build tooling requires this minimum).
The project pins **Node.js 22.23.3** in `.nvmrc` and `.node-version`; with nvm,
run `nvm install && nvm use` before installing dependencies.

```sh
git clone https://github.com/firslov/ashub.git
cd ashub
npm install
```

**Electron** (desktop app):

```sh
npm run electron:dev
```

**Headless** (CLI server, no window):

```sh
npm start -- --port 8080
```

**Browser** (use any modern browser as the UI):

```sh
npm start -- --host 0.0.0.0 --port 7878
# then open http://localhost:7878
```

> Bind `0.0.0.0` to allow access from other devices on your network.
> Use `127.0.0.1` (default) for local-only access.

**Build** a distributable package:

```sh
npm run electron:dist:mac   # macOS .dmg (arm64 + x64)
npm run electron:dist:win   # Windows .exe (NSIS)
```

## Command line

These flags apply to `ashub` / `npm start`. The Electron app starts the same hub in-process with
its defaults.

| Flag | Default | Description |
|---|---|---|
| `--backend ash\|acp` | `ash` | Bridge implementation: in-process agent-sh kernel, or an ACP subprocess |
| `--cmd "CMD ARGS"` | `agent-sh-acp` | Spawn command for `--backend acp` (double quotes are honoured) |
| `--port N` | `7878` | HTTP port |
| `--host HOST` | `127.0.0.1` | Bind address |
| `--web PATH` | `./web` | Static web root |
| `--model NAME` | settings default | Model override (ash backend) |
| `--provider NAME` | settings default | Provider override (ash backend) |
| `-h`, `--help` | — | Show usage |

```sh
# in-process kernel (default)
ashub --port 8080

# spawn Claude Code's ACP server instead
ashub --backend acp --cmd "claude-code-acp"
```

## HTTP API

The web client talks to the hub over plain HTTP — the same API is available to scripts.
Session-scoped routes are prefixed with the `instanceId` returned by `POST /sessions`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/sessions` | Live sessions as JSON (cwd, title, kind, model, state) |
| `POST` | `/sessions` | Spawn a session — `{ cwd?, kind? }` → `{ instanceId, cwd, kind }` |
| `DELETE` | `/<id>/` | Close a session |
| `GET` | `/<id>/` | The session's web UI |
| `GET` | `/<id>/events` | SSE stream (messages, tools, todos, permissions, PTY output) |
| `POST` | `/<id>/submit` | Submit a query — `{ query }` |
| `POST` | `/<id>/cancel` | Cancel the running turn |
| `POST` | `/<id>/pty-input`, `/<id>/pty-resize` | Terminal session I/O |
| `GET`/`POST` | `/<id>/context`, `/context/rewind`, `/context/drop` | Inspect and rewind context |
| `GET`/`POST` | `/<id>/tree`, `/<id>/fork` | Branch tree and non-destructive forks |
| `GET`/`PUT` | `/<id>/model`, `/sa-model`, `/sa-budget`, `/sa-types` | Model and subagent settings |
| `POST` | `/api/permission/decide` | Answer a permission prompt |
| `POST` | `/api/upload`, `GET /api/uploads/<id>` | Image attachments |
| `GET` | `/api/models`, `/api/balance`, `/api/version` | Model catalog, provider balance, version |
| `GET`/`PUT`/`POST` | `/api/config`, `/api/config/reload`, `/api/settings/auto-approve` | Settings |
| `GET`/`POST` | `/api/skills`, `/api/skills/install`, `/api/skills/uninstall` | Skills marketplace |
| `GET` | `/fs`, `/<id>/files`, `/pick-dir` | File browsing for the UI |

## Project layout

```
src/
  cli.ts              entry point: flags, bridge factory, hub startup
  hub.ts              the single-port HTTP/SSE server: sessions, routing, permissions, uploads
  bridges/
    types.ts          the Bridge interface every backend implements
    ash.ts            in-process agent-sh kernel
    acp.ts            ACP subprocess + translator
    terminal.ts       PTY shell sessions
  history/            session store, frame capture, summarisation, compaction strategy
web/                  the client: plain ES modules, no build step (index.html + js/ + css/)
  js/stream/          per-block renderers (thinking, tools, todos, replies, live output)
electron/             desktop shell: window, menu, IPC, auto-update, tsx loader for extensions
mirror/               download mirror + landing page served at ashub.aihao.world
examples/extensions/  example agent-sh extensions (wechat-bot)
scripts/              build helpers (dependency guard, Windows assets, release JSON)
```

## Development

| Command | What it does |
|---|---|
| `npm start` | Run the hub straight from TypeScript via `tsx` (no build) |
| `npm run build` | Compile `src/` to `dist/` with `tsc` |
| `npm run typecheck` | Type-check `src/` (`tsc --noEmit`) |
| `npm run typecheck:web` | Type-check `web/js` via `web/jsconfig.json` |
| `npm run electron:dev` | Build, then launch Electron (`dist/` is what it loads) |
| `npm run electron:pack` | Unpacked app directory, for a quick local build |
| `npm run electron:dist:mac` / `:win` | Build the distributables |

Notes:

- `web/` has **no build step** — plain ES modules and CSS, loaded as-is. All third-party
  front-end libraries (marked, DOMPurify, highlight.js, KaTeX, xterm) are vendored in
  `web/vendor`, so the UI works offline.
- Electron loads the compiled `dist/`, which is why `electron:dev` runs `build` first; the CLI
  runs the same code directly from `src/` through `tsx`.
- `prebuild` runs `scripts/check-deps.cjs`, which fails early with the real reason when
  `node_modules` is stale after a pull.
- Type checking is split: `src` is strict TypeScript, `web/js` is checked with
  `checkJs: false` (see `web/jsconfig.json`).

## Skills and extensions

- **Skills** are installed into the agent-sh skills directory from the built-in marketplace
  (GitHub or Gitee sources) via the sidebar's skills panel.
- **Extensions** are loaded from `~/.agent-sh/extensions/` by the ash backend, which also
  registers `tsx` so extensions can be written in TypeScript.
  [`examples/extensions/wechat-bot`](examples/extensions/wechat-bot) is a complete example:
  a tool that forwards messages to a local webhook.

## Downloads and mirror

Releases are published by GitHub Actions (macOS arm64 + x64, Windows x64, Linux x64) and mirrored
to a small zero-dependency service in [`mirror/`](mirror/README.md). That service does double duty:

- **`mirror.aihao.world`** — release proxy for `electron-updater` and manual downloads, with
  binary URLs rewritten to a CDN so large files don't traverse the VPS.
- **`ashub.aihao.world`** — the download landing page, server-rendered with the current version
  baked in.

Both the one-line macOS installer and the in-app updater prefer the mirror and fall back to
GitHub when it is unreachable.

## License

MIT

Remote access requires an access token. On a non-loopback bind, asHub generates
a token and prints it in the terminal; open `/auth` in your browser to sign in.
Set `ASHUB_TOKEN` before launch to use a persistent token. API clients can send
`Authorization: Bearer <token>`. Use a trusted network or an HTTPS reverse proxy.
Loopback-only desktop use remains unchanged.

ACP sessions resume through the agent's `session/load` capability. If an agent
does not support loading sessions, or a legacy session has no saved remote ID,
its history remains readable but continuing it reports an explicit error.
Create a new session in that case.

Run `npm test` for isolated regressions, followed by `npm run typecheck` and
`npm run typecheck:web`. Tests use temporary data and mock Agent, DOM, PTY and
Electron boundaries; they do not call a model or access your configured keys.

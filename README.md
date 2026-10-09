<p align="center"><img src="web/assets/brand/icon.svg" width="72" height="72" alt="asHub"></p>
<h1 align="center">asHub</h1>
<p align="center">A quiet workspace for ambitious ideas</p>
<p align="center"><a href="https://ashub.aihao.world">Website & downloads</a> · <a href="https://github.com/firslov/asHub/releases">Releases</a> · <a href="README.md">English</a> · <a href="README_CN.md">简体中文</a></p>

[![License](https://img.shields.io/badge/license-MIT-787868.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-22-787868.svg)](.nvmrc)
[![agent-sh](https://img.shields.io/badge/agent--sh-0.15.17-a58b5d.svg)](package.json)

asHub is an open-source desktop workspace powered by [agent-sh](https://github.com/guanyilun/agent-sh). Keep conversations, models, subagents, terminals and project files together, with a readable result and an inspectable execution trail.

Available for **macOS (Apple Silicon / Intel), Windows x64 and Linux x64**. The desktop app and browser share the same client. Bring your own model provider and API credentials; model usage is billed by your provider.

![asHub workspace with session tabs, project analysis and a formatted table](website/assets/showcase-workspace.png)

*Screenshots show the real v0.20.2 interface with an isolated demo project and illustrative conversations. No personal conversations or API credentials are included.*

## Highlights

| Capability | Experience |
| --- | --- |
| Sessions & workspaces | Switch tabs, group by working directory, search, pin, archive and restore history |
| Readable execution | Markdown, highlighted code, diffs, thinking and tool calls with expandable details and copyable output |
| Tasks & subagents | Task progress and five specialists: plan, explore, review, research and implement; configurable models and budgets |
| Models & context | Search and switch models; inspect context use, cache hits and supported provider balances |
| Reviewable actions | Permission prompts, change previews, session-wide approval and background notifications |
| Project tools | PTY terminals, file browsing, image input, a skills marketplace and user extensions |
| Persistent work | Saved conversations, branches, rewind and Markdown export |
| A consistent interface | Light, dark and academic themes; English and Chinese; display scaling and a collapsible status bar |

<details>
<summary>Execution detail: tasks, code changes and tool output</summary>

![Task progress, code diff and tool output in dark mode](website/assets/showcase-workflow.png)

</details>

<details>
<summary>Project files and the warm academic theme</summary>

![Conversation and project file drawer side by side](website/assets/showcase-files.png)

</details>

## Install & get started

Download from the [website](https://ashub.aihao.world/#download) or [GitHub Releases](https://github.com/firslov/asHub/releases/latest). Desktop packages include their runtime; no separate Node.js installation is needed.

| Platform | Package |
| --- | --- |
| macOS Apple Silicon | `arm64.dmg` |
| macOS Intel | `x64.dmg` |
| Windows x64 | `Setup.exe` |
| Linux x64 | `.AppImage` |

1. Install and open asHub
2. Open the configuration panel on the right and set your provider, API credentials and default model
3. Create a session, choose a project directory and start a conversation; open files, terminals and other panels as needed

### macOS one-line install

```sh
curl -fsSL https://raw.githubusercontent.com/firslov/asHub/main/install.sh | bash
```

The script detects Apple Silicon or Intel, installs to `/Applications` and removes the quarantine flag. If a manually installed DMG is blocked, choose **Open Anyway** in **System Settings → Privacy & Security**, or run:

```sh
/usr/bin/xattr -dr com.apple.quarantine "/Applications/asHub.app"
```

### Linux

After downloading the AppImage, run these commands in its directory:

```sh
chmod +x ./asHub-*.AppImage
./asHub-*.AppImage
```

## Run from source

The project pins **Node.js 22.23.3** (minimum **22.12.0**) and **agent-sh 0.15.17**. With nvm:

```sh
git clone https://github.com/firslov/asHub.git
cd asHub
nvm install && nvm use
npm ci
npm run electron:dev
```

For a local browser-only server:

```sh
npm start -- --port 7878
# Open http://localhost:7878
```

### Access from another device

```sh
npm start -- --host 0.0.0.0 --port 7878
```

The default bind address is `127.0.0.1`. Non-loopback access requires a token: startup prints a generated token, which you enter at `/auth`. Set `ASHUB_TOKEN` for a persistent token; API clients can send `Authorization: Bearer <token>`. Use a trusted network or an HTTPS reverse proxy.

Conversation history is stored locally. When using a cloud model, relevant request content is sent to your configured provider. ACP session restoration depends on the backend's `session/load` capability. When unsupported, or when a legacy session has no remote ID, history remains readable but you must create a new session to continue.

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

## Project layout

```text
src/                  HTTP/SSE server, session lifecycle, history and permissions
  bridges/            agent-sh / ACP / PTY bridge implementations
  history/            History store, frame capture and context compaction
web/                  Plain ES modules and CSS; no frontend build step
  js/stream/          Thinking, tools, tasks, replies and live output renderers
  assets/brand/       Shared icons, mark and vector wordmark
electron/             Desktop window, IPC, auto-update and application icons
website/              Homepage, download template, fonts and app screenshots
scripts/              Build helpers and showcase capture
tests/                Isolated regressions, HTTP and kernel compatibility checks
examples/extensions/  Example extensions
```

## Development & validation

| Command | Purpose |
| --- | --- |
| `npm run build` | Compile backend TypeScript into `dist/` |
| `npm run typecheck` | Backend type checking |
| `npm run typecheck:web` | Frontend project checking |
| `npm test` | Isolated regression suite |
| `npm run test:http` | HTTP and session endpoint checks |
| `npm run test:kernel` | Build and check kernel compatibility |
| `npm run electron:pack` | Create an unpacked desktop app |
| `npm run electron:dist:mac` | Build macOS packages |
| `npm run electron:dist:win` | Build Windows packages |

Electron loads compiled `dist/`; the CLI runs source via `tsx`. Frontend libraries are vendored, so interface resources need no external CDN. Regression tests use temporary data and mocked boundaries, without model calls or access to real API credentials.

Install skills through the built-in marketplace. Extensions load from `~/.agent-sh/extensions/` and support TypeScript; see the [extension example](examples/extensions/wechat-bot). HTTP routes live in [`src/hub.ts`](src/hub.ts); the backend contract lives in [`src/bridges/types.ts`](src/bridges/types.ts).

## Website & releases

GitHub Actions builds macOS arm64 / x64, Windows x64 and Linux x64 packages and publishes them to GitHub Releases. The installer and in-app updater prefer the mirror and fall back to GitHub.

The [website](https://ashub.aihao.world) receives the current version and package URLs from the mirror service, avoiding hardcoded download links. See [`website/README.md`](website/README.md) for templates, reproducible screenshots and deployment. The mirror service is deployed separately and is not part of this repository.

## asHub system prompt

The built-in `ash` backend loads its product prompt from [`src/prompts/ashub.ts`](src/prompts/ashub.ts). It describes task execution, research and creative work, session context, tools and skills, delegation, verification and communication. Chat and agent-terminal sessions get different surface descriptions. Planning, response length and delegation remain task-dependent.

The bridge uses agent-sh's identity and frontend hooks while preserving project conventions, global rules, skills, extension instructions and model capability context. Task authorization guidance does not bypass permission checks or change auto-approval settings. Specialized subagents keep their role prompts; external ACP backends manage their own system prompts.

After changing this module, rebuild and restart the running asHub process. Restored sessions create a fresh bridge and load the current prompt. This is separate from the UI's reusable prompt library. `npm run test:kernel` checks the prompt sent to a loopback-only mock model through the real kernel.

## Installation activity & privacy

Packaged desktop builds share limited installation activity by default: a random persistent installation ID, app version, operating system and architecture. Reports run only while an asHub window is focused and the system has been used recently, at most hourly with an additional report across a Beijing-time date boundary. No conversations, prompts, file content, workspace paths or API keys are sent. Failed reports back off silently and never block sessions, startup or updates.

Turn reporting off in **Privacy → Share installation activity** (Windows/Linux: press Alt to show the application menu if hidden), or launch with `ASHUB_USAGE_STATS=0`. The preference is stored locally in `usage-preferences.json`. Updates continue to work when reporting is disabled. Development and CLI builds do not send activity reports.

The mirror reports **active installations**, not unique people. Older clients remain counted through update requests; inferred network fingerprints are shown separately. Download requests do not imply completed downloads or installations, and COS direct downloads bypass these counts. New application events do not persist raw IP addresses or user agents; existing historical logs are retained. As with ordinary HTTP requests, network addresses remain visible to the reverse proxy and its operational access logs. The server applies bounded in-memory limits to activity reports; these are abuse mitigation, not proof of a real user.

## License

[MIT](LICENSE)

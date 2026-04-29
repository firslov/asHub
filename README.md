# Agent SH Hub

A standalone desktop application that hosts one or more [agent-sh](https://github.com/guanyilun/agent-sh) sessions and serves them through a web UI on a single port.

## Features

- **Multi-session** — sidebar lets you spawn (`+`), switch, and close (`×`) sessions on the fly.
- **Live streaming** — SSE event stream with Markdown, syntax-highlighted code, file diffs, and tool calls.
- **Pluggable backend** — `ash` (in-process) or `acp` (JSON-RPC subprocess).
- **Context inspection** — `ctx` panel to view, drop, or rewind conversation messages.
- **Desktop native** — packaged as macOS (Apple Silicon) and Windows apps.

## Install

### Pre-built Binaries

Download from [GitHub Releases](https://github.com/firslov/agent-sh-hub/releases):

- **macOS** (Apple Silicon): `.dmg` or `.zip`
- **Windows** (x64): `.exe` (installer or portable)

> **macOS Note:** The app is unsigned. If Gatekeeper blocks it:
> ```bash
> xattr -dr com.apple.quarantine "/Applications/Agent SH Hub.app"
> ```

### From Source

```sh
git clone https://github.com/firslov/agent-sh-hub
cd agent-sh-hub && npm install && npm link
```

## Run

### Desktop App

```sh
npm run electron:dev      # development mode
npm run electron:dist:mac # build macOS app
npm run electron:dist:win # build Windows app
```

### CLI / Server Mode

```sh
agent-sh-hub                            # default: in-process ash, port 7878
agent-sh-hub --port 8080
agent-sh-hub --backend acp --cmd "claude-code-acp"
```

Open <http://127.0.0.1:7878/>. Click `+` in the sidebar to spawn a session.

### Flags

| Flag                  | Default          | Description                                         |
|-----------------------|------------------|-----------------------------------------------------|
| `--port N`            | `7878`           | HTTP port                                           |
| `--host HOST`         | `127.0.0.1`      | Bind host                                           |
| `--web PATH`          | bundled          | Static web root                                     |
| `--backend ash\|acp`  | `ash`            | Bridge implementation                               |
| `--model NAME`        | settings default | Model override (ash backend)                        |
| `--provider NAME`     | settings default | Provider override (ash backend)                     |
| `--cmd "CMD ARGS"`    | `agent-sh-acp`   | Spawn command (acp backend)                         |

### Backends

- **`ash`** — runs the agent-sh kernel in-process. Uses `~/.agent-sh/settings.json` and user extensions.
- **`acp`** — spawns one JSON-RPC subprocess per session. Compatible with any ACP-speaking agent.

## Endpoints

| Method | Path                       | Description                                  |
|--------|----------------------------|----------------------------------------------|
| GET    | `/`                        | Web UI; redirects to first session if any    |
| GET    | `/sessions`                | JSON list of live sessions                   |
| POST   | `/sessions`                | Spawn a session: `{ cwd?: string }`          |
| GET    | `/<id>/`                   | Web UI for session                           |
| GET    | `/<id>/events`             | SSE event stream                             |
| POST   | `/<id>/submit`             | Submit a query: `{ query: string }`          |
| GET    | `/<id>/context`            | Snapshot: `{ messages, contextWindow, activeTokens }` |
| POST   | `/<id>/context/rewind`     | Drop trailing messages: `{ toIndex: N }`     |
| POST   | `/<id>/context/drop`       | Drop arbitrary indices: `{ indices: [...] }` |
| DELETE | `/<id>/`                   | Close session                                |

## Architecture

```
browser ──HTTP/SSE──> hub ──Bridge──> agent (in-process or subprocess)
```

The **Bridge** interface (`src/bridges/types.ts`) is the seam: `submit`, `cancel`, `snapshot`, `compact`, plus event subscription.

## Adding a Backend

```ts
export class MyBridge extends EventEmitter implements Bridge {
  ready()    { /* initialize */ }
  submit(t)  { /* run a turn, emit "event" with BusEvents */ }
  snapshot() { /* return live message array if you support it */ }
  compact(s) { /* mutate context if you support it */ }
  // ...
}
```

Then wire it in `cli.ts`'s `makeFactory`.

## Extension Loading

User extensions from `~/.agent-sh/extensions/` are automatically loaded on startup. Extensions that would conflict with the hub should check `process.env.AGENT_SH_UNDER_HUB` and bail early.

## Status

Beta. Localhost only by default.

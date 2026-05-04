# asHub

Desktop app for [agent-sh](https://github.com/guanyilun/agent-sh) — runs agent-sh sessions and exposes them through a browser UI.

## Features

- **Multi-session** — sidebar to spawn, switch, and close sessions
- **Session persistence** — conversations survive restarts
- **Live streaming** — SSE with Markdown, syntax-highlighted code, diff views, and tool calls
- **Desktop native** — packaged for macOS (Apple Silicon) and Windows (x64)

## Install

Download from [GitHub Releases](https://github.com/firslov/ashub/releases).

> **macOS:** `xattr -dr com.apple.quarantine "/Applications/asHub.app"`
>
> **Windows:** Requires PowerShell 5.1 or later (built into Windows 10/11).

## Dev

```sh
npm install
npm run electron:dev        # dev mode
npm run electron:dist:mac   # build macOS .dmg
npm run electron:dist:win   # build Windows .exe
```

## CLI

```sh
ashub                        # default: port 7878
ashub --port 8080
ashub --model gpt-4o
```

| Flag            | Default          | Description             |
|-----------------|------------------|-------------------------|
| `--port N`      | `7878`           | HTTP port               |
| `--host HOST`   | `127.0.0.1`      | Bind host               |
| `--model NAME`  | settings default | Model override          |
| `--provider NAME` | settings default | Provider override     |

## API

| Method | Path                   | Description              |
|--------|------------------------|--------------------------|
| GET    | `/`                    | Web UI                   |
| POST   | `/sessions`            | Spawn session            |
| GET    | `/<id>/`               | Session UI               |
| GET    | `/<id>/events`         | SSE event stream         |
| POST   | `/<id>/submit`         | Submit query             |
| GET    | `/<id>/context`        | Context snapshot         |
| POST   | `/<id>/context/rewind` | Drop trailing messages   |
| DELETE | `/<id>/`               | Close session            |

## Status

Beta. Localhost only by default.

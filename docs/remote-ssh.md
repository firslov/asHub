# Remote SSH — design sketch

Status: draft / not implemented.

## Goal

Let a user open an asHub session whose kernel runs on a remote host reached over SSH, with the local desktop app as the front-end. The remote's filesystem, shell, model provider keys, agent-sh extensions, and session history all live on the remote; the local app is a thin client.

Conceptually this is the model VS Code Remote-SSH uses: a small headless server gets installed on the remote on first connect, and the local app talks to it over the SSH channel.

## Why this is a natural fit

The `Bridge` interface in `src/bridges/types.ts` is already transport-agnostic. AshBridge runs the agent-sh kernel in-process; the (now-dead) AcpBridge ran a subprocess over JSON-RPC. A remote session is the same shape with the transport pushed to the far side of an SSH channel.

The catch surfaced while reading `src/bridges/ash.ts`: AshBridge isn't a thin adapter — it owns the kernel. It calls `createCore()` directly, registers user providers from local `agent-sh/settings`, loads extensions from `~/.agent-sh/extensions/`, spawns a local `Shell` PTY, advises `cwd` / `system-prompt:build` / `query-context:build` synchronously, and writes shell-output spill files to local disk. None of that can be re-implemented on the local side of a network bridge — it has to live where the cwd, the shell, the keys, and the files live.

So there is no meaningful "thin" remote-spawn. Whatever runs on the remote is essentially AshBridge — i.e. it's `ashub` itself running headless. The remote SSH feature is, structurally, "run `ashub` on the remote and connect to it."

## Architecture

```
┌─────────────────────────────┐         ┌──────────────────────────────┐
│ Local desktop (Electron)    │         │ Remote host                  │
│                             │         │                              │
│ Hub                         │   SSH   │ ashub-server (headless)      │
│  └─ RemoteBridge ───────────┼─tunnel──┼─→ HTTP+SSE on 127.0.0.1:N    │
│                             │         │      └─ AshBridge            │
│                             │         │           └─ agent-sh kernel │
│ Web client (browser/Electron│         │              + Shell PTY     │
│  renderer) — unchanged      │         │              + extensions    │
│                             │         │              + ~/.agent-sh/  │
└─────────────────────────────┘         └──────────────────────────────┘
```

Key property: **the existing HTTP+SSE protocol between the web client and the hub is reused as-is**. The "remote bridge" on the local hub is just an HTTP client pointing at a `127.0.0.1:N` port that an SSH local-forward routes to the remote ashub-server.

## What already exists

- `bin/ashub.js` → `src/cli.ts` is already a headless HTTP+SSE server. It is what `electron/main.cjs` runs in-process; it can also run standalone.
- `agent-sh` is a normal npm dependency (`package.json:23`). The kernel, extension loader, providers, and shell are all importable.
- Sessions, extensions, and keys are already filesystem-native (`~/.agent-sh/`). Move the kernel to the remote and these correctly co-locate with the remote.
- `Bridge` is the right abstraction boundary; no interface change required.

## What needs building

### 1. Portable server artifact

Today `ashub` is distributed only as platform installers (dmg / exe / AppImage). It is not on npm. Remote bootstrap needs a self-contained tarball per target:

- `ashub-server-linux-x64.tar.gz`
- `ashub-server-linux-arm64.tar.gz`
- `ashub-server-darwin-arm64.tar.gz`
- (Windows remote is out of scope for v1.)

Each tarball contains a pinned Node runtime + a bundled `ashub` server (esbuild/ncc-flattened `src/cli.ts` with `agent-sh` and its deps). Built and uploaded as GitHub release assets alongside the desktop installers.

This artifact also closes the npm-install gap for plain server deployments (`curl … | sh`), so the work is dual-purpose.

### 2. Bootstrap module

Local component that, given an SSH host:

1. Opens an SSH connection (reuse system SSH agent / `~/.ssh/config`).
2. Probes remote arch: `uname -sm`.
3. Checks `~/.ashub-server/<version>/` for a matching cached install.
4. If missing: fetches the matching tarball (from GitHub releases by default; option to push via SCP for air-gapped remotes), extracts to `~/.ashub-server/<version>/`.
5. Launches `~/.ashub-server/<version>/bin/ashub --host 127.0.0.1 --port 0`, captures the chosen port from stdout.
6. Opens a local-forward `127.0.0.1:M ↔ remote 127.0.0.1:N` over the same SSH channel.
7. Returns `{ localPort: M }` to the hub.

Idempotent: subsequent connects skip steps 3–4.

Multiple cached versions coexist under `~/.ashub-server/<version>/` so old/new clients can connect during rolling upgrades (VS Code does this).

### 3. RemoteBridge

Probably nearly trivial: a `Bridge` implementation that's really a thin wrapper around the existing web-client HTTP/SSE protocol, pointed at the forwarded local port. Since the kernel on the remote is already running inside an AshBridge, all the Bridge methods round-trip cleanly:

- `submit` / `cancel` / `writePty` / `resizePty` / `execCommand` / `setThinking` → POST
- `snapshot` / `getModels` / `compact` / `autocomplete` → request/response
- BusEvents → SSE stream
- `permission:request` → request/response (same head-of-line concerns as local, no worse over SSH)

Alternative worth weighing: skip RemoteBridge entirely and let the local desktop app spawn its web UI pointed straight at the forwarded port. Simpler but loses unified session listing across local + remote hosts.

### 4. UI

- Sidebar gains a "Hosts" section: add host, connect/disconnect, status.
- On new session, host picker selects which host's kernel to spawn the session under.
- Per-session: indicate which host it lives on; surface remote cwd in the path display.

### 5. First-run UX for empty remotes

A fresh remote has no `~/.agent-sh/keys.json` and possibly no `agent-sh` settings. AshBridge will reject `submit` with `"No agent backend configured"` (`src/bridges/ash.ts:434`). The remote-host onboarding flow should:

- Detect missing keys after server bootstrap.
- Offer to open a remote settings panel, or to push selected keys with explicit consent.

## Open questions

- **Tarball distribution**: GitHub Releases (simplest, requires remote internet) vs. local-pushes-over-SCP (works air-gapped, slower first connect). VS Code supports both. Start with releases; add SCP fallback later.
- **Auth model**: reuse system SSH (`ssh-agent` / `~/.ssh/config`) vs. app-managed keys. Strongly prefer system SSH for v1 — no key storage in the app.
- **Version drift**: what happens when local app version > newest cached server version? Auto-install the matching one; warn but don't block if the user explicitly wants to use an older cached server.
- **Session listing**: are remote sessions listed in the local sidebar (cross-host unified view) or only visible while connected? Unified view is friendlier but means persisting per-host session indexes locally.
- **Disconnect / reconnect**: what does a session look like during a network blip? Today SSE just reconnects; remote-side AshBridge keeps running because it's the same process. Worth verifying with a deliberate kill-the-tunnel test once a prototype exists.
- **Multi-user remotes**: the server binds `127.0.0.1` per user; two users on the same box get two independent installs under their respective `~/.ashub-server/`. Fine.

## Phasing

1. **Server bundle build target** — produce per-arch tarballs in CI; publish to releases. This is the single highest-leverage piece because it also unblocks general non-Electron installs.
2. **Bootstrap module** (standalone CLI first) — `ashub remote install <host>`, `ashub remote launch <host>`. Verify end-to-end by opening the existing web UI against a forwarded port manually.
3. **RemoteBridge + hub integration** — sessions can be created against a registered remote host from inside the desktop app.
4. **UI for hosts + per-session host indicator.**
5. **First-run onboarding for empty remotes.**

Stages 1–2 deliver value standalone (better install story) before any desktop UI work lands.

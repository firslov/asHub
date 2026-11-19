# asHub Mobile

A mobile PWA backed by an account gateway and an outbound desktop connector.
The desktop Hub remains authoritative for conversations, files and execution.

## Use

1. Run the desktop build containing this feature. Open **移动访问** (phone icon).
2. Create an account or sign in, name the computer and select project directories.
3. Save the recovery code and select **我已保存**. Until confirmed, codes remain
   available when switching menus or reopening the panel, including when registration
   completes while the panel is closed. They live only in the current desktop renderer
   memory: save them before quitting or refreshing. Passwords require 12–128 characters.
4. Open <https://ashub.aihao.world/mobile/> on your phone and sign in to the same account.
5. Select a computer and conversation, or create a conversation in an authorized project.
   You may add the page to the home screen through your browser.

Keep the desktop app running and the computer awake. Disconnected phones do not
stop local tasks. Offline computers cannot receive commands; text drafts remain
on the phone. After an uncertain send, check history before manually retrying.
Only explicitly authorized agent conversations with existing working directories are visible.
If a conversation is missing, check its working directory against the desktop shared
roots; restore or change missing directories, and unarchive conversations on the desktop. The project list
selects shared conversations; it is not a filesystem sandbox. Model tools retain
the desktop's existing permissions. Remote approvals apply once. Site access, recurring seven-day grants, and ACP requests without an explicit one-time allow option can be declined on the phone and must be approved on the desktop.
CLI-only Hubs without a secure credential store cannot enable mobile access.

## Replies and previews

Math uses the desktop KaTeX parser for live output and history. Wide display
formulas scroll within their own row. Ordinary Markdown workspace images use
the existing authenticated artifact channel; plugin image snapshots retain their
separate resource endpoint. Raster images are bounded to 8 MiB / 32 megapixels,
fit the conversation width and open in the in-app preview. External image URLs
are not fetched automatically; files must remain in an authorized shared directory.

Run `npm run test:rich-content` with Playwright/WebKit available to cover math,
mobile layouts, image ownership, mixed image queues and stale response cleanup.

## Data and access

The gateway stores account password hashes (scrypt), recovery/token hashes,
device names and presence. It does not persist conversation bodies or uploads.
HTTPS/WSS encrypt transport, but the gateway can read relayed content; this is
not end-to-end encryption. Browser storage contains per-account text drafts and
pending request identifiers. If browser persistence is unavailable, drafts and
send tracking stay in memory for the current page only. The service worker
caches only the public UI shell.
Desktop credentials use Electron safeStorage; Linux basic_text is rejected.
Disabling mobile access stops all connections, including after restarting the app,
and retains the encrypted device identity for password-authenticated reactivation.
Editing the device name or shared directories reuses that identity.
Project selections use opaque stable IDs; removed projects and older numeric
selections are rejected and require refreshing the project list. To revoke it
permanently, remove the device in the web account settings.
Keep recovery codes safe: password recovery revokes all logins and device bindings.
Account management can revoke devices and other browser logins immediately.

The relay exposes a small operation allowlist, not arbitrary Hub HTTP routes.
A persistent local journal prevents duplicate submit/create effects after retries.
A crash with an outstanding operation returns `unknown` and never retries it
automatically. Stream reconnects request a fresh local replay. Protocol version: 1.

## Development and tests

Desktop: Node 22 as pinned by the repository. Gateway: Node >=22.13 with node:sqlite
(the existing server's Node 24 is supported). The gateway is a separate package:

```sh
npm ci
npm run build
npm --prefix remote ci
npm --prefix remote test
npm test
npm run test:http
```

The tests use temporary accounts, databases and fake model output; no provider
credentials or production conversations are needed. Build the desktop before
running gateway tests. For a different deployment, set `ASHUB_REMOTE_URL` on both
the desktop process and gateway. HTTPS is required outside test mode.

## Deployment

Deploy only this directory (excluding node_modules, tests and data) to a release
folder under `/opt/ashub-mobile/releases`, run `npm ci --omit=dev --ignore-scripts`,
and point `/opt/ashub-mobile/current` to that folder. Install the unit files from
`deploy/`, create a non-login `ashub-mobile` system user and enable the service.
The process listens only on 127.0.0.1:3002 and uses `/var/lib/ashub-mobile` for SQLite.

Include `deploy/nginx-mobile.conf` inside the existing `ashub.aihao.world` HTTPS
server block; preserve its other locations. Run `nginx -t` before reload. This
uses existing TLS and does not change the homepage or mirror service. The proxy
must overwrite X-Real-IP; do not expose the Node listener directly.

```sh
sudo systemctl enable --now ashub-mobile
sudo systemctl enable --now ashub-mobile-backup.timer
curl https://ashub.aihao.world/mobile/health
sudo systemctl status ashub-mobile
sudo journalctl -u ashub-mobile --since today
```

The timer makes consistent SQLite backups (including WAL contents) and retains
seven copies on the same disk. Configure an off-host backup separately for disk
failure recovery. Backups contain account credentials and must remain private.
To restore, stop the service, preserve the current database/WAL/SHM, replace with
a backup owned by `ashub-mobile` (0600), remove the old WAL/SHM, and restart.
To roll back code, restore the previous `current` symlink and restart. Initial
schema is additive; future migrations must document any rollback constraints.

## Mobile feature parity

Conversation browsing, streaming, text/images, models, cancellation and one-time
approvals are available. The mobile UI follows the desktop light/dark palette and
keeps tool/thinking details collapsed, with separate task progress and reply errors.
Model search includes the desktop's configured Codex models; unknown cache usage
is shown as unavailable instead of zero.

The model picker also offers the active model's native thinking levels, obtained
from the desktop rather than a shared preset ladder. Selections sync across clients
and persist with the desktop conversation. Model and thinking changes are available
when the conversation is idle and connected; stale model selections are rejected.
Older connectors retain basic model selection with a desktop upgrade hint.
The searchable model list scrolls independently of the thinking controls, with
44 px touch targets, wrapped options and layouts for small screens and keyboards.

The conversation picker supports search, status filters and desktop project groups.
With desktop 0.21.2 or newer, project conversations follow the desktop pin order
and show a subtle pin label. Pin management remains on the desktop; older clients
keep their existing list order.
Only authorized group members are shown. Project task receipts and paginated output
require both source and recipient conversations to be shared. Project management,
isolated worktree creation and provider sign-in remain desktop operations. A worktree
outside the shared roots is not automatically shared.

Workspace result links download through the authenticated gateway. The desktop
checks conversation access and real file paths for every chunk. Downloads are bounded
to 256 KiB relay chunks, retain Unicode filenames, and abort if the file changes.
Files are streamed without gateway disk storage; the browser handles the download.
Paths outside the conversation's working directory are rejected, including symlinks.

Deploy the matching desktop connector and gateway/UI together to enable project
views, task receipts and file downloads. Capability detection keeps older connectors
usable for basic chat; refresh after upgrading an online desktop. Terminal, file
explorer, bulk history management, provider credentials, OS notifications,
offline history and E2EE are not included.

Deployment archives must include `server.mjs`, `package.json`, `package-lock.json`, `public/`, and `deploy/`. The scheduled backup service reads `deploy/backup.mjs` through the active release symlink. Verify the backup service after switching releases.

### Mobile navigation

The sidebar opens projects in place, preserves desktop pin order, and offers three recent conversation shortcuts. Search matches conversation and project names across the current device. Device choice, expanded groups and the last conversation are stored per account/device (IDs only). Restoring a conversation always checks the current shared session catalog first; an offline preferred device is not silently replaced. Touch layouts retain one sidebar scroller, including iPhone PWA keyboard and landscape sizes.

Navigation regression: `npm run test:navigation` (Playwright WebKit installed; set `PLAYWRIGHT_MODULE` if needed). Set `NAV_ENGINE=chromium` to repeat in Chromium. Fixtures use synthetic conversations and do not contact user devices.

### Conversation controls

The chat header offers a compact settings menu when the connected desktop advertises `sessionNetwork` / `sessionDelete`. VPN is a per-conversation proxy override (inherit / enabled / disabled), never a global OS VPN switch. Deletion requires explicit confirmation, removes desktop conversation history and stops its work, but preserves work-directory files. Durable request receipts make retries safe after a lost deletion response. Older released desktops keep these controls hidden and retain existing remote features; desktop connector updates are required to enable them.

`npm run test:session-actions` checks the real browser menu, narrow layouts, proxy save failures, confirmation and lost-reply retries. `hub-test.cjs` verifies either the new controls or released-desktop rejection based on advertised capabilities.

### Desktop 0.21.5

The dedicated assistant entry appears only when the desktop advertises it and
its workspace is explicitly shared. Mobile opens the existing conversation and
a compact memory switch beside its label. With the updated desktop and assistant
plugin, pausing memory takes effect directly and preserves existing memories;
enabling memory requires explicit authorization on the desktop. Memory collection
and recall stay restricted to the dedicated assistant conversation. Older desktops
retain ordinary conversation access and their existing resource controls.

Project activity summaries reflect authorized continuation workflows; the gateway
does not independently schedule work or retry uncertain operations. Browser file
approvals preserve desktop-only download review and persistent grant boundaries.

Acceptance includes `npm run test:assistant` in WebKit and Chromium, in addition
to navigation, session actions, rich content and released-desktop compatibility.

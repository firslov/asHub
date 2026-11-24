# Plugin archive installation

Open **Plugins → Install plugin**, choose or drop one ZIP (up to 32 MB), review the package and confirm. The preview never imports plugin code. A package can be flat or contain one enclosing folder. It must include `package.json` with an unscoped lowercase package name and a version. Legacy/session packages use a root `index.js`, `index.mjs`, `index.ts`, `index.tsx` or `index.mts` entry. Manifest v2 may declare explicit session/application entries or UI only. A legacy `main`, if specified, must match the discovered entry. Archives containing symlinks, unsafe paths, duplicate portable paths, `node_modules`, or oversized contents are rejected. Each upload carries a random request ID stored before submission. The server deduplicates in-flight/completed previews by that ID, and the locally authenticated installer only returns the matching unconfirmed preview for recovery. A new window never adopts another window's ZIP. Short retries cover network races; recovery never confirms the package. Successful installations clear their persisted job and preview IDs so an expired server job cannot reappear as a failure after reload.

Older packages without a manifest support basic import. Their package scripts are not executed. Production npm dependencies require `package-lock.json` and an npm CLI. The host runs `npm ci --omit=dev --ignore-scripts --no-audit --no-fund` in staging. When `ASHUB_NPM_CLI` is set, asHub uses that explicit path. Otherwise, it tries the `npm_execpath` hint, PATH, and standard installation directories, including Homebrew on macOS. It checks the npm package's Node requirement when available, then runs `npm --version` with the host's Node runtime. Use **Recheck environment** after installing or repairing a tool. Plugins needing a build or other environment preparation must declare a setup script. npm lifecycle scripts are not implicitly enabled.

## Manifest

Place `ashub-plugin.json` alongside `package.json`:

```json
{
  "schemaVersion": 1,
  "id": "example-plugin",
  "name": "Example",
  "platforms": ["darwin", "win32", "linux"],
  "minNode": "22.12.0",
  "dependencies": [{ "id": "another-plugin", "minVersion": "1.0.0" }],
  "setup": {
    "script": "scripts/ashub-setup.mjs",
    "description": "Describe exactly what this script downloads and prepares"
  },
  "defaults": { "example": { "enabled": false } },
  "permissions": ["Any system permission the user must grant manually"]
}
```

Only `schemaVersion` and `id` are mandatory; `id` must equal the package name. Declare OS requirements with `platforms` and Node requirements with `minNode` or `package.json.engines.node`. Dependencies must already be installed and enabled. A setup script runs only after the installation preview is confirmed. It receives `AGENT_SH_HOME` and an isolated persistent `ASHUB_PLUGIN_DATA` directory. It runs with the user's permissions; this is a trusted-code mechanism, not a sandbox. Scripts should be idempotent, handle SIGTERM, preserve working runtimes on failure, and never activate external applications or send messages. Do not modify shared settings from child processes: use `defaults`, which the host writes in its own settings transaction only for previously absent plugin namespaces.

### System and external runtime requirements

Manifest v1 and v2 packages can declare machine-checkable requirements alongside the human-readable `permissions` hints:

```json
{
  "system": { "minMacOS": "14.0.0", "arch": ["arm64", "x64"] },
  "runtimes": [{ "kind": "python", "version": ">=3.12.0" }]
}
```

`runtimes.kind` currently supports `python` and `git`. The host owns the candidate locations, executable probes and version parsing. It rejects unknown kinds, duplicate requirements and invalid ranges. Python discovery uses an explicit `ASHUB_RUNTIME_PYTHON` or `ASHUB_DESKTOP_PYTHON` path when supplied. Otherwise, it checks the active virtual environment and PATH before standard installations. Resolved absolute paths are passed to confirmed setup scripts as `ASHUB_RUNTIME_PYTHON` or `ASHUB_RUNTIME_GIT`.

Installation rechecks the approved paths and versions before setup and before committing the upgrade. If the selection changes, check the new environment and confirm the new preview.

Dynamic probes run asynchronously during preview, again before setup and before package placement. They never execute plugin setup during preview. `package.json.engines.node`, `os` and `cpu` are also checked for manually copied packages. Catalogue discovery remains synchronous and uses static platform/CPU checks; exact external-runtime health belongs in installation, activation or plugin diagnostics rather than every directory scan.

Installation is staged outside the extension discovery directory. Active tasks using an existing plugin block its upgrade. Setup may generate implementation files, but approved package identity, entry resolution, runtime requirements and manifest declarations are rechecked before placement. The installed directory is replaced only after setup and entry validation; a recoverable copy of the previous package remains under `plugin-install/backups`. Failed setup leaves the old package untouched; failed initial settings writes roll package replacement back. Custom scripts must manage their own external side effects and cleanup. Successful upgrades do not replace existing settings or change enable/disable choices. An upgrade that changes the canonical entry path is rejected; automatic identity migration is not supported. Restart asHub, including its tray process, after current tasks finish so existing kernels and cached modules load the new version.

## Plugin packages

- Project management 0.2.0: no additional runtime; creating, configuring, detaching, archiving and deleting conversations still requires explicit authorization.
- Desktop control 0.3.4 (separately distributed ZIP): macOS 14+, arm64/x64 and Python 3.12+ are declared in its manifest and checked in the preview. The setup script creates an isolated desktop-control environment and installs its pinned arc-cua revision and OCR dependencies. Runtime status performs an explicit Python/import health check; a stale `.complete` marker alone is not treated as healthy. `/desktop install` and ZIP setup rebuild a damaged environment in staging and only replace it after validation. System accessibility/screen-recording permissions and allowed apps remain user controlled.
- WeChat 0.3.4 (separately distributed ZIP): install desktop control 0.3.4 first; setup verifies its Python/OCR runtime health. Configuration starts disabled and read-only unless existing user settings say otherwise. Installation never reads or sends WeChat messages.

Only the desktop/local authenticated management interface exposes installation. The mobile relay does not expose the installer.

## Manifest v2: application and UI contributions

Use v1 for existing agent-sh session plugins. Use v2 when declaring explicit scopes or UI. The same archive installer supports both:

```json
{
  "schemaVersion": 2,
  "id": "example-plugin",
  "name": "Example",
  "requires": { "hostApi": "^1.0.0", "capabilities": ["application-lifecycle"] },
  "entries": { "application": "app.mjs" },
  "configNamespaces": ["example"],
  "defaults": { "example": { "label": "Review", "enabled": false } },
  "configSchema": {
    "example": {
      "type": "object",
      "properties": { "label": { "type": "string", "maxLength": 80 }, "enabled": { "type": "boolean" } }
    }
  },
  "ui": {
    "version": 1,
    "panels": [{
      "id": "preferences",
      "title": "Example",
      "components": [
        { "type": "text", "text": "Configure this plugin" },
        { "type": "form", "id": "settings", "mode": "config", "namespace": "example", "fields": [
          { "id": "label", "label": "Name", "type": "text", "value": "Review" },
          { "id": "enabled", "label": "Enabled", "type": "boolean", "value": false }
        ] },
        { "type": "action", "label": "Prepare a request", "action": "composer.insert", "value": "Help me review this project" }
      ]
    }]
  }
}
```

An application entry exports a default function or `activate(context)`. It may return nothing, a cleanup function, or `{stop, canStop}`. Example `app.mjs`:

```js
export default function activate(ctx) {
  const unsubscribe = ctx.services.host.subscribe(event => {
    // Use invalidations to refresh your own read model; never mutate core state here.
  });
  ctx.onDispose(unsubscribe);
  return { stop() { /* release remaining owned resources */ } };
}
```

`ctx` provides `signal`, `onDispose`, `pluginId`, `getExtensionSettings(namespace, defaults)` and explicitly injected `services`. Register cleanup before asynchronous setup. Session and application entries must be separate files. Omit `entries` and the application capability for UI-only packages; no JavaScript is imported for those packages. Successful installation refreshes the application registry and notifies other windows. If that notification fails, the installed package remains successful and the job exposes `notificationError`; reading the feature catalog retries discovery. Session kernels retain their existing restart requirements. Application settings are captured per activation; restart asHub or disable/re-enable an idle application feature to apply saved changes.

`configNamespaces` limits v2 reads/writes to the plugin's declared settings. Application keys such as `ashub.*` and provider credentials cannot be declared as plugin namespaces. The optional `configSchema` supports object/array/string/number/integer/boolean, properties, required, additionalProperties, items, enum and basic length/range constraints. Unsupported keywords are rejected. Configuration writes, including the existing JSON editor, use the same schema and revision checks.

Declarative UI allows text, status, list, form and `composer.insert`. Forms default to local draft mode; only `mode: "config"` writes a declared namespace through the existing configuration API. Fields support text, number, boolean and select. There is no arbitrary HTML, CSS, module URL, network action or auto-send action. Invalid UI is rejected; the serialized UI is limited to 262,144 UTF-16 code units in both the installer and frontend. The mobile relay does not expose plugin installation/configuration or application feature enable controls.

Compatibility is checked against the host API version, supported capabilities, platform, Node and enabled dependencies. Unsupported packages fail explicitly rather than loading partially. Application code is trusted code with the user's Node process permissions; the declarative UI restrictions are not an OS sandbox for executable entries.

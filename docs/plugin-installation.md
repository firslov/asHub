# Plugin archive installation

Open **Plugins → Install plugin**, choose or drop one ZIP (up to 32 MB), review the package and confirm. The preview never imports plugin code. A package can be flat or contain one enclosing folder. It must include `package.json` with an unscoped lowercase package name, a version, and a root `index.js`, `index.mjs`, `index.ts`, `index.tsx` or `index.mts` entry. If `main` is specified, it must match the entry discovered by asHub. Archives containing symlinks, unsafe paths, duplicate portable paths, `node_modules`, or oversized contents are rejected.

Older packages without a manifest support basic import. Their package scripts are not executed. Production npm dependencies require `package-lock.json` and a local npm installation; the host runs `npm ci --omit=dev --ignore-scripts --no-audit --no-fund` in staging. Plugins needing a build or other environment preparation must declare a setup script. npm lifecycle scripts are not implicitly enabled.

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

Installation is staged outside the extension discovery directory. Active tasks using an existing plugin block its upgrade. The installed directory is replaced only after setup and entry validation; a recoverable copy of the previous package remains under `plugin-install/backups`. Failed setup leaves the old package untouched; failed initial settings writes roll package replacement back. Custom scripts must manage their own external side effects and cleanup. Successful upgrades do not replace existing settings or change enable/disable choices. Restart asHub, including its tray process, after current tasks finish so existing kernels and cached modules load the new version.

## Included plugin packages

- Project management 0.1.1: no additional runtime; creating conversations still requires explicit authorization.
- Desktop control 0.3.3: macOS 14+, Python 3.12+; the setup script creates the existing isolated desktop-control environment and installs its pinned arc-cua revision and OCR dependencies. If Python is missing, install Python 3.12+ and retry. System accessibility/screen-recording permissions and allowed apps remain user controlled.
- WeChat 0.2.3: install desktop control 0.3.3 first; setup verifies its Python/OCR environment. Configuration starts disabled and read-only unless existing user settings say otherwise. Installation never reads or sends WeChat messages.

Only the desktop/local authenticated management interface exposes installation. The mobile relay does not expose the installer.

# Core and extension architecture

asHub owns the durable conversation model, project membership, host authorization, rendering shell and platform integration. Optional workflows use those primitives rather than inventing a second conversation store or an approval bypass. The agent-sh kernel remains responsible for model providers, tools and per-conversation execution.

## Layers

| Layer | Responsibilities | Location |
| --- | --- | --- |
| Composition and legacy adapters | Construct per-Hub services; retain existing HTTP/Bridge contracts | `src/hub.ts` |
| Core services | Session registry, creation/restoration, model configuration, project commands and source-bound host operations | `src/services/` |
| Transport | Versioned host queries/events, project and optional feature HTTP adapters | `src/transport/` |
| Application extensions | One lifecycle per Hub, installed manifest discovery, enable state, compatibility and cleanup | `src/extensions/` |
| Session extensions | Register tools/providers with each agent-sh kernel, bind host calls to the requesting conversation | `src/plugin-runtime.ts`, `src/bridges/ash.ts` |
| Frontend extensions | Bundled lazy modules and validated declarative contributions using existing theme/layout | `web/js/extensions/` |
| Remote adapter | One application-owned connector; permission-filtered remote protocol | `src/remote/` |

Services do not import the Hub or frontend. They receive explicit ports for persistence, bridge calls and notifications. Session history and project files keep their existing formats; extracting services does not duplicate their ownership. Bridge event translation and legacy transport adapters remain in the Hub where they share state; new feature logic belongs in a service or extension rather than expanding that file.

## Optional built-in features

`quick-prompts`, `skills-marketplace`, `provider-balance` and `mobile-access` are registered application/frontend features. Existing installations enable all four by default. Disable choices are persisted in `ashub.features.disabled`, separately from kernel plugin settings. Disabling a feature retains settings, prompts, history, projects and remote identity. Core conversation creation, sending, cancellation and history do not depend on these features.

The skills marketplace and provider balance own their caches and in-flight work per Hub. Their HTTP routes use registry admission. A busy feature rejects ordinary disable with 409; it is not silently interrupted. Mobile access owns one injected connector and retains the existing root authorization, credential storage, request journal and generation checks. Disabling it closes remote admission; it is separate from unlinking an account or device.

The prompt library remains a bundled UI module with its existing local storage and import/export format. Project-management policy remains in `examples/extensions/project-management`; the core provides generic, explicitly approved project/conversation operations only.

## Plugin scopes

There is one plugin catalog and archive installer. Manifest v1 and manifestless agent-sh plugins remain session extensions. Manifest v2 can declare distinct `entries.session` and `entries.application`, declarative UI, or a combination. UI-only packages do not require an executable entry. Host API/capability and dependency requirements are validated before code is loaded.

Application extensions start once per Hub, not once per conversation. A successful ZIP installation refreshes the registry and notifies connected clients independently of the installer panel. Installed-plugin toggles serialize dependency checks with persistence, so a busy rejection retains the previous settings. They receive an abort signal, cleanup registration, a snapshot of their declared configuration and explicitly injected services. Saved configuration is read on the next activation; restart the application, or disable and re-enable an idle application feature, to apply it. The injected host service is read-only (`capabilities`, `snapshot`, `subscribe`). They cannot obtain a conversation mutation identity by supplying a source ID. Session extensions continue using `ashub:catalog` and `ashub:execute` with host-bound identity and explicit user approval.

Factories must register cleanup before awaiting resource creation, honor the abort signal and return a cleanup function or an instance with `stop`. The registry serializes lifecycle changes, isolates activation failures, times out unresponsive activation/cleanup, and tears down dependents before dependencies. Failed replacement cleanup retains the affected dependency instances until restart, reflects persisted enable preferences, and leaves the catalog and unrelated plugins usable. Shutdown always proceeds with durable core cleanup even when optional cleanup fails. This is trusted Node code in the application process, not a security sandbox; synchronous blocking code or arbitrary native side effects cannot be isolated by a promise timeout.

## UI and synchronization

Bundled executable UI loaders are selected in source code; server metadata cannot choose module URLs. Installed UI uses a bounded declarative schema: plain text, status, lists, forms and the `composer.insert` action. Configuration forms bind to the installed plugin identity and declared namespace, preserve unknown existing keys, validate values and use revision-checked writes. A conflict preserves the draft until the user reloads. Composer insertion does not send a message or approve an operation.

The host exposes versioned snapshots and SSE invalidations. Clients refetch after reconnect or epoch changes; events are notifications, not a durable log. Existing endpoints remain available to old clients. Desktop feature menus use the shared registry. The remote gateway retains its narrower permissions and does not forward the desktop catalog, installer or plugin configuration APIs. Shared pure conversation presentation rules cover tool grouping and token/cache metrics; remote transport and mobile layout remain separate adapters.

## Compatibility and rollout

- No automatic conversion of history, projects or existing plugin settings.
- Existing ZIP packages remain supported; incompatible v2 requirements are rejected explicitly.
- Upgrading session plugins still requires recreating/restarting kernels after work finishes.
- Feature disable is reversible and does not uninstall the package.
- Rollback must stop the Hub first and retain settings/history/operation receipts. New v2 application/UI packages require a host that supports their manifest; remove or disable them before using an older host.
- Server website sources are maintained separately and are not included in the application repository or this delivery's deployment.

See [host API](plugin-host-api.md) and [archive installation](plugin-installation.md) for contracts and examples. `npm run test:architecture` and `npm run test:architecture:ui` verify the new boundaries alongside the existing regression suites.

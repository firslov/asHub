# File previews

The desktop and remote clients use the same `AsHubFilePreview` host and basic renderers. The core owns file access, dialog lifetime, cancellation, size limits and native file actions. Format-specific rendering lives in `web/js/file-preview-renderers.js`; it does not modify the agent kernel.

- `open({ url, name, lang, pdfBase, nativeAction?, openExternal?, share?, current? })` accepts a same-origin authenticated attachment URL. `current` invalidates remote work after account/device/session changes. The optional `openExternal` adapter routes document web links to the desktop system browser; web clients keep normal browser navigation.
- `close()` cancels pending reads and releases object URLs and PDF workers.
- Trusted UI modules can call `register(id, { accept(name), limit, render(context) })`. The return value unregisters that renderer. A renderer may register cleanup with `context.cleanup(fn)` and must check `context.current()` after awaiting. The limit is at most 32 MiB. This is a UI module interface, not permission for installed plugins or file contents to execute arbitrary frontend JavaScript.
- Images are limited to 16 MiB, text to 2 MiB, and PDF to 24 MiB. Larger files keep native-open and download actions. HTML/SVG are shown as text; Markdown cannot load remote images or execute embedded content.
- PDF.js 6.4.299 is vendored locally using its official legacy build for Electron and WebKit compatibility. Pages render on demand, with bounded canvas resolution; no Office conversion or external document service is used.
- Desktop `desktop:file` IPC accepts a session, relative/contained file path, and `open` or `reveal`. Only trusted main frames may invoke it. The hub resolves the real path against the live session working directory; default-app opening permits data document types, never arbitrary executable file types. Remote clients receive no native desktop-open API.
- Downloads remain attachments. Preview reads use a metadata version where available to reject replacements between HEAD and GET.

When editing the shared host, renderers or stylesheet, copy them to `remote/public/` and bump the remote shell cache. Remote server files remain separate from application GitHub changes. PDF vendor assets and their license files must be shipped on both clients.

Validation: `node --test tests/file-preview.cjs tests/regression-links.cjs`, `node tests/http-artifacts.cjs`, and `npm run test:files:ui`. The UI fixture uses synthetic documents, isolated storage and a temporary loopback server; no user files or model requests are used.

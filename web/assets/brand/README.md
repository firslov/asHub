# asHub visual identity

The mark uses three continuous folded surfaces around an open center. The surfaces represent independent conversations and agents; their shared center represents coordinated work. The open negative space keeps the symbol light and legible. This is an abstract identity, not a literal arrangement of the letters in the name.

## Palette and variants

- Graphite: `#272824`
- Warm ivory: `#F3F0E8`
- Champagne gold: `#C1A574`

`mark.svg` is the theme-aware vector master. Two surfaces inherit `currentColor`; the third inherits `--brand-metal` with a gold fallback. Welcome and loading screens use the same three paths. Avoid adding outlines, orbit decorations or detail at small sizes.

`icon.svg` is the small browser favicon and README image. The packaged application icon (`electron/icon.svg`) uses the same silhouette, with restrained directional shading and a graphite tile. The monochrome tray master (`electron/tray.svg`) uses identical geometry and no tile. macOS template images retain transparent backgrounds. The PWA has its own full-bleed tile and an opaque Apple touch icon.

`wordmark.svg` retains the locally bundled Source Serif 4 type: italic 400 for “as”, upright 600 for “Hub”. Its short angular accent echoes the folded mark. Every inline wordmark has a unique gradient ID. Font files are local; no remote font request is required. The native macOS title bar keeps its reserved control area, and Windows displays only one wordmark.

## Regeneration

Run `npx electron scripts/generate-brand-assets.cjs` from the repository root. It renders the checked-in SVG masters with Chromium, then writes PNG, multi-resolution ICO and ICNS containers. No image library, API key or platform-specific conversion tool is required. Remote assets are generated only when `remote/public/icon.svg` exists, so the core-only repository also works.

Outputs include 16–1024px application icons, 18/36px macOS template images, Windows/Linux tray icons, 192/512px PWA icons and the 180px Apple touch icon. The script uses a temporary Electron profile and does not start asHub or access user conversations.

Use `node --test tests/regression-branding.cjs` and `npx electron tests/electron-themes.cjs` to verify resource integrity, shared geometry, title-bar spacing and light/dark presentation.

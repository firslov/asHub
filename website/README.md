# Website

The public site at https://ashub.aihao.world uses the same visual identity as the app: warm white, graphite and muted champagne. Static fonts and scripts are served locally.

## Files

- `index.html`: static preview, with working GitHub Releases download fallbacks
- `download.html`: the same page, used by the production mirror renderer
- `assets/site-20261008.css` / `.js`: layout and progressive enhancements
- `assets/showcase-*.png`: actual v0.20.2 UI renders with isolated, illustrative demo data
- `assets/brand-20261008.svg`: the application icon from `web/assets/brand/icon.svg`

Keep `index.html` and `download.html` identical. Use a new asset filename when replacing a cached production resource.

## Preview

From the repository root:

```sh
python3 -m http.server 8090 --directory website
# Open http://localhost:8090
```

Without release data, every download card links to GitHub Releases. On production, the mirror inserts this contract before `</head>`:

```js
window.__RELEASE__ = {
  version: 'X.Y.Z',
  assets: [{ name: 'package.dmg', os: 'mac', arch: 'arm64', ext: 'dmg', size: 123, url: 'https://example.com/package.dmg' }]
};
```

Platforms match **both OS and architecture**. Missing packages keep their Releases fallback; Intel never silently receives an ARM installer. Dynamic content is inserted using DOM text properties. Version and file metadata never become raw HTML.

## Recreate screenshots

Install the project dependencies and make Playwright plus its Chromium browser available in a separate tooling environment. Then:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright node scripts/capture-showcase.cjs
```

The script runs the real HTTP hub and UI with the test harness, renders demonstration content through the actual app renderers, and captures three 2160 × 1500 PNGs. It makes no model calls and does not read personal settings. Its dedicated `/tmp/ashub-showcase` directory must not already exist and is cleaned up on exit. The screenshots illustrate interface capabilities, not results of a real coding task or performance benchmarks.

## Production deployment

The Ubuntu host serves the page through Nginx → the `mirror` service. The service code is outside this repository.

- HTML template: `/opt/ashub-mirror/download.html`
- Static assets: `/opt/ashub-mirror/site/assets/`
- Fonts: `/opt/ashub-mirror/site/fonts/`
- Nginx maps the public root to the service's `/download/` route

Back up the template and affected assets first. Upload new, versioned assets before atomically replacing `download.html`. The service reads the template per request, so no service restart or Nginx change is needed. Keep release injection, updater routes and download routing intact.

After deployment, verify the live page, all four platform links, loaded images and fonts, keyboard tabs, clipboard success/failure, and mobile overflow. Rollback consists of atomically restoring the backed-up template; old assets should remain available for cached pages.

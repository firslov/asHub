# Website

The public site at https://ashub.aihao.world uses the same visual identity as the app: warm white, graphite and muted champagne. Static fonts and scripts are served locally.

## Files

- `index.html`: static preview, with working GitHub Releases download fallbacks
- `download.html`: the same page, used by the production mirror renderer
- `assets/site-20261024.css` / `assets/site-20261008.js`: layout and progressive enhancements
- `assets/showcase-workspace-0206-{en,zh}.jpg`: v0.20.6 main UI in English and Chinese
- `assets/showcase-*.png`: earlier v0.20.2 detail captures; all screenshots use isolated, illustrative demo data
- `assets/brand-20261008.svg`: the application icon from `web/assets/brand/icon.svg`

Keep `index.html` and `download.html` identical. Use a new asset filename when replacing a cached production resource.

The v0.20.8 overview covers opt-in background mode, dedicated plugin management and project conversation actions. Download versions come from the live release payload, independently of the overview.

Basic mobile access requires v0.20.5 or later. Project collaboration and thinking controls require v0.20.6 with the updated gateway. The phone graphic is a labeled HTML/CSS usage illustration, not a screenshot or a claim about real task results.

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

Start the isolated showcase server for each language:

```sh
SHOWCASE_LANG=en node scripts/showcase-server.cjs
SHOWCASE_LANG=zh node scripts/showcase-server.cjs
```

Open the printed URL in a browser, choose the matching interface language, switch the sidebar to Projects, and capture the main conversation at 1440 × 1000. Save the English and Chinese captures separately. The server uses the current Hub and UI with demo messages, makes no model calls, and removes its temporary project on shutdown. Do not use personal conversations for public screenshots.

## Production deployment

The Ubuntu host serves the page through Nginx → the `mirror` service. The service code is outside this repository.

- HTML template: `/opt/ashub-mirror/download.html`
- Static assets: `/opt/ashub-mirror/site/assets/`
- Fonts: `/opt/ashub-mirror/site/fonts/`
- Nginx maps the public root to the service's `/download/` route

Back up the template and affected assets first. Upload new, versioned assets before atomically replacing `download.html`. The service reads the template per request, so no service restart or Nginx change is needed. Keep release injection, updater routes and download routing intact.

After deployment, verify the live page, all four platform links, loaded images and fonts, keyboard tabs, clipboard success/failure, and mobile overflow. Rollback consists of atomically restoring the backed-up template; old assets should remain available for cached pages.

# asHub visual identity

The mark is an architectural H: two open frames joined by one bridge. The same geometry appears in app icons, welcome states and loading states. The title bar uses only the original vector wordmark.

- Graphite: `#272824`
- Warm white: `#F3F0E8`
- Champagne: `#C1A574` (light UI: `#A58B5D`)

`electron/icon.svg` is the application icon master, with a 32/512 outer inset. `icon.svg` here and `website/assets/favicon.svg` use tighter framing for small browser icons. `mark.svg` is the monochrome mark; `wordmark.svg` contains original paths and needs no font. UI copies inherit the theme text color.

Packaged outputs: `electron/icon.png` (1024 px), `electron/icon.ico` (16, 24, 32, 48, 64, 128, 256 px), `electron/icon.icns` (16 through 1024 px, including Retina representations). When revising the master, regenerate all three raster formats and keep the inline marks in `web/index.html` and the two website pages in sync.

# 图文展示 / Image display

Optional asHub plugin for showing useful images beside the explanation in a reply. No extra sidebar, configuration, model API or runtime dependency.

## Install

Requires an asHub build exposing the `image-resources` capability. Earlier released builds reject the package with a compatibility explanation.

Included as a local extension in asHub builds with this feature. Open **Plugins → Local extensions → 图文展示** and enable it; no ZIP installation is required. It stays optional and disabled by default, like the other included extensions. A manually installed copy takes precedence, and disabling or uninstalling it is respected across upgrades.

For a separate package installation, choose **Install from ZIP**. Restart asHub after installing if an existing conversation has already initialized its tools.

Try:

- “展示项目目录中的设计稿，比较两版布局”
- “把刚生成的趋势图放在分析结果旁边”
- “展示验证截图，并简要说明结果”

The `display_images` tool accepts 1–4 existing files and short captions. It returns Markdown references, which the model includes in its answer. The tool neither generates images nor understands their contents; use the model's image-reading tools for visual analysis. It does not automatically attach every tool screenshot.

## Scope and retention

- PNG, JPEG and static WebP; at most 8 MiB, 32 megapixels and 16,384 pixels per side.
- Only regular files inside the requesting conversation's current working directory. Outside-directory paths and escaping symlinks are rejected by the host.
- Files are copied to immutable conversation snapshots. Source edits/deletion do not break previous replies. A conversation retains up to 200 images / 256 MiB, deduplicated by content.
- Desktop and authorized remote users can view the same snapshots. Remote reads require current device, account and conversation-directory authorization.
- Disable/uninstall removes the tool; previously published images remain available with conversation history. Delete the conversation to remove its snapshots. Archiving retains them.
- No image bytes are placed in model context. The text references and captions still consume a small number of tokens. Viewing images using other tools can incur that model's normal image token cost.
- No external image proxy, arbitrary URLs, SVG, animated images, or directory-wide scanning. Other plugins remain responsible for screenshots and image creation.

The plugin uses the host's scoped service, not direct filesystem access. As with all agent-sh JavaScript extensions, plugin installation is a trusted-code mechanism, not an OS sandbox.

## Development

`node --test tests/*.mjs`

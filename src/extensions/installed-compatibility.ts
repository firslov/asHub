import type { NormalizedPluginManifest, PluginDeclarativeUI } from './manifest.js';

/** Legacy deprecation layer for previously distributed package presentation.
 *
 * The original browser ZIP exposed only a composer shortcut in its "browser"
 * panel; the native browser has since replaced that shortcut. Match that exact
 * legacy shape, not every browser panel or a guessed package version. Some old
 * ZIPs do not identify this UI revision through their package version.
 *
 * Retire this adapter when the minimum supported browser package no longer
 * contains that old panel; plugin upgrades replace the legacy manifests.
 * New plugins and UI behavior belong in their manifests, not in additional
 * package-ID exceptions.
 * This only adapts the discovery result; it never rewrites installed manifests.
 */
export function adaptInstalledApplicationUI(manifest: NormalizedPluginManifest): PluginDeclarativeUI | undefined {
  const ui = manifest.ui;
  if (!ui || manifest.id !== 'ashub-browser-automation') return ui;
  const panels = ui.panels.filter(panel => panel.id !== 'browser' || panel.components.length !== 1 ||
    panel.components[0].type !== 'action' || panel.components[0].action !== 'composer.insert' ||
    panel.components[0].value !== '打开网页 https://');
  if (panels.length === ui.panels.length) return ui;
  return panels.length ? { ...ui, panels } : undefined;
}

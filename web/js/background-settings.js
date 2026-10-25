import { lang, t } from './i18n.js';

const api = window.electronAPI;
const section = document.getElementById('desktop-background-settings');
if (api?.getBackgroundSettings && section) {
  section.hidden = false;
  const enabled = document.getElementById('desktop-background-enabled');
  const awake = document.getElementById('desktop-background-awake');
  const status = document.getElementById('desktop-background-status');
  let current = { enabled: false, preventSleep: false }, busy = false, loaded = false, failed = false;
  const render = () => {
    enabled.checked = current.enabled;
    awake.checked = current.preventSleep;
    enabled.disabled = busy || !loaded;
    awake.disabled = busy || !loaded || !current.enabled;
    status.textContent = failed ? t('background.error') : '';
    status.hidden = !failed;
  };
  const load = async () => {
    if (busy) return;
    busy = true; render();
    try { current = await api.getBackgroundSettings(); loaded = true; failed = false; }
    catch { failed = true; }
    finally { busy = false; render(); }
  };
  const change = async patch => {
    if (busy) return;
    busy = true; render();
    try {
      const result = await api.setBackgroundSettings(patch);
      current = result; failed = !result.ok;
    } catch { failed = true; }
    finally { busy = false; render(); }
  };
  enabled.addEventListener('change', () => change({ enabled: enabled.checked }));
  awake.addEventListener('change', () => change({ preventSleep: awake.checked }));
  api.onBackgroundSettings(value => { current = value; render(); });
  const syncLanguage = () => { render(); api.setBackgroundSettings({ language: lang.value }).catch(() => {}); };
  document.addEventListener('langchange', syncLanguage);
  document.getElementById('config-toggle')?.addEventListener('click', () => { if (failed) load(); });
  api.onOpenMobileAccess(async () => {
    await import('./mobile-access.js');
    if (document.getElementById('mobile-access-panel')?.hidden) document.getElementById('mobile-access-toggle')?.click();
  });
  load();
  syncLanguage();
  api.notifyDesktopReady();
}

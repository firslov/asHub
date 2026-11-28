import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { updateSettingsFile } from './settings-store.js';
export const DESKTOP_NAMESPACE = 'desktop-control';
export const ARC_REVISION = '6b353039111c08c2c64c5229083606941e364eaf';
export interface DesktopSettings { enabled: boolean; allowedApps: string[]; approvedApps?: string[]; captureBackend?: 'legacy' | 'screencapturekit' }
const isBundleId = (id: unknown): id is string => typeof id === 'string' && id.length <= 200 && /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(id);
const isAppList = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 100 && value.every(isBundleId);
export const defaults = (): DesktopSettings => ({ enabled: false, allowedApps: [] });
export function validateSettings(value: unknown): DesktopSettings {
  const c = value as DesktopSettings;
  if (!c || typeof c !== 'object' || Array.isArray(c) || typeof c.enabled !== 'boolean'
    || !isAppList(c.allowedApps) || (c.approvedApps !== undefined && !isAppList(c.approvedApps))
    || (c.captureBackend !== undefined && !['legacy', 'screencapturekit'].includes(c.captureBackend))
    || Object.keys(c).some(k => !['enabled', 'allowedApps', 'approvedApps', 'captureBackend'].includes(k))) throw Error('Invalid desktop-control settings');
  const allowedApps = [...new Set(c.allowedApps)];
  const approvedApps = c.enabled ? [...new Set(c.approvedApps)].filter(id => allowedApps.includes(id)) : [];
  return { enabled: c.enabled, allowedApps, ...(approvedApps.length ? { approvedApps } : {}), ...(c.captureBackend === undefined ? {} : { captureBackend: c.captureBackend }) };
}
export function readDesktopSettings(file: string): DesktopSettings {
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return defaults(); throw e; }
  return data[DESKTOP_NAMESPACE] === undefined ? defaults() : validateSettings(data[DESKTOP_NAMESPACE]);
}
export function settingsRevision(c: DesktopSettings): string {
  return createHash('sha256').update(JSON.stringify(c)).digest('hex');
}
export function writeDesktopSettings(file: string, value: unknown, revision: unknown): DesktopSettings {
  const c = validateSettings(value);
  updateSettingsFile(file, data => {
    const old = data[DESKTOP_NAMESPACE] === undefined ? defaults() : validateSettings(data[DESKTOP_NAMESPACE]);
    if (revision !== settingsRevision(old)) throw Object.assign(Error('Configuration changed; refresh before saving'), { status: 409 });
    data[DESKTOP_NAMESPACE] = c; return data;
  });
  return c;
}

// Optional installation activity, independent of the updater. No content or paths.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HOUR = 60 * 60 * 1000;
const day = (time) => new Date(time + 8 * HOUR).toISOString().slice(0, 10);

function createUsageReporter({ userData, version, platform = process.platform, arch = process.arch,
  isActive = () => false, endpoint = 'https://mirror.aihao.world/api/activity',
  fileSystem = fs, transport = https, now = Date.now, disabled = false }) {
  const preferences = path.join(userData, 'usage-preferences.json');
  let enabled = !disabled;
  try { enabled = !disabled && JSON.parse(fileSystem.readFileSync(preferences, 'utf8')).enabled === true; }
  catch (error) { if (error.code !== 'ENOENT') enabled = false; }
  let installId;
  let lastSuccess = 0, retryAt = 0, pending = null, timer = null, stopped = false;
  function getInstallId() {
    if (installId !== undefined) return installId;
    const file = path.join(userData, '.install-id');
    try { const id = fileSystem.readFileSync(file, 'utf8').trim(); if (UUID.test(id)) return installId = id; }
    catch (error) { if (error.code !== 'ENOENT') return installId = ''; }
    try {
      const id = crypto.randomUUID();
      fileSystem.mkdirSync(userData, { recursive: true });
      fileSystem.writeFileSync(file + '.tmp', id, { mode: 0o600 });
      fileSystem.renameSync(file + '.tmp', file);
      return installId = id;
    } catch { return installId = ''; } // Never invent a new counted installation on each restart.
  }
  function setEnabled(value) {
    if (disabled) return { ok: false, enabled: false };
    const next = value === true;
    try {
      fileSystem.mkdirSync(userData, { recursive: true });
      fileSystem.writeFileSync(preferences + '.tmp', JSON.stringify({ enabled: next }), { mode: 0o600 });
      fileSystem.renameSync(preferences + '.tmp', preferences);
      enabled = next;
      if (!enabled && pending) pending.destroy();
      return { ok: true, enabled };
    } catch { return { ok: false, enabled }; }
  }
  function tick() {
    const time = now();
    if (stopped || !enabled || pending || time < retryAt || !isActive() ||
        (lastSuccess && day(time) === day(lastSuccess) && time - lastSuccess < HOUR)) return;
    const clientId = getInstallId();
    if (!clientId) return;
    let deadline;
    try {
      const body = JSON.stringify({ clientId, version, platform, arch });
      const req = transport.request(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body), 'User-Agent': `asHub/${version}` },
      }, res => {
        res.on('error', () => req.destroy());
        res.resume();
        if (res.statusCode === 204) { lastSuccess = now(); retryAt = 0; }
        else retryAt = now() + 15 * 60 * 1000;
        req.destroy();
      });
      pending = req;
      const finish = () => { clearTimeout(deadline); if (pending === req) pending = null; };
      req.on('error', () => { retryAt = now() + 15 * 60 * 1000; finish(); });
      req.on('close', finish);
      // Absolute deadline also covers DNS/TLS stalls; never block app startup or quit.
      deadline = setTimeout(() => req.destroy(new Error('activity timeout')), 5000);
      deadline.unref?.();
      req.end(body);
    } catch { retryAt = now() + 15 * 60 * 1000; clearTimeout(deadline); pending = null; }
  }
  return {
    get enabled() { return enabled; }, getInstallId, setEnabled, tick,
    start() { if (timer) return; stopped = false; timer = setInterval(tick, 60 * 1000); timer.unref?.(); },
    stop() { stopped = true; clearInterval(timer); timer = null; pending?.destroy(); },
  };
}
module.exports = { createUsageReporter };

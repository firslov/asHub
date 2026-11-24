import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import type { McpResult } from './mcp.js';
export const supportsModernCapture = () => process.platform === 'darwin' && Number(os.release().split('.')[0]) >= 23;
/** One bounded, cancellable helper per capture; never discovers or captures another target. */
export async function captureWindow(pid: number, windowId: number, signal: AbortSignal): Promise<McpResult> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = execFile(fileURLToPath(new URL('../native/capture', import.meta.url)), [String(pid), String(windowId)],
      { signal, timeout: 15000, maxBuffer: 24 * 1024 * 1024, encoding: 'utf8', killSignal: 'SIGKILL' }, (error, stdout) => {
        if (signal.aborted) { reject(Error('Window capture cancelled')); return; }
        let value: any;
        try { value = JSON.parse(stdout); if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid capture response'); } catch { reject(Error('Window capture helper failed or timed out. Reinstall desktop-control if its native capture component is missing.')); return; }
        if (error || value.error) { reject(Error(`Window capture [${value.error || 'failed'}]: ${value.message || 'No image was accepted'}`)); return; }
        const c = value.screenshot;
        if (!c || c.pid !== pid || c.window_id !== windowId || !Number.isInteger(c.width) || c.width <= 0 || !Number.isInteger(c.height) || c.height <= 0 || c.width > 1568 || c.height > 1568 || !Number.isFinite(c.scale) || c.scale <= 0 || typeof value.png !== 'string' || !value.png.startsWith('iVBORw0KGgo')) {
          reject(Error('Window capture returned an invalid target, geometry or PNG')); return;
        }
        resolve({ structuredContent: { screenshot: c }, content: [{ type: 'image', mimeType: 'image/png', data: value.png }] });
      });
    // execFile handles cancellation and waits for process closure before its callback.
    child.stdin?.end();
  });
}

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
export interface McpResult { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; structuredContent?: any; isError?: boolean }
export interface DriverClient { call(name: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<McpResult>; close(): Promise<void> }
const cancelled = () => Object.assign(Error('Desktop operation cancelled. An action already sent may have completed; observe before retrying.'), { name: 'AbortError' });
/** Small bounded MCP stdio client. No shell, TCP listener, or model-selected command. */
export class StdioDriver implements DriverClient {
  private process: ChildProcessWithoutNullStreams;
  private pending = new Map<string, { resolve: (r: any) => void; reject: (e: Error) => void; cleanup: () => void }>();
  private ready: Promise<void>;
  private buffer = '';
  private stopped = false;
  private ended = false;
  private closing?: Promise<void>;
  constructor(command: string, args: string[], private timeoutMs = 30_000) {
    const env = { ...process.env }; delete env.PYTHONPATH; delete env.PYTHONHOME;
    this.process = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.process.stdout.setEncoding('utf8');
    this.process.stdout.on('data', text => this.receive(text));
    // Do not persist stderr: third-party diagnostics can contain screen contents.
    this.process.stderr.resume();
    this.process.stdin.on('error', () => this.fail(Error('Desktop driver input closed')));
    this.process.on('error', () => this.fail(Error('Could not start desktop component; check /desktop status and reinstall the component if needed')));
    this.process.on('close', () => { this.ended = true; });
    this.process.on('exit', () => this.fail(Error('Desktop driver exited; observe again before retrying any action')));
    this.ready = this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ashub-desktop-control', version: '1.0.0' } })
      .then(r => { if (!r?.capabilities?.tools) throw Error('Driver does not expose MCP tools'); this.notify('notifications/initialized', {}); })
      .catch(async e => { void this.close(); throw e; });
    void this.ready.catch(() => {});
  }
  private receive(text: string): void {
    this.buffer += text;
    if (Buffer.byteLength(this.buffer) > 24 * 1024 * 1024) { this.fail(Error('Desktop driver response too large')); void this.close(); return; }
    let end;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) throw Error('Expected a protocol object');
      } catch { this.fail(Error('Invalid desktop driver response')); void this.close(); return; }
      const p = this.pending.get(String(msg.id)); if (!p) continue;
      this.pending.delete(String(msg.id)); p.cleanup();
      if (msg.error) p.reject(Error('Desktop driver protocol error: ' + String(msg.error.message || 'unknown')));
      else p.resolve(msg.result);
    }
  }
  private notify(method: string, params: unknown): void {
    if (!this.stopped && this.process.stdin.writable) this.process.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }
  private request(method: string, params: unknown, signal?: AbortSignal): Promise<any> {
    if (this.stopped) return Promise.reject(Error('Desktop driver is closed'));
    if (signal?.aborted) return Promise.reject(cancelled());
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const abort = () => {
        if (!this.pending.delete(id)) return;
        this.notify('notifications/cancelled', { requestId: id, reason: 'Cancelled by asHub' }); cleanup(); reject(cancelled());
      };
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        this.notify('notifications/cancelled', { requestId: id, reason: 'Deadline exceeded' }); cleanup();
        reject(Error('Desktop driver timed out. The action may have completed; observe before retrying.'));
        // Do not allow an unresponsive process to execute queued mutations later.
        void this.close();
      }, this.timeoutMs);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      this.pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener('abort', abort, { once: true });
      this.process.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      if (signal?.aborted) abort();
    });
  }
  async call(name: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<McpResult> {
    if (signal?.aborted) throw cancelled();
    if (signal) {
      await new Promise<void>((resolve, reject) => {
        const abort = () => { cleanup(); reject(cancelled()); };
        const cleanup = () => signal.removeEventListener('abort', abort);
        signal.addEventListener('abort', abort, { once: true });
        this.ready.then(() => { cleanup(); resolve(); }, e => { cleanup(); reject(e); });
        if (signal.aborted) abort();
      });
    } else await this.ready;
    const result = await this.request('tools/call', { name, arguments: args }, signal);
    if (!result || !Array.isArray(result.content)) throw Error('Invalid desktop tool result');
    return result;
  }
  private fail(error: Error): void {
    this.stopped = true;
    for (const p of this.pending.values()) { p.cleanup(); p.reject(error); }
    this.pending.clear();
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.fail(Error('Desktop driver closed'));
    this.closing = new Promise(resolve => {
      if (this.ended || !this.process.pid || this.process.exitCode !== null || this.process.signalCode !== null) { resolve(); return; }
      let kill: ReturnType<typeof setTimeout>;
      const term = setTimeout(() => {
        this.process.kill('SIGTERM');
        kill = setTimeout(() => this.process.kill('SIGKILL'), 2000); kill.unref();
      }, 2000); term.unref();
      this.process.once('close', () => { clearTimeout(term); clearTimeout(kill); resolve(); });
      // EOF lets arc restore parked windows. Killing immediately cannot do that.
      this.process.stdin.end();
    });
    return this.closing;
  }
}
export function dataOf(result: McpResult): any {
  if (result.isError) throw Error(result.structuredContent?.message || result.content.filter(c => c.type === 'text').map(c => c.text).join('\n') || 'Desktop action failed');
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  return JSON.parse(text);
}

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApplicationExtensionDefinition } from '../extensions/application.js';
import { RemoteConnector } from './connector.js';

/** The Hub injects one connector; application toggles reuse its identity and
 * durable receipts without touching connection-level authorization settings. */
export class MobileAccessExtension {
  private port: number | undefined;
  private active = false;
  readonly definition: ApplicationExtensionDefinition;

  constructor(private readonly connector: RemoteConnector) {
    this.definition = {
      id: 'mobile-access', name: '移动访问', scope: 'application',
      create: context => {
        if (context.signal.aborted) throw new Error('Mobile access activation cancelled');
        if (this.active) throw new Error('Mobile access is already active');
        if (this.port === undefined) throw new Error('Mobile access requires the Hub listening port');
        let stopping: Promise<void> | undefined;
        const stop = () => {
          if (stopping) return stopping;
          // Closing admission and the socket happens before the first await.
          this.active = false;
          return stopping = (async () => {
            this.connector.close();
            await this.connector.drain();
          })();
        };
        // Abort dispatch cannot await promises. The same rejection is retained
        // for stop/onDispose so the registry reports cleanup failures.
        const aborted = () => { void stop().catch(() => {}); };
        context.signal.addEventListener('abort', aborted, { once: true });
        context.onDispose(() => {
          context.signal.removeEventListener('abort', aborted);
          return stop();
        });
        this.active = true;
        try { this.connector.start(this.port); }
        catch (error) { void stop(); throw error; }
        return { stop, canStop: () => !this.connector.isBusy() };
      },
    };
  }

  start(port: number): void {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local port');
    if (this.active) this.connector.start(port);
    this.port = port;
  }

  status() {
    return { ...this.connector.status(), featureEnabled: this.active,
      ...(!this.active ? { enabled: false, status: 'disabled' } : {}) };
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reply = (status: number, value: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    // The existing Hub Origin/Host gate remains responsible for request origin.
    if (req.headers['x-ashub-local'] !== '1') { reply(403, { error: 'Local application request required' }); return; }
    if (req.method === 'GET' && req.url === '/api/mobile') { reply(200, this.status()); return; }
    if (!this.active) { reply(409, { error: '移动访问功能已停用', featureEnabled: false }); return; }
    await this.connector.handle(req, res);
  }
}

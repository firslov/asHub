import type { IncomingMessage } from 'node:http';

/** Cancellation belongs to the transport: an unfinished upload must not keep
 * application shutdown waiting, or become a new command after shutdown. Once
 * the complete body has been handed to a service, its accepted effects drain. */
export function readBodyWithSignal(req: IncomingMessage, read: (request: IncomingMessage) => Promise<string>, signal?: AbortSignal): Promise<string> {
  if (!signal) return read(req);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result: { body: string } | { error: unknown }) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      req.removeListener('aborted', cancel);
      req.removeListener('error', cancel);
      req.removeListener('close', onClose);
      if ('error' in result) reject(result.error); else resolve(result.body);
    };
    const cancel = () => finish({ error: Object.assign(new Error('Request body cancelled'), { status: 503 }) });
    const onClose = () => { if (!req.complete && !req.readableEnded) cancel(); };
    const abort = () => {
      cancel();
      // Reject admission before closing the socket. A parser that ignores
      // stream cancellation may resolve later; finish will discard its result.
      if (!req.complete && !req.readableEnded) {
        try { req.destroy(); } catch { /* Transport already closed. */ }
      }
    };
    signal.addEventListener('abort', abort, { once: true });
    req.once('aborted', cancel);
    req.once('error', cancel);
    req.once('close', onClose);
    if (signal.aborted) { abort(); return; }
    if (req.destroyed && !req.complete && !req.readableEnded) { cancel(); return; }
    Promise.resolve().then(() => {
      if (settled) return;
      signal.throwIfAborted();
      return read(req);
    }).then(body => { if (!settled) finish({ body: body! }); }, error => finish({ error }));
  });
}

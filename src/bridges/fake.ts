/**
 * FakeBridge — emits a canned response and resolves submit() without
 * calling any model.  Exists to exercise hub + RemoteBridge turn
 * lifecycle in tests without burning API credits.
 */
import { EventEmitter } from "node:events";
import type { Bridge, BridgeOpts, BusEvent, ContextSnapshot, ContextStrategy, SessionKind } from "./types.js";

export interface FakeBridgeOpts extends BridgeOpts {
  /** ms before submit() resolves; default 50. */
  turnDelayMs?: number;
}

export class FakeBridge extends EventEmitter implements Bridge {
  readonly kind?: SessionKind;
  private closed = false;
  private processing = false;
  private turnDelayMs: number;

  constructor(opts: FakeBridgeOpts) {
    super();
    this.kind = opts.kind;
    this.turnDelayMs = opts.turnDelayMs ?? 50;
    queueMicrotask(() => {
      this.emit("event", {
        name: "agent:info",
        payload: { name: "fake", version: "0", model: "fake-model", provider: "fake", thinkingLevel: "off", thinkingSupported: false },
      } satisfies BusEvent);
    });
  }

  ready(): Promise<void> { return Promise.resolve(); }
  isProcessing(): boolean { return this.processing; }

  async submit(text: string): Promise<{ stopReason: string }> {
    if (this.closed) throw new Error("bridge closed");
    this.processing = true;
    this.emit("event", {
      name: "agent:response-chunk",
      payload: { blocks: [{ type: "text", text: `[fake echo] ${text}` }] },
    } satisfies BusEvent);
    await new Promise<void>((resolve) => setTimeout(resolve, this.turnDelayMs));
    this.emit("event", {
      name: "agent:usage",
      payload: { prompt_tokens: text.length, completion_tokens: 8 },
    } satisfies BusEvent);
    this.processing = false;
    return { stopReason: "end_turn" };
  }

  cancel(): void {
    if (!this.processing) return;
    this.processing = false;
    this.emit("event", { name: "agent:cancelled", payload: {} } satisfies BusEvent);
  }

  async autocomplete(): Promise<Array<{ name: string; description: string }> | null> { return []; }

  async snapshot(): Promise<ContextSnapshot> {
    return { messages: [], contextWindow: 0, activeTokens: 0 };
  }

  async compact(_strategy: ContextStrategy): Promise<{ before: number; after: number; evictedCount: number } | null> {
    return { before: 0, after: 0, evictedCount: 0 };
  }

  async getModels(): Promise<{ models: Array<{ model: string; provider: string }>; active: { model: string; provider: string } | null }> {
    return { models: [{ model: "fake-model", provider: "fake" }], active: { model: "fake-model", provider: "fake" } };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("closed");
  }

  onEvent(fn: (e: BusEvent) => void): () => void {
    this.on("event", fn);
    return () => this.off("event", fn);
  }
  onClose(fn: () => void): () => void {
    this.on("closed", fn);
    return () => this.off("closed", fn);
  }
  onError(fn: (err: Error) => void): () => void {
    this.on("error", fn);
    return () => this.off("error", fn);
  }
}

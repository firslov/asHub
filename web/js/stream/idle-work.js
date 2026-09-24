/**
 * Cooperative idle-work scheduler.
 *
 * Processes an array of work items in small batches using requestIdleCallback,
 * yielding to the event loop between batches so the main thread stays responsive
 * even while processing thousands of code blocks / math expressions after replay.
 *
 * Falls back to requestAnimationFrame → setTimeout(0) when requestIdleCallback
 * is unavailable (e.g. Electron < 29, Safari).
 */

const BATCH_SIZE = 4;

/**
 * @param {Array} items
 * @param {(item: any, index: number) => void} processFn
 * @param {object} [opts]
 * @param {number} [opts.batchSize=4]
 * @param {(done: number, total: number) => void} [opts.onProgress]
 * @param {() => void} [opts.onComplete]
 * @param {AbortSignal} [opts.signal] Abort to stop processing future batches.
 * @returns {{ cancel: () => void, readonly cancelled: boolean }}
 *   Handle for cancelling the remaining batches.  Items that are DOM nodes
 *   detached since queueing (view destroyed, stream cleared) are skipped
 *   automatically, so callers on a hot path don't need the handle.
 */
export function scheduleIdleWork(items, processFn, opts = {}) {
  const { batchSize = BATCH_SIZE, onProgress, onComplete, signal } = opts;

  let cancelled = false;
  const onAbort = () => handle.cancel();
  const handle = {
    cancel() {
      if (cancelled) return;
      cancelled = true;
      signal?.removeEventListener?.("abort", onAbort);
    },
    get cancelled() { return cancelled; },
  };

  if (!items || items.length === 0) {
    onComplete?.();
    return handle;
  }

  if (signal) {
    if (signal.aborted) { cancelled = true; return handle; }
    signal.addEventListener("abort", onAbort, { once: true });
  }

  let index = 0;
  const total = items.length;

  const runBatch = (deadline) => {
    if (cancelled) return;
    // Process items until time runs out or batch is complete.
    const end = Math.min(index + batchSize, total);
    while (index < end) {
      // If we have a deadline hint and are out of time, yield early.
      if (deadline && deadline.timeRemaining && deadline.timeRemaining() <= 1) break;
      const item = items[index];
      index++;
      // Skip DOM nodes that were detached after this batch was queued
      // (e.g. the tab was closed right after replay flushed) — running
      // processFn on them would do invisible work and keep the whole
      // detached subtree alive until the queue drains.
      if (typeof Node !== "undefined" && item instanceof Node && !item.isConnected) continue;
      try {
        processFn(item, index - 1);
      } catch {
        // Swallow per-item errors so one bad block doesn't stall the whole queue.
      }
    }

    onProgress?.(index, total);

    if (index < total) {
      scheduleNext(runBatch);
    } else {
      signal?.removeEventListener?.("abort", onAbort);
      onComplete?.();
    }
  };

  scheduleNext(runBatch);
  return handle;
}

function scheduleNext(fn) {
  if (typeof requestIdleCallback === "function") {
    // Timeout ensures we don't wait forever if the page is constantly busy.
    requestIdleCallback(fn, { timeout: 100 });
  } else if (typeof requestAnimationFrame === "function") {
    // rAF as first fallback — yields between frames.
    requestAnimationFrame(() => setTimeout(() => fn({ timeRemaining: () => 50 }), 0));
  } else {
    setTimeout(() => fn({ timeRemaining: () => 50 }), 0);
  }
}

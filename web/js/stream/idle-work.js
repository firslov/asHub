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
 */
export function scheduleIdleWork(items, processFn, opts = {}) {
  const { batchSize = BATCH_SIZE, onProgress, onComplete } = opts;

  if (!items || items.length === 0) {
    onComplete?.();
    return;
  }

  let index = 0;
  const total = items.length;

  const runBatch = (deadline) => {
    // Process items until time runs out or batch is complete.
    const end = Math.min(index + batchSize, total);
    while (index < end) {
      // If we have a deadline hint and are out of time, yield early.
      if (deadline && deadline.timeRemaining && deadline.timeRemaining() <= 1) break;
      try {
        processFn(items[index], index);
      } catch {
        // Swallow per-item errors so one bad block doesn't stall the whole queue.
      }
      index++;
    }

    onProgress?.(index, total);

    if (index < total) {
      scheduleNext(runBatch);
    } else {
      onComplete?.();
    }
  };

  scheduleNext(runBatch);
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

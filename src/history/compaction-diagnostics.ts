import * as fs from "node:fs";
import path from "node:path";

export interface CompactionDiagnostic {
  outcome: "unchanged" | "applied" | "cancelled" | "stale" | "failed";
  reason?: "below-target" | "insufficient-savings" | "summary-invalid" | "summary-unavailable" | "summary-too-large";
  mode?: "semantic" | "fallback";
  sourceLeaf?: string;
  revision?: number;
  before?: number;
  after?: number;
  target?: number;
  inputTokens?: number;
  elapsedMs?: number;
}

/** Allowlisted metadata only. Never log prompts, generated text, paths, URLs,
 * keys or arbitrary exception strings. Failure cannot affect the conversation. */
export function logCompaction(directory: string, sessionId: string, event: CompactionDiagnostic): void {
  if (!/^[\w-]{1,80}$/.test(sessionId) || !["unchanged", "applied", "cancelled", "stale", "failed"].includes(event.outcome)) return;
  const row: Record<string, unknown> = { ts: new Date().toISOString(), sessionId, outcome: event.outcome };
  if (event.reason && ["below-target", "insufficient-savings", "summary-invalid", "summary-unavailable", "summary-too-large"].includes(event.reason)) row.reason = event.reason;
  if (event.mode === "semantic" || event.mode === "fallback") row.mode = event.mode;
  if (event.sourceLeaf && /^[\w-]{1,80}$/.test(event.sourceLeaf)) row.sourceLeaf = event.sourceLeaf;
  for (const key of ["revision", "before", "after", "target", "inputTokens", "elapsedMs"] as const) {
    const n = event[key];
    if (typeof n === "number" && Number.isFinite(n) && n >= 0) row[key] = Math.round(n);
  }
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, "compaction.jsonl");
    if (fs.existsSync(file) && fs.statSync(file).size >= 2 * 1024 * 1024) {
      fs.rmSync(`${file}.1`, { force: true }); fs.renameSync(file, `${file}.1`);
    }
    fs.appendFileSync(file, JSON.stringify(row) + "\n", { mode: 0o600 });
  } catch { /* Diagnostics are best effort. */ }
}

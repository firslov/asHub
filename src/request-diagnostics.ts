import * as fs from "node:fs";
import path from "node:path";

export type RequestPhase = "request" | "headers" | "streaming" | "complete" | "error" | "cancelled" | "unobserved";
export interface RequestDiagnostic {
  requestId: string;
  phase: RequestPhase;
  elapsedMs: number;
  requestBytes?: number;
  responseBytes?: number;
  status?: number;
  code?: string;
}
export type RequestStatus = { phase: "sending" | "waiting" | "retrying" | "clear" };
const phases = new Set<RequestPhase>(["request", "headers", "streaming", "complete", "error", "cancelled", "unobserved"]);
const codes = new Set(["ERR_HTTP2_PROTOCOL_ERROR", "ERR_CONNECTION_RESET", "ERR_CONNECTION_CLOSED", "ERR_TIMED_OUT", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET", "STREAM_ENDED", "HTTP_ERROR", "UPSTREAM_ERROR", "NETWORK_ERROR", "UPSTREAM_HEADERS_TIMEOUT", "UPSTREAM_IDLE_TIMEOUT", "REQUEST_TIMEOUT", "OBSERVATION_LIMIT"]);
export function requestErrorCode(error: unknown): string {
  const err = error as { code?: unknown; message?: unknown; cause?: { code?: unknown } } | null;
  for (const code of [err?.code, err?.cause?.code]) if (typeof code === "string" && codes.has(code)) return code;
  const message = typeof err?.message === "string" ? err.message : "";
  for (const code of codes) if (message.includes(code)) return code;
  return "NETWORK_ERROR";
}

/** Both the kernel's deadlines and a user stopping the turn abort fetch.
 * Preserve the deadline cause even when Chromium reports only AbortError. */
export function requestFailure(error: unknown, signal?: AbortSignal | null): { phase: "error" | "cancelled"; code?: string } {
  const reason = (signal?.aborted ? signal.reason : error) as { name?: string; message?: unknown } | undefined;
  if (reason?.name === "TimeoutError") return { phase: "error", code: "REQUEST_TIMEOUT" };
  const timeout = typeof reason?.message === "string"
    ? /^Codex upstream timed out waiting for (response headers|stream data) after \d+(?:\.\d+)?s$/.exec(reason.message) : null;
  if (timeout) return { phase: "error", code: timeout[1] === "response headers" ? "UPSTREAM_HEADERS_TIMEOUT" : "UPSTREAM_IDLE_TIMEOUT" };
  return signal?.aborted ? { phase: "cancelled" } : { phase: "error", code: requestErrorCode(error) };
}

/** A small rotating log with a strict schema. No URL, prompt, model output,
 * headers, file paths or arbitrary error messages may enter this file. */
export function logRequest(directory: string, sessionId: string, attempt: number, event: RequestDiagnostic): void {
  if (!/^[\w-]{1,80}$/.test(sessionId) || !/^[\w-]{1,80}$/.test(event.requestId) || !phases.has(event.phase)) return;
  const row: Record<string, unknown> = { ts: new Date().toISOString(), sessionId, requestId: event.requestId, phase: event.phase };
  for (const [key, value] of Object.entries({ attempt, elapsedMs: event.elapsedMs, requestBytes: event.requestBytes, responseBytes: event.responseBytes, status: event.status })) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) row[key] = Math.round(value);
  }
  if (event.code && codes.has(event.code)) row.code = event.code;
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, "requests.jsonl");
    if (fs.existsSync(file) && fs.statSync(file).size >= 2 * 1024 * 1024) {
      fs.rmSync(`${file}.1`, { force: true });
      fs.renameSync(file, `${file}.1`);
    }
    fs.appendFileSync(file, JSON.stringify(row) + "\n", { mode: 0o600 });
  } catch { /* Diagnostics must never interrupt a model request. */ }
}

/** UI state belongs to one main-agent turn. Late cancellation/completion from
 * an old request cannot change another turn or another conversation. */
export class RequestMonitor {
  private active = false;
  private current = "";
  private attempt = 1;
  private phase: RequestStatus["phase"] = "clear";
  private attempts = new Map<string, number>();
  constructor(private directory: string, private sessionId: string, private publish: (status: RequestStatus) => void) {}
  private show(phase: RequestStatus["phase"]): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.publish({ phase });
  }
  begin(): void { this.active = true; this.current = ""; this.attempt = 1; this.phase = "clear"; }
  end(): void { this.active = false; this.current = ""; this.phase = "clear"; }
  output(): void { if (this.active && this.current) this.show("clear"); }
  retry(message: unknown): boolean {
    // Match only the kernel's main-loop retry notice, never arbitrary UI text.
    if (!this.active || !this.current || typeof message !== "string") return false;
    const match = /^\((?:rate limited|error (?:\d{3}|network)), retrying in \d+s — attempt (\d+)\/(\d+)\)$/.exec(message);
    if (!match) return false;
    this.attempt = Number(match[1]);
    this.show("retrying");
    return true;
  }
  observe(event: RequestDiagnostic): void {
    if (event.phase === "request") {
      // Retain an old request's attempt until its asynchronous cancel settles.
      // Bound bookkeeping even if an abandoned response is never consumed.
      if (this.attempts.size >= 64) this.attempts.delete(this.attempts.keys().next().value!);
      this.attempts.set(event.requestId, this.attempt);
      if (this.active) this.current = event.requestId;
    }
    logRequest(this.directory, this.sessionId, this.attempts.get(event.requestId) ?? 1, event);
    if (this.active && this.current === event.requestId) {
      if (event.phase === "request") this.show("sending");
      else if (event.phase === "headers") this.show("waiting");
      else if (event.phase === "complete") { this.show("clear"); this.attempt = 1; this.current = ""; }
      // An oversized terminal may have completed a tool round. Default the
      // next request to a fresh attempt; an explicit kernel retry notice will
      // still override it. Retain current so that notice remains recognizable.
      else if (event.phase === "unobserved") this.attempt = 1;
    }
    if (["complete", "error", "cancelled", "unobserved"].includes(event.phase)) this.attempts.delete(event.requestId);
  }
}

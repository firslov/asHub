// Additive host invalidations refresh the existing read models. Conversation
// streams and editor state remain owned by their current modules.
const LEGACY_STATUSES = new Set([404, 405, 501]);
const ALL_DOMAINS = ["sessions", "projects", "network", "extensions", "configuration"];
const versionOf = value => value && value.version === 1 && typeof value.epoch === "string" && value.epoch.length > 0
  && Number.isSafeInteger(value.revision) && value.revision >= 0
  ? { epoch: value.epoch, revision: value.revision } : null;

/** Dependencies are injectable so reconciliation can be tested without a DOM,
 * live user sessions, or a browser's implicit EventSource reconnect behavior. */
export function createHostSync({
  fetch: request = globalThis.fetch?.bind(globalThis),
  createEventSource = url => new EventSource(url),
  onInvalidate = () => {},
  onError = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  delay = 40,
  retryDelay = 3000,
} = {}) {
  let running = false, legacy = false, generation = 0, controller = null, source = null;
  let timer = null, discovering = false, reading = false, pending = false;
  let observed = null, applied = null, reason = "connect";
  let domains = new Set();

  const current = gen => running && gen === generation;
  const cancelTimer = () => { if (timer !== null) clearTimer(timer); timer = null; };
  const closeSource = () => { source?.close(); source = null; };
  const fallback = () => {
    legacy = true; pending = false; domains.clear(); cancelTimer(); closeSource();
    controller?.abort();
  };
  const retry = gen => {
    if (!current(gen) || legacy || timer !== null) return;
    timer = setTimer(() => { timer = null; if (current(gen)) void (source ? readSnapshot(gen) : discover(gen)); }, retryDelay);
  };
  const report = error => { try { onError(error); } catch {} };
  const json = async (path, gen) => {
    const res = await request(path, { cache: "no-store", signal: controller.signal });
    if (!current(gen)) return null;
    if (LEGACY_STATUSES.has(res.status)) { fallback(); return null; }
    if (!res.ok) throw new Error(`Host synchronization: HTTP ${res.status}`);
    return res.json();
  };
  const schedule = (nextReason, kinds = ALL_DOMAINS) => {
    if (!running || legacy) return;
    reason = nextReason; pending = true;
    for (const kind of kinds) domains.add(kind);
    if (reading || timer !== null) return;
    const gen = generation;
    timer = setTimer(() => { timer = null; if (current(gen)) void readSnapshot(gen); }, delay);
  };
  const receive = (event, ready = false) => {
    if (!running || legacy) return;
    let data; try { data = JSON.parse(event.data); } catch { schedule("invalid-event"); return; }
    const next = versionOf(data);
    if (!next) { schedule("invalid-event"); return; }
    const changedEpoch = observed && observed.epoch !== next.epoch;
    if (!changedEpoch && observed && next.revision <= observed.revision) return;
    const gap = observed && !changedEpoch && next.revision > observed.revision + 1;
    observed = next;
    const kinds = typeof data.kind === "string" && ALL_DOMAINS.includes(data.kind) ? [data.kind] : ALL_DOMAINS;
    schedule(changedEpoch ? "epoch" : gap ? "gap" : ready ? "ready" : "invalidation",
      ready || changedEpoch || gap ? ALL_DOMAINS : kinds);
  };
  async function readSnapshot(gen) {
    if (!current(gen) || legacy || reading) return;
    reading = true; pending = false;
    try {
      const snapshot = await json("/api/host/snapshot", gen);
      if (!current(gen) || legacy) return;
      const next = versionOf(snapshot);
      if (!next) throw new Error("Invalid host snapshot version");
      // An event may have advanced the host while this read was in flight.
      // Never publish the stale read; coalesce its successor into one read.
      if (observed && (next.epoch !== observed.epoch || next.revision < observed.revision)) {
        pending = true;
      } else {
        // A snapshot can overtake the event stream on another connection.
        // Its unseen revisions may concern any domain; delayed frames at those
        // revisions will be ignored after this version becomes authoritative.
        const unseenChanges = observed && next.revision > observed.revision;
        observed = next; applied = next;
        const change = { ...next, reason, domains: !unseenChanges && domains.size ? [...domains] : [...ALL_DOMAINS] };
        domains.clear(); pending = false;
        onInvalidate(change);
      }
    } catch (error) {
      if (current(gen) && !legacy) { pending = true; report(error); retry(gen); }
    } finally {
      if (current(gen)) {
        reading = false;
        if (pending && !legacy && timer === null) schedule("reconcile");
      }
    }
  }
  async function discover(gen) {
    if (!current(gen) || legacy || discovering) return;
    discovering = true;
    try {
      const capabilities = await json("/api/host/capabilities", gen);
      if (!current(gen) || legacy) return;
      if (capabilities?.version !== 1 || capabilities?.hostApi !== 1
        || !capabilities.queries?.includes("snapshot") || capabilities.events?.transport !== "sse"
        || capabilities.events?.path !== "/api/host/events") throw new Error("Unsupported host synchronization capabilities");
      source = createEventSource("/api/host/events");
      const connection = source;
      const active = () => current(gen) && connection === source;
      source.addEventListener("open", () => { if (active()) { cancelTimer(); schedule("connect"); } });
      source.addEventListener("snapshot", event => { if (active()) receive(event, true); });
      source.addEventListener("invalidation", event => { if (active()) receive(event); });
      source.addEventListener("error", () => {
        // EventSource retries ordinary disconnects. A CLOSED source (e.g.
        // auth/service failure) needs fresh capability discovery on retry.
        if (!active()) return;
        if (connection.readyState === 2) { closeSource(); cancelTimer(); retry(gen); }
      });
      schedule("connect");
    } catch (error) { if (current(gen) && !legacy) { report(error); retry(gen); } }
    finally { if (current(gen)) discovering = false; }
  }
  return {
    start() {
      if (running || legacy || typeof request !== "function") return;
      running = true; const gen = ++generation; controller = new AbortController();
      return discover(gen);
    },
    stop() {
      running = false; ++generation; cancelTimer(); closeSource(); controller?.abort();
      discovering = reading = pending = false; domains.clear(); observed = applied = null;
    },
    get state() { return { running, legacy, observed: observed && { ...observed }, applied: applied && { ...applied } }; },
  };
}

let desktopSync = null;
export function initializeHostSync() {
  if (desktopSync || typeof window === "undefined" || typeof EventSource !== "function") return desktopSync;
  desktopSync = createHostSync({ onInvalidate: detail => document.dispatchEvent(new CustomEvent("ash:host-state-changed", { detail })) });
  window.addEventListener("pagehide", () => desktopSync.stop());
  window.addEventListener("pageshow", () => { void desktopSync.start(); });
  void desktopSync.start();
  return desktopSync;
}

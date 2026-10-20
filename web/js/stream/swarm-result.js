// New reports persist their partial count in the bridge-generated header.
// Older reports need the original tool arguments to distinguish item labels
// from arbitrary text (including quoted reports) in a child's findings.
export function readSwarmOutcome(text, items) {
  const report = /^Swarm \S+ \([^)]+\) finished: (\d+) succeeded, (\d+) failed, (?:(\d+) partial, )?(\d+) total\.(?:\r?\n|$)/.exec(text);
  if (!report) return { failed: 0, degraded: null };
  const done = Number(report[1]), failed = Number(report[2]), total = Number(report[4]);
  const unknown = { failed, degraded: null };
  if (total < 2 || total > 16 || done + failed !== total) return unknown;
  if (report[3] !== undefined) {
    const degraded = Number(report[3]);
    return degraded <= done ? { failed, degraded } : unknown;
  }
  if (!Array.isArray(items) || items.length !== total) return unknown;
  const lines = text.slice(report[0].length).split(/\r?\n/);
  const marks = [];
  let previous = -1;
  for (let i = 0; i < total; i++) {
    // Match ash.ts's whitespace normalization and UTF-16-safe 60-unit label.
    const flat = String(items[i]).replace(/\s+/g, " ").trim();
    let label = flat;
    if (flat.length > 60) {
      let end = 60;
      if (/[\uD800-\uDBFF]/.test(flat[59]) && /[\uDC00-\uDFFF]/.test(flat[60])) end--;
      label = flat.slice(0, end) + "…";
    }
    const prefix = `[${i + 1}/${total}] ${label} → `;
    const matches = lines.map((line, index) => ({ index,
      mark: line.startsWith(prefix) ? /^([✓✗~])(?: |$)/.exec(line.slice(prefix.length))?.[1] : null,
    })).filter((entry) => entry.mark);
    // An identical quoted entry cannot be disambiguated in legacy text.
    // Keep a neutral state rather than guessing success or partial failure.
    if (matches.length !== 1 || matches[0].index <= previous) return unknown;
    previous = matches[0].index;
    marks.push(matches[0].mark);
  }
  if (marks.filter((mark) => mark === "✗").length !== failed) return unknown;
  return { failed, degraded: marks.filter((mark) => mark === "~").length };
}

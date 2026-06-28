import { t } from "../i18n.js";

/**
 * Fuse consecutive "thinking-block + tool-group" pairs into a single
 * collapsible container so multi-round reasoning (think → tools → think → …)
 * doesn't produce repetitive ▸thought / ▸N tools stacks.
 *
 * Called from sse.js after agent:processing-done.
 */

export function compactReasoning(stream) {
  const children = Array.from(stream.children);

  // ── Find consecutive thinking-block + tool-group runs ────────────
  const runs = []; // { elems: [...], start: idx, end: idx }
  let i = 0;
  while (i < children.length) {
    const think = children[i];
    const tools = children[i + 1];
    if (
      think?.classList?.contains("thinking-block") &&
      tools?.classList?.contains("tool-group")
    ) {
      // Check if this extends the previous run (no text/reply in between)
      const prev = runs[runs.length - 1];
      if (prev && prev.end + 1 === i) {
        prev.elems.push(think, tools);
        prev.end = i + 1;
      } else {
        runs.push({ elems: [think, tools], start: i, end: i + 1 });
      }
      i += 2;
    } else {
      // Skip already-compacted containers so they aren't double-wrapped
      if (think?.classList?.contains("reasoning-phase")) {
        i++;
        continue;
      }
      i++;
    }
  }

  // ── Absorb orphaned thinking-blocks at end of runs ──────────────
  for (const run of runs) {
    const after = children[run.end + 1];
    if (after?.classList?.contains("thinking-block")) {
      run.elems.push(after);
      run.end++;
    }
  }

  // ── Build reasoning-phase containers ─────────────────────────────
  for (const run of runs) {
    if (run.elems.length <= 2) continue; // single pair → leave as-is

    const rounds = Math.ceil(run.elems.length / 2);
    let totalTools = 0;
    for (const el of run.elems) {
      if (el.classList?.contains("tool-group")) {
        totalTools += el.querySelectorAll(".tool-row").length;
      }
    }

    const phase = document.createElement("div");
    phase.className = "reasoning-phase";
    phase.dataset.pairs = rounds;
    phase.dataset.totalTools = totalTools;

    const head = document.createElement("button");
    head.type = "button";
    head.className = "reasoning-phase-head";
    head.innerHTML =
      `<span class="rp-arrow">▸</span>` +
      `<span class="rp-text">💭 ${t("n.reasoning.rounds", { n: rounds })} · ${t("n.tools.compact", { n: totalTools })}</span>`;
    phase.appendChild(head);

    const body = document.createElement("div");
    body.className = "reasoning-phase-body";
    body.hidden = true;
    phase.appendChild(body);

    // Insert the container before the first element BEFORE moving children
    run.elems[0].parentNode.insertBefore(phase, run.elems[0]);

    // Move all run elements into the body (preserves event listeners)
    for (const el of run.elems) body.appendChild(el);

    head.addEventListener("click", () => {
      body.hidden = !body.hidden;
      phase.classList.toggle("open", !body.hidden);
      const arrow = head.querySelector(".rp-arrow");
      if (arrow) arrow.textContent = body.hidden ? "▸" : "▾";
    });
  }
}

// Refresh translated labels on language change
document.addEventListener("langchange", () => {
  document.querySelectorAll(".reasoning-phase").forEach((phase) => {
    const head = phase.querySelector(".reasoning-phase-head");
    if (!head) return;
    const text = head.querySelector(".rp-text");
    const pairs = parseInt(phase.dataset.pairs) || 0;
    const totalTools = parseInt(phase.dataset.totalTools) || 0;
    if (text) text.textContent = `💭 ${t("n.reasoning.rounds", { n: pairs })} · ${t("n.tools.compact", { n: totalTools })}`;
  });
});

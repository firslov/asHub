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
  const runs = []; // { elems: [...], start: idx }
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

  // ── Build reasoning-phase containers ─────────────────────────────
  for (const run of runs) {
    if (run.elems.length <= 2) continue; // single pair → leave as-is

    const pairs = run.elems.length / 2;
    let totalTools = 0;
    for (let j = 1; j < run.elems.length; j += 2) {
      totalTools += run.elems[j].querySelectorAll(".tool-row").length;
    }

    const phase = document.createElement("div");
    phase.className = "reasoning-phase";

    const head = document.createElement("button");
    head.type = "button";
    head.className = "reasoning-phase-head";
    head.innerHTML =
      `<span class="rp-arrow">▸</span>` +
      `<span class="rp-label">${pairs} reasoning rounds</span>` +
      `<span class="rp-stat">${totalTools} tools</span>` +
      `<span class="rp-kind">thought</span>`;
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

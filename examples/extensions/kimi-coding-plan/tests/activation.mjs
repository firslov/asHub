import { test } from "node:test";
import assert from "node:assert/strict";
import activate from "../index.mjs";
const raw = {
  data: [
    {
      id: "k3",
      limit: { context: 1048576 },
      reasoning: { type: "only", effort: { valid: ["low", "high", "max"] } },
    },
  ],
};
test("activation registers model/commands, refreshes and disposes without core imports", async () => {
  const previous = globalThis.fetch,
    key = process.env.KIMI_API_KEY;
  process.env.KIMI_API_KEY = "fixture";
  globalThis.fetch = async () => Response.json(raw);
  let reg,
    hooks,
    active = 0;
  const cleanup = [],
    commands = new Map();
  const ctx = {
    list: () => ["command:/help"],
    getExtensionSettings: (_, d) => d,
    agent: {
      providers: {
        register: (r) => {
          reg = r;
          active++;
          let done = false;
          return () => {
            if (!done) active--;
            done = true;
          };
        },
        configure: (_, h) => (hooks = h),
      },
    },
    onDispose: (f) => cleanup.push(f),
    registerCommand: (n, _, f) => commands.set(n, f),
    bus: { emit: () => {} },
  };
  try {
    await activate(ctx);
    assert.equal(reg.id, "kimi-coding-plan");
    assert.equal(reg.supportsReasoningEffort, false);
    assert.equal(reg.models[0].echoReasoning, true);
    assert.equal(
      hooks.cacheTokens({ prompt_tokens_details: { cached_tokens: 25 } }),
      25,
    );
    assert.ok(commands.has("kimi-status"));
    assert.ok(commands.has("kimi-login"));
    commands.get("kimi-login")("cancel");
    await commands.get("kimi-refresh")();
    assert.equal(active, 1);
  } finally {
    for (const f of cleanup) f();
    globalThis.fetch = previous;
    if (key === undefined) delete process.env.KIMI_API_KEY;
    else process.env.KIMI_API_KEY = key;
  }
  assert.equal(active, 0);
});
test("disposal during model discovery prevents late registration", async () => {
  const previous = globalThis.fetch,
    key = process.env.KIMI_API_KEY;
  process.env.KIMI_API_KEY = "fixture";
  let release;
  globalThis.fetch = () => new Promise((r) => (release = r));
  const cleanup = [];
  let count = 0;
  const ctx = {
    list: () => ["command:/help"],
    getExtensionSettings: (_, d) => d,
    agent: {
      providers: {
        register: () => {
          count++;
        },
        configure: () => {},
      },
    },
    onDispose: (f) => cleanup.push(f),
    registerCommand: () => {},
    bus: { emit: () => {} },
  };
  try {
    const loading = activate(ctx);
    while (!release) await new Promise((r) => setImmediate(r));
    for (const f of cleanup) f();
    release(Response.json(raw));
    await loading;
    assert.equal(count, 0);
  } finally {
    globalThis.fetch = previous;
    if (key === undefined) delete process.env.KIMI_API_KEY;
    else process.env.KIMI_API_KEY = key;
  }
});

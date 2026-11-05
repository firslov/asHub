import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import activate from "../index.mjs";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ashub-work-"));
  const c = {
    currentProjectId: "p",
    currentId: "lead",
    conversations: ["lead", "worker", "reviewer"].map((id) => ({
      id,
      projectId: "p",
    })),
  };
  const tasks = new Map(),
    disposals = [];
  const open = () => {
    const bus = new EventEmitter(),
      tools = new Map(),
      cleanups = [];
    activate({
      list: () => [
        "ashub:catalog",
        "ashub:execute",
        "ashub:collaboration:wait",
        "ashub:collaboration:deliver",
      ],
      bus,
      services: { dataDirectory: dir },
      agent: {
        registerTool: (t) => tools.set(t.name, t),
        registerInstruction() {},
      },
      onDispose: (fn) => cleanups.push(fn),
      call: async (name, p) => {
        if (name === "ashub:catalog") return c;
        assert.equal(name, "ashub:collaboration:wait");
        const statuses = p.targets.map(({ id }) => ({ id, ...tasks.get(id) }));
        return {
          statuses,
          results: statuses
            .filter((s) => s.terminal)
            .map((s) => ({
              ...s,
              delivery: {
                summary: "verified output",
                artifacts: [],
                unresolved: [],
              },
            })),
        };
      },
    });
    const close = () => {
      for (const fn of cleanups.splice(0)) fn();
      bus.removeAllListeners();
    };
    disposals.push(close);
    return {
      bus,
      close,
      run: async (name, args = {}) => {
        const r = await tools.get("project_work_" + name).execute(args);
        if (r.isError) throw Error(r.content);
        return JSON.parse(r.content);
      },
    };
  };
  t.after(() => {
    for (const close of disposals) close();
    fs.rmSync(dir, { force: true, recursive: true });
  });
  const spec = {
    work: "paper",
    goal: "审查表 2",
    steps: [
      { id: "a", member: "worker", output: "data.md", criteria: "核验原表" },
      {
        id: "b",
        member: "reviewer",
        output: "review.md",
        criteria: "核对已验收数据",
        dependsOn: ["a"],
      },
    ],
  };
  return { c, tasks, open, spec, ...open() };
}
function receipt(f, b, id = "task1", recipient = "worker") {
  f.bus.emit("agent:tool-started", {
    name: "conversation_send",
    toolCallId: "call",
    rawInput: b.send,
  });
  f.bus.emit("agent:tool-completed", {
    toolCallId: "call",
    exitCode: 0,
    rawOutput: JSON.stringify({ taskId: id, recipientId: recipient }),
  });
}
test("normal flow holds dependencies until reviewed and carries accepted evidence into downstream brief", async (t) => {
  const f = fixture(t),
    base = { work: "paper", step: "a" };
  const plan = await f.run("plan", f.spec);
  assert.deepEqual(
    plan.steps.map((s) => s.state),
    ["ready", "waiting"],
  );
  await assert.rejects(f.run("brief", { ...base, step: "b" }), /前置/);
  const b = await f.run("brief", base);
  receipt(f, b);
  f.tasks.set("task1", {
    sourceId: "lead",
    recipientId: "worker",
    state: "running",
    terminal: false,
  });
  const review = {
    ...base,
    attempt: b.attempt,
    taskId: "task1",
    decision: "accepted",
    reason: "见 data.md 第 2 行",
  };
  await assert.rejects(f.run("review", review), /结束/);
  f.tasks.get("task1").state = "completed";
  f.tasks.get("task1").terminal = true;
  assert.equal(
    (await f.run("status", { work: "paper" })).steps[0].state,
    "awaiting_review",
  );
  assert.equal(
    (await f.run("status", base)).host.result.delivery.summary,
    "verified output",
  );
  await assert.rejects(f.run("brief", { ...base, step: "b" }), /前置/);
  await f.run("review", review);
  await f.run("review", review);
  assert.match(
    (await f.run("brief", { ...base, step: "b" })).send.message,
    /data.md 第 2 行/,
  );
});
test("multiple activations claim once; reopen lists plans and restores the exact unconfirmed brief", async (t) => {
  const f = fixture(t),
    peer = f.open(),
    base = { work: "paper", step: "a" };
  await f.run("plan", f.spec);
  const [x, y] = await Promise.all([
    f.run("brief", base),
    peer.run("brief", base),
  ]);
  assert.equal([x, y].filter((v) => v.send).length, 1);
  f.close();
  peer.close();
  const fresh = f.open(),
    original = x.send ? x : y;
  assert.deepEqual((await fresh.run("status")).works, ["paper"]);
  assert.equal((await fresh.run("brief", base)).state, "receipt_pending");
  assert.equal(
    (await fresh.run("status", base)).history[0].message,
    original.send.message,
  );
  receipt(fresh, original);
  assert.equal((await fresh.run("brief", base)).taskId, "task1");
});
test("rejects cycles, non-members and changes to a plan key; project and owner isolate ledgers", async (t) => {
  const f = fixture(t),
    changed = structuredClone(f.spec);
  changed.steps[0].dependsOn = ["b"];
  await assert.rejects(f.run("plan", changed), /成环/);
  changed.steps[0].member = "outsider";
  await assert.rejects(f.run("plan", changed), /负责人/);
  await f.run("plan", f.spec);
  await f.run("plan", f.spec);
  await assert.rejects(
    f.run("plan", { ...f.spec, goal: "different" }),
    /另一方案/,
  );
  f.c.currentId = "other";
  assert.deepEqual((await f.run("status")).works, []);
  f.c.currentId = "lead";
  f.c.currentProjectId = "another";
  assert.deepEqual((await f.run("status")).works, []);
});
test("missing receipt is not resent; verify source and recipient and disallow binding same task to another step", async (t) => {
  const f = fixture(t),
    spec = structuredClone(f.spec);
  spec.steps[1].member = "worker";
  spec.steps[1].dependsOn = [];
  await f.run("plan", spec);
  const a = await f.run("brief", { work: "paper", step: "a" }),
    b = await f.run("brief", { work: "paper", step: "b" });
  receipt(f, a, "task1", "wrong");
  const base = {
    work: "paper",
    step: "a",
    attempt: a.attempt,
    taskId: "task1",
  };
  f.tasks.set("task1", {
    sourceId: "else",
    recipientId: "worker",
    state: "running",
    terminal: false,
  });
  await assert.rejects(f.run("link", base), /不匹配/);
  f.tasks.get("task1").sourceId = "lead";
  await f.run("link", base);
  await f.run("link", base);
  await assert.rejects(
    f.run("link", { ...base, step: "b", attempt: b.attempt }),
    /其他步骤/,
  );
});
test("failed tasks cannot pass; a single scoped rework attempt preserves findings and history", async (t) => {
  const f = fixture(t),
    base = { work: "paper", step: "a" };
  await f.run("plan", f.spec);
  const a = await f.run("brief", base);
  receipt(f, a);
  f.tasks.set("task1", {
    sourceId: "lead",
    recipientId: "worker",
    state: "interrupted",
    terminal: true,
  });
  const args = {
    ...base,
    attempt: a.attempt,
    taskId: "task1",
    reason: "只缺第 3 行",
  };
  await assert.rejects(
    f.run("review", { ...args, decision: "accepted" }),
    /不能验收/,
  );
  await f.run("review", { ...args, decision: "revise" });
  assert.equal((await f.run("brief", base)).send, undefined);
  const b = await f.run("brief", { ...base, previousTaskId: "task1" });
  assert.match(b.send.message, /只缺第 3 行/);
  assert.equal(
    (await f.run("brief", { ...base, previousTaskId: "task1" })).send,
    undefined,
  );
  assert.equal((await f.run("status", base)).history.length, 2);
  await assert.rejects(
    f.run("review", { ...args, decision: "blocked" }),
    /已变化/,
  );
});
test("unavailable host receipt does not hide the plan or release dependencies", async (t) => {
  const f = fixture(t),
    base = { work: "paper", step: "a" };
  await f.run("plan", f.spec);
  const a = await f.run("brief", base);
  receipt(f, a);
  f.c.conversations = f.c.conversations.filter((c) => c.id !== "worker");
  const detail = await f.run("status", base);
  assert.match(detail.hostUnavailable, /离开/);
  const plan = await f.run("status", { work: "paper" });
  assert.equal(plan.steps[1].state, "waiting");
  await assert.rejects(
    f.run("review", {
      ...base,
      attempt: a.attempt,
      taskId: "task1",
      decision: "accepted",
      reason: "wrong",
    }),
    /离开/,
  );
});

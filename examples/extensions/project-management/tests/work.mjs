import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
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
  const open = ({ verifyDispatch = true } = {}) => {
    const bus = new EventEmitter(),
      tools = new Map(),
      cleanups = [];
    activate({
      list: () => [
        "ashub:catalog",
        "ashub:execute",
        "ashub:collaboration:wait",
        "ashub:collaboration:deliver",
        ...(verifyDispatch ? ["ashub:collaboration:dispatch-receipt"] : []),
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
        if (name === "ashub:collaboration:dispatch-receipt") {
          const [id, task] = p.taskId
            ? [p.taskId, tasks.get(p.taskId)]
            : [...tasks].find(([, task]) => task.requestKey === p.requestKey) ?? [];
          if (!task) return null;
          if (task.sourceId !== c.currentId) throw Error("回执与协调者不匹配");
          return { taskId: id, recipientId: task.recipientId, requestKey: task.requestKey,
            messageDigest: createHash("sha256").update(task.message ?? "").digest("hex") };
        }
        assert.equal(name, "ashub:collaboration:wait");
        const statuses = p.targets.map(({ id }) => ({ id, ...tasks.get(id) }));
        return {
          statuses,
          results: statuses
            .filter((s) => s.terminal)
            .map((s) => ({
              ...s,
              delivery: tasks.get(s.id)?.delivery ?? {
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
test("recovery verifies exact dispatch, rejects same-member receipts and restores a keyed attempt after reopening", async (t) => {
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
    message: "unrelated work",
  });
  await assert.rejects(f.run("link", base), /不匹配/);
  f.tasks.get("task1").sourceId = "lead";
  await assert.rejects(f.run("link", base), /本次派发不匹配/);
  f.tasks.get("task1").requestKey = a.send.requestKey;
  await assert.rejects(f.run("link", base), /本次派发不匹配/, "matching key without the exact brief is rejected");
  f.tasks.get("task1").message = a.send.message;
  const reopened = f.open();
  assert.deepEqual(await reopened.run("link", { work: "paper", step: "a", attempt: a.attempt }), { taskId: "task1" });
  assert.deepEqual(await reopened.run("link", base), { taskId: "task1" });
  await assert.rejects(reopened.run("link", { ...base, step: "b", attempt: b.attempt }), /本次派发不匹配/);
  assert.equal((await reopened.run("link", { work: "paper", step: "b", attempt: b.attempt })).state, "receipt_pending");
});
test("an old unbound attempt can only be recovered by proving its exact original brief on a supporting host", async (t) => {
  const f = fixture(t), old = f.open({ verifyDispatch: false });
  await old.run("plan", f.spec);
  const base = { work: "paper", step: "a" }, b = await old.run("brief", base);
  assert.equal(b.send.requestKey, undefined);
  f.tasks.set("legacy-task", { sourceId: "lead", recipientId: "worker", message: b.send.message });
  await assert.rejects(old.run("link", { ...base, attempt: b.attempt, taskId: "legacy-task" }), /升级/);
  await assert.rejects(f.run("link", { ...base, attempt: b.attempt }), /原始 taskId/);
  assert.deepEqual(await f.run("link", { ...base, attempt: b.attempt, taskId: "legacy-task" }), { taskId: "legacy-task" });
});
test("structured review requires evidence and issue disposition, and sends only selected, versioned inputs", async (t) => {
  const f = fixture(t), base = { work: "paper", step: "a" };
  f.spec.steps[0].criteria = ["核对原始数据", "复算结论"];
  await f.run("plan", f.spec);
  const a = await f.run("brief", base);
  assert.match(a.send.message, /1\. 核对原始数据\n2\. 复算结论/);
  receipt(f, a);
  f.tasks.set("task1", { sourceId: "lead", recipientId: "worker", state: "completed", terminal: true,
    revision: 7, deliverySubmitted: true, delivery: { summary: "verified", unresolved: ["附录未更新"],
      artifacts: [{ label: "已核对\n备注", path: "checked.md" }, { label: "草稿", path: "draft.md" }] } });
  const review = { ...base, attempt: a.attempt, taskId: "task1", decision: "accepted", reason: "两项结论均已核对" };
  await assert.rejects(f.run("review", review), /逐项满足/);
  const checks = [{ criterion: 2, outcome: "met", evidence: "复算通过" },
    { criterion: 1, outcome: "met", evidence: "核对原表" }];
  await assert.rejects(f.run("review", { ...review, checks }), /未决事项/);
  const unresolved = [{ item: 1, disposition: "accepted_exception", reason: "附录不在本轮范围" }];
  await assert.rejects(f.run("review", { ...review, checks, unresolved: [{ ...unresolved[0], disposition: "blocking" }] }), /阻塞/);
  await assert.rejects(f.run("review", { ...review, checks, unresolved, artifactIndexes: [3] }), /编号/);
  await assert.rejects(f.run("brief", { ...base, step: "b" }), /前置/);
  const selected = { ...review, checks, unresolved, artifactIndexes: [1] };
  await f.run("review", selected);
  await f.run("review", { ...selected, checks: [...checks].reverse() });
  const recorded = (await f.run("status", base)).history[0].review;
  assert.equal(recorded.taskRevision, 7);
  assert.deepEqual(recorded.checks.map(item => item.criterion), [1, 2]);
  const brief = (await f.run("brief", { ...base, step: "b" })).send.message;
  assert.match(brief, /来源任务：task1 · 任务版本 7/);
  assert.match(brief, /checked\.md/);
  assert.match(brief, /已接受的例外：.*附录未更新/);
  assert(!brief.includes("已核对\n备注"), "a worker-provided label cannot insert a line into the brief");
  assert.doesNotMatch(brief, /draft\.md/);
});
test("combined handoff overflow can be reselected before dispatch without rewriting accepted evidence", async (t) => {
  const f = fixture(t);
  f.spec.goal = "g".repeat(800);
  f.spec.steps[1].dependsOn = [];
  f.spec.steps.push({ id: "merge", member: "reviewer", dependsOn: ["a", "b"],
    output: "o".repeat(1200), criteria: "c".repeat(1200) });
  await f.run("plan", f.spec);
  const base = { work: "paper" };
  const plans = await Promise.all(["a", "b"].map(step => f.run("brief", { ...base, step })));
  const receipts = ["a", "b"].map((step, index) => ({
    ...base, step, taskId: ("task" + index).padEnd(36, "0"), attempt: plans[index].attempt,
    decision: "accepted", reason: "r".repeat(420),
  }));
  // The full artifact selection leaves one character for conclusions without a reserve.
  const longWindowsPath = "C:\\" + "d\\".repeat(318) + "report.txt";
  for (const [index, review] of receipts.entries()) {
    const member = index === 0 ? "worker" : "reviewer";
    receipt(f, plans[index], review.taskId, member);
    f.tasks.set(review.taskId, { sourceId: "lead", recipientId: member, state: "completed", terminal: true,
      revision: 4, delivery: { summary: "accepted", unresolved: [],
        artifacts: [1000, 1000, 1000, 540].map((length, i) => ({ label: String(i).repeat(120),
          path: index === 1 && i === 2 ? longWindowsPath : String(i).repeat(length) })) } });
  }
  await f.run("review", { ...receipts[0], artifactIndexes: [1, 2, 3] });
  await f.run("review", { ...receipts[1], artifactIndexes: [3] });
  const merge = { ...base, step: "merge" };
  const overflow = await f.run("brief", merge);
  assert.equal(overflow.state, "handoff_selection_required");
  assert(overflow.selectedCharacters > overflow.artifactBudget);
  assert.equal((await f.run("status", merge)).history.length, 0);
  await assert.rejects(f.run("brief", { ...merge, artifactSelection: [{ step: "b", artifactIndexes: [1] }] }), /已登记/);
  const merged = (await f.run("brief", { ...merge, artifactSelection: [{ step: "a", artifactIndexes: [1, 2] }] })).send.message;
  assert(merged.length <= 8000);
  for (const r of receipts) {
    assert(merged.includes("来源任务：" + r.taskId + " · 任务版本 4"));
    assert(merged.includes(r.step + " 验收结论：" + r.reason));
  }
  for (const i of [0, 1]) assert(merged.includes(String(i).repeat(1000)));
  assert(merged.includes(JSON.stringify(longWindowsPath)));
  assert(!merged.includes("2".repeat(1000)));
  assert.equal((await f.run("status", { ...base, step: "a" })).history[0].review.artifacts.length, 3);
  assert.deepEqual((await f.run("status", merge)).history[0].artifactSelection, [
    { step: "a", artifactIndexes: [1, 2] }, { step: "b", artifactIndexes: [3] },
  ]);
});
async function exceptionHandoff(t, exceptionsPerStep, detailLength = 900) {
  const f = fixture(t);
  f.spec.goal = "目标".padEnd(700, "目");
  f.spec.steps[1].dependsOn = [];
  f.spec.steps.push({
    id: "merge", member: "reviewer", dependsOn: ["a", "b"],
    output: "交付".padEnd(detailLength, "交"), criteria: "条件".padEnd(detailLength, "条"),
  });
  await f.run("plan", f.spec);

  const exceptions = [];
  for (const { id: step, member } of f.spec.steps.slice(0, 2)) {
    const base = { work: "paper", step };
    const attempt = await f.run("brief", base);
    const taskId = "task-" + step;
    receipt(f, attempt, taskId, member);
    const recorded = Array.from({ length: exceptionsPerStep }, (_, i) => ({
      issue: (`例外 ${step}-${i + 1}："尚未覆盖"\n样本📌`).padEnd(245, "界"),
      reason: (`例外 ${step}-${i + 1}："请注明" \\ 来源`).padEnd(335, "限"),
    }));
    const artifacts = [
      { label: "简明结果", path: "/reports/" + step + "/verified.md" },
      { label: "附录", path: "/reports/" + step.repeat(950) + ".md" },
    ];
    f.tasks.set(taskId, {
      sourceId: "lead", recipientId: member, state: "completed", terminal: true, revision: 1,
      delivery: { summary: "verified", unresolved: recorded.map((item) => item.issue), artifacts },
    });
    await f.run("review", {
      ...base, attempt: attempt.attempt, taskId, decision: "accepted", reason: "通过，须遵守已登记的例外",
      unresolved: recorded.map(({ reason }, index) => ({ item: index + 1, disposition: "accepted_exception", reason })),
      artifactIndexes: [1, 2],
    });
    exceptions.push(...recorded);
  }
  return { f, exceptions, merge: { work: "paper", step: "merge" } };
}

test("complete accepted exceptions take priority over selected artifacts from multiple dependencies", async (t) => {
  const { f, exceptions, merge } = await exceptionHandoff(t, 4);
  const overflow = await f.run("brief", merge);
  assert.equal(overflow.state, "handoff_selection_required");
  assert(overflow.selectedCharacters > overflow.artifactBudget);
  assert.equal(overflow.send, undefined);
  assert.equal((await f.run("status", merge)).history.length, 0);

  const { send } = await f.run("brief", {
    ...merge, artifactSelection: [{ step: "a", artifactIndexes: [1] }, { step: "b", artifactIndexes: [1] }],
  });
  assert(send.message.length <= 8000);
  for (const exception of exceptions) assert(send.message.includes(JSON.stringify(exception)));
  assert.match(send.message, /\/reports\/a\/verified\.md/);
  assert.match(send.message, /\/reports\/b\/verified\.md/);
  const review = (await f.run("status", { work: "paper", step: "a" })).history[0].review;
  assert.equal(review.artifacts.length, 2);
  assert.equal(review.unresolved.length, 4);
});

test("handoff can use the full capacity for mandatory text when no artifacts are selected", async (t) => {
  const { f, exceptions, merge } = await exceptionHandoff(t, 4, 1135);
  const { send } = await f.run("brief", {
    ...merge, artifactSelection: [{ step: "a", artifactIndexes: [] }, { step: "b", artifactIndexes: [] }],
  });
  assert.equal(send.message.length, 7999);
  for (const exception of exceptions) assert(send.message.includes(JSON.stringify(exception)));
});

test("handoff rejects an over-limit required brief even after removing every artifact", async (t) => {
  const { f, merge } = await exceptionHandoff(t, 8);
  const first = await f.run("brief", merge);
  const withoutArtifacts = await f.run("brief", {
    ...merge, artifactSelection: [{ step: "a", artifactIndexes: [] }, { step: "b", artifactIndexes: [] }],
  });
  assert.equal(first.state, "handoff_capacity_exceeded");
  assert.equal(first.characterLimit, 8000);
  assert(first.requiredCharacters > first.characterLimit);
  assert.equal(first.send, undefined);
  assert.deepEqual(withoutArtifacts, first);
  assert.equal((await f.run("status", merge)).history.length, 0);
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

// ASHUB_TEST_ROOT points to a built desktop checkout. All state stays in a temporary profile.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = process.env.ASHUB_TEST_ROOT;
test(
  "real session plugin loader, kernel send events, host receipts and coordinator restart",
  { skip: !root },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ashub-work-host-"));
    process.env.AGENT_SH_HOME = dir;
    const load = (p) => import(pathToFileURL(path.join(root, p)).href);
    const require = createRequire(path.join(root, "package.json"));
    const pkg = (id) => import(pathToFileURL(require.resolve(id)).href);
    const { createCore } = await pkg("agent-sh"),
      { activateAgent } = await pkg("agent-sh/agent");
    const { PluginRuntime, preparePluginRegistrations } = await load(
      "dist/plugin-runtime.js",
    );
    const { conversationTools } = await load("dist/conversation-tools.js");
    const { createConversationAccess } = await load(
      "dist/services/conversation-service.js",
    );
    const { CollaborationTasks } = await load("dist/collaboration.js");
    const tasks = new CollaborationTasks(path.join(dir, "tasks"));
    const sessions = new Map(
      ["lead", "member"].map((id) => [
        id,
        { id, title: id, kind: "agent", cwd: dir, bridge: {} },
      ]),
    );
    const projects = {
      list: () => [{ id: "p", name: "demo", sessionIds: [...sessions.keys()] }],
    };
    let sent = 0;
    const bindAccess = (actor) => createConversationAccess(actor, {
      sessions,
      projects,
      tasks,
      submitQuery: async (s, q, i, p, admit, id) => {
        admit();
        tasks.start(id);
        sent++;
        return { accepted: true };
      },
    });
    const access = bindAccess("lead");
    const file = path.join(dir, "settings.json"),
      dest = path.join(dir, "extensions", "ashub-project-management");
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(file, "{}");
    const packageRoot = fileURLToPath(new URL("../", import.meta.url));
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    for (const name of ["package.json", ...manifest.files.filter((file) => fs.statSync(path.join(packageRoot, file)).isFile())])
      fs.copyFileSync(
        fileURLToPath(new URL("../" + name, import.meta.url)),
        path.join(dest, name),
      );
    const runtimes = [];
    async function open(actor = "lead") {
      const participant = bindAccess(actor);
      const core = createCore({ provider: "fixture", model: "demo" }),
        ctx = core.extensionContext({ quit() {} });
      preparePluginRegistrations(ctx);
      activateAgent(ctx);
      preparePluginRegistrations(ctx);
      core.handlers.define("ashub:catalog", () => ({
        currentId: actor,
        currentProjectId: "p",
        conversations: [...sessions.keys()].map((id) => ({
          id,
          projectId: "p",
        })),
      }));
      core.handlers.define("ashub:execute", () => {
        throw Error("unexpected mutation");
      });
      core.handlers.define("ashub:collaboration:wait", (p) =>
        participant.waitTasks(p.targets, p.waitMs, p.signal),
      );
      core.handlers.define("ashub:collaboration:dispatch-receipt", (p) =>
        participant.dispatchReceipt(p, p.signal),
      );
      core.handlers.define("ashub:collaboration:deliver", (p) => participant.deliver(p.id, p.delivery, p.signal));
      for (const tool of conversationTools(participant))
        ctx.agent.registerTool(tool);
      const runtime = new PluginRuntime(file);
      runtimes.push(() => {
        runtime.close();
        core.kill();
      });
      await runtime.load(ctx);
      let start;
      ctx.bus.on("agent:register-backend", (b) => {
        if (b.name === "ash") start = b.start;
      });
      ctx.agent.providers.register({
        id: "fixture",
        apiKey: "fixture-only",
        baseURL: "http://127.0.0.1:1/v1",
        models: ["demo"],
        defaultModel: "demo",
      });
      ctx.bus.emit("core:extensions-loaded", { names: [] });
      assert(start, "fixture backend registered");
      await start();
      return async (name, args) => {
        const tool = ctx.agent.getTools().find((t) => t.name === name);
        assert(tool, name);
        const result = await core.handlers.call("tool:execute", {
          name,
          id: crypto.randomUUID(),
          args,
          tool,
          signal: new AbortController().signal,
        });
        assert(!result.isError, result.content);
        return JSON.parse(result.content);
      };
    }
    try {
      const run = await open(),
        base = { work: "real", step: "a" };
      await run("project_work_plan", {
        work: "real",
        goal: "check",
        steps: [
          {
            id: "a",
            member: "member",
            output: "output.md",
            criteria: "verified",
          },
        ],
      });
      const b = await run("project_work_brief", base);
      assert.equal(b.send.requestKey, b.attempt);
      const { taskId } = await run("conversation_send", b.send);
      assert.equal(
        (await run("project_work_status", base)).step.taskId,
        taskId,
      );
      tasks.deliver(taskId, "member", {
        summary: "checked",
        artifacts: [{ label: "report", path: "output.md" }],
        unresolved: [],
      });
      tasks.finish(taskId, "completed");
      runtimes.pop()();
      const fresh = await open();
      assert.equal(
        (await fresh("project_work_status", base)).host.result.delivery
          .artifacts[0].path,
        "output.md",
      );
      assert.equal(
        (
          await fresh("project_work_review", {
            ...base,
            attempt: b.attempt,
            taskId,
            decision: "accepted",
            reason: "Checked output.md",
          })
        ).steps[0].state,
        "accepted",
      );
      assert.equal(sent, 1);
      await fresh("project_work_plan", {
        work: "recover", goal: "recover missed event",
        steps: [{ id: "a", member: "member", output: "output.md", criteria: ["verified"] }],
      });
      const pending = await fresh("project_work_brief", { ...base, work: "recover" });
      // Send through the host without a kernel event to emulate a response lost during restart.
      const recovered = await access.send(pending.send.id, pending.send.message, undefined, pending.send.requestKey);
      assert.equal((await fresh("project_work_status", { ...base, work: "recover" })).step.state, "receipt_pending");
      assert.deepEqual(await fresh("project_work_link", { ...base, work: "recover", attempt: pending.attempt }), { taskId: recovered.taskId });
      assert.equal((await fresh("conversation_send", pending.send)).taskId, recovered.taskId);
      assert.equal(sent, 2);
      const structured = { work: "handoff", step: "check" };
      const criteria = [
        { initialState: "CI 使用 PR 构建", action: "检查构建回执", expected: "同一提交只登记一次" },
        { initialState: "报告已生成", action: "比对报告的 OK 和 FAIL 计数", expected: "报告与日志计数一致" },
      ];
      await fresh("project_work_plan", {
        work: structured.work, goal: "验证出库报告",
        steps: [
          { id: "check", member: "member", output: "report.md", criteria },
          { id: "release", member: "member", output: "发布说明", criteria: "引用已验收的报告", dependsOn: ["check"] },
        ],
      });
      const member = await open("member");
      const original = await fresh("project_work_brief", structured);
      assert.match(original.send.message, /1\. 初始状态：[^\n]*CI 使用 PR 构建/);
      assert.match(original.send.message, /2\. 初始状态：[^\n]*报告已生成/);
      const first = await fresh("conversation_send", original.send);
      const ok = { criterion: 1, observation: "只有一条回执", outcome: "met", evidence: "ci.log:4" };
      const bad = { criterion: 2, observation: "报告写 OK，日志为 FAIL", outcome: "unmet", evidence: "ci.log:8" };
      const delivery = (id, checks, unresolved = []) => ({
        id, summary: JSON.stringify({ checks }),
        artifacts: [{ label: "报告", path: "report.md" }], unresolved,
      });
      await member("conversation_deliver", delivery(first.taskId, [ok, bad]));
      tasks.finish(first.taskId, "completed");
      const prior = await fresh("project_work_status", structured);
      assert.equal(prior.report.checks[1].outcome, "unmet");
      assert.equal(prior.host.status.revision, tasks.get(first.taskId).revision);
      const review1 = { ...structured, attempt: original.attempt, taskId: first.taskId, taskRevision: prior.host.status.revision };
      const metChecks = [
        { criterion: 1, outcome: "met", evidence: "核对 ci.log:4" },
        { criterion: 2, outcome: "met", evidence: "核对 ci.log:8" },
      ];
      await assert.rejects(fresh("project_work_review", { ...review1, decision: "accepted", reason: "误报通过", checks: metChecks }), /未通过|未验证/);
      await fresh("project_work_review", { ...review1, decision: "revise", reason: "只修正报告对 FAIL 的误标", checks: [metChecks[0], { ...metChecks[1], outcome: "unmet" }] });
      const rework = await fresh("project_work_brief", { ...structured, previousTaskId: first.taskId });
      assert.notEqual(rework.attempt, original.attempt);
      assert.match(rework.send.message, /上一轮未通过或未验证的编号：2/);
      assert(rework.send.message.includes("上一轮任务：" + first.taskId + " · 任务版本 " + prior.host.status.revision));
      assert(rework.send.message.includes('上一轮核对 1（met）："核对 ci.log:4"'));
      assert(rework.send.message.includes('上一轮核对 2（unmet）："核对 ci.log:8"'));
      assert(rework.send.message.includes("旧证据仅供参考"));
      const retry = await fresh("conversation_send", rework.send);
      await assert.rejects(member("conversation_deliver", delivery(first.taskId, [ok, bad])), /currently running task/);
      const fixed = { ...bad, observation: "报告和日志都标为 FAIL", outcome: "met", evidence: "report.md:9 与 ci.log:8" };
      await member("conversation_deliver", delivery(retry.taskId, [fixed, ok], ["演示截图不在本次交付范围"]));
      assert.equal((await fresh("conversation_send", rework.send)).taskId, retry.taskId);
      assert.equal(sent, 4);
      tasks.finish(retry.taskId, "completed");
      const corrected = await fresh("project_work_status", structured);
      assert.deepEqual(corrected.report.checks, [ok, fixed]);
      assert.equal(corrected.history[0].review.decision, "revise");
      const review2 = {
        ...structured, attempt: rework.attempt, taskId: retry.taskId,
        taskRevision: corrected.host.status.revision, decision: "accepted", reason: "已独立比对报告和日志",
        checks: metChecks, artifactIndexes: [1],
        unresolved: [{ item: 1, disposition: "accepted_exception", reason: "用户此轮明确免交演示截图" }],
      };
      await fresh("project_work_review", review2);
      const downstream = await fresh("project_work_brief", { ...structured, step: "release" });
      assert(downstream.send.message.includes("用户此轮明确免交演示截图"));
      assert(downstream.send.message.includes("report.md"));
    } finally {
      for (const stop of runtimes) stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

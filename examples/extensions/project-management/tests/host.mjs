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
    const access = createConversationAccess("lead", {
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
    const file = path.join(dir, "settings.json"),
      dest = path.join(dir, "extensions", "ashub-project-management");
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(file, "{}");
    for (const name of [
      "index.mjs",
      "work.mjs",
      "continuation.mjs",
      "package.json",
      "ashub-plugin.json",
    ])
      fs.copyFileSync(
        fileURLToPath(new URL("../" + name, import.meta.url)),
        path.join(dest, name),
      );
    const runtimes = [];
    async function open() {
      const core = createCore({ provider: "fixture", model: "demo" }),
        ctx = core.extensionContext({ quit() {} });
      preparePluginRegistrations(ctx);
      activateAgent(ctx);
      preparePluginRegistrations(ctx);
      core.handlers.define("ashub:catalog", () => ({
        currentId: "lead",
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
        access.waitTasks(p.targets, p.waitMs, p.signal),
      );
      core.handlers.define("ashub:collaboration:deliver", () => {});
      for (const tool of conversationTools(access))
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
    } finally {
      for (const stop of runtimes) stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

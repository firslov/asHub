import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

function text(value, limit, label) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > limit ||
    value.includes("\0")
  )
    throw Error("无效字段：" + label);
  return value.trim();
}
function key(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value))
    throw Error("工作和步骤编号限 1–64 位字母、数字、横线或下划线");
  return value;
}
function normalize(args, members) {
  const goal = text(args.goal, 800, "goal");
  if (
    !Array.isArray(args.steps) ||
    !args.steps.length ||
    args.steps.length > 12
  )
    throw Error("一次工作包含 1–12 个步骤");
  const steps = args.steps.map((s) => {
    if (!members.has(s.member)) throw Error("负责人必须是同项目的其他活动成员");
    const deps = s.dependsOn ?? [];
    if (
      !Array.isArray(deps) ||
      deps.length > 11 ||
      new Set(deps).size !== deps.length
    )
      throw Error("依赖列表无效");
    return {
      id: key(s.id),
      member: s.member,
      output: text(s.output, 1200, "output"),
      criteria: text(s.criteria, 1200, "criteria"),
      dependsOn: deps.map(key).sort(),
    };
  });
  const known = new Set(steps.map((s) => s.id));
  if (
    known.size !== steps.length ||
    steps.some((s) => s.dependsOn.some((d) => !known.has(d)))
  )
    throw Error("步骤重复或依赖不存在");
  const ordered = new Set();
  for (let i = 0; i < steps.length; i++)
    for (const s of steps)
      if (s.dependsOn.every((d) => ordered.has(d))) ordered.add(s.id);
  if (ordered.size !== steps.length) throw Error("步骤依赖成环");
  return { goal, steps };
}

// On released hosts the managed installation lives in <profile>/extensions/<package>.
// Match the host's path-scoped identity so upgrading the host retains the same ledger.
function directory(ctx) {
  if (ctx.services?.dataDirectory) return ctx.services.dataDirectory;
  const entry = fileURLToPath(new URL("./index.mjs", import.meta.url));
  const extensions = path.dirname(path.dirname(entry));
  if (path.basename(extensions) !== "extensions")
    throw Error(
      "此宿主请通过插件菜单安装到当前配置目录，或升级至支持 plugin-data 的宿主",
    );
  const identity = createHash("sha256")
    .update(entry)
    .digest("hex")
    .slice(0, 24);
  return path.join(
    path.dirname(extensions),
    "hub-sessions",
    "plugin-data",
    identity,
  );
}
const latest = (step) => step.attempts.at(-1);
const decision = (step) => latest(step)?.review?.decision;
function waiting(plan, step) {
  return step.dependsOn.filter(
    (id) => decision(plan.steps.find((s) => s.id === id)) !== "accepted",
  );
}
function snapshot(plan) {
  return {
    goal: plan.goal,
    steps: plan.steps.map((step) => {
      const attempt = latest(step),
        needs = waiting(plan, step);
      return {
        id: step.id,
        member: step.member,
        output: step.output,
        criteria: step.criteria,
        dependsOn: step.dependsOn,
        state:
          decision(step) ??
          (attempt?.taskId
            ? "dispatched"
            : attempt
              ? "receipt_pending"
              : needs.length
                ? "waiting"
                : "ready"),
        ...(needs.length ? { waitingFor: needs } : {}),
        ...(attempt
          ? {
              attempt: attempt.id,
              taskId: attempt.taskId,
              review: attempt.review,
            }
          : {}),
      };
    }),
  };
}
export function workflow(ctx) {
  let db,
    closed = false;
  function storage() {
    if (closed) throw Error("插件已停用");
    if (db) return db;
    const dir = directory(ctx);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const opened = new DatabaseSync(path.join(dir, "work.sqlite"));
    try {
      opened.exec(
        "PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS work (project TEXT, owner TEXT, name TEXT, data TEXT NOT NULL, PRIMARY KEY(project,owner,name)); CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, attempt TEXT NOT NULL)",
      );
      db = opened;
    } catch (e) {
      opened.close();
      throw e;
    }
    return db;
  }
  ctx.onDispose?.(() => {
    closed = true;
    db?.close();
    db = undefined;
  });
  function transaction(fn) {
    const conn = storage();
    conn.exec("BEGIN IMMEDIATE");
    try {
      const result = fn(conn);
      conn.exec("COMMIT");
      return result;
    } catch (e) {
      conn.exec("ROLLBACK");
      throw e;
    }
  }
  function load(conn, scope) {
    const row = conn
      .prepare("SELECT data FROM work WHERE project=? AND owner=? AND name=?")
      .get(...scope);
    return row && JSON.parse(row.data);
  }
  function save(conn, scope, plan) {
    conn
      .prepare(
        "INSERT INTO work VALUES(?,?,?,?) ON CONFLICT(project,owner,name) DO UPDATE SET data=excluded.data",
      )
      .run(...scope, JSON.stringify(plan));
  }
  function getStep(plan, id) {
    const s = plan?.steps.find((s) => s.id === id);
    if (!s) throw Error("工作或步骤不存在");
    return s;
  }
  function attach(scope, stepId, attemptId, taskId) {
    return transaction((conn) => {
      const plan = load(conn, scope),
        attempt = latest(getStep(plan, stepId));
      if (
        !attempt ||
        attempt.id !== attemptId ||
        (attempt.taskId && attempt.taskId !== taskId)
      )
        throw Error("派发尝试已变化，请查看当前记录");
      const bound = conn
        .prepare("SELECT attempt FROM receipts WHERE id=?")
        .get(taskId);
      if (bound && bound.attempt !== attemptId)
        throw Error("回执已绑定其他步骤");
      conn
        .prepare("INSERT OR IGNORE INTO receipts VALUES(?,?)")
        .run(taskId, attemptId);
      attempt.taskId = taskId;
      delete attempt.message;
      save(conn, scope, plan);
      return { taskId };
    });
  }
  // Observe only exact briefs issued by this coordinator activation, including recipient.
  const briefs = new Map(),
    calls = new Map();
  ctx.bus.on("agent:tool-started", (event) => {
    if (event.name !== "conversation_send" || !event.toolCallId) return;
    const a = event.rawInput,
      issued = briefs.get(a?.message);
    if (issued && a.id === issued.member) calls.set(event.toolCallId, issued);
  });
  ctx.bus.on("agent:tool-completed", (event) => {
    const issued = calls.get(event.toolCallId);
    if (!issued) return;
    calls.delete(event.toolCallId);
    if (event.exitCode !== 0) return;
    try {
      const receipt = JSON.parse(event.rawOutput);
      if (
        receipt.recipientId !== issued.member ||
        typeof receipt.taskId !== "string" ||
        !receipt.taskId
      )
        return;
      attach(issued.scope, issued.step, issued.id, receipt.taskId);
      briefs.delete(issued.message);
    } catch {
      /* Keep receipt_pending. The original send receipt can be linked explicitly. */
    }
  });
  async function context(signal) {
    const c = await ctx.call("ashub:catalog", { signal });
    signal?.throwIfAborted();
    if (!c.currentProjectId || !c.currentId)
      throw Error("请在项目内的协调对话中使用协作工作记录");
    return {
      owner: c.currentId,
      project: c.currentProjectId,
      members: new Set(
        c.conversations
          .filter(
            (s) => s.projectId === c.currentProjectId && s.id !== c.currentId,
          )
          .map((s) => s.id),
      ),
    };
  }
  async function hostTask(taskId, member, c, signal) {
    if (!c.members.has(member)) throw Error("成员已离开当前项目");
    const r = await ctx.call("ashub:collaboration:wait", {
      targets: [{ id: taskId }],
      waitMs: 0,
      signal,
    });
    signal?.throwIfAborted();
    const s = r.statuses?.find((s) => s.id === taskId);
    if (!s || s.sourceId !== c.owner || s.recipientId !== member)
      throw Error("回执与协调者或成员不匹配");
    return { status: s, result: r.results?.find((v) => v.id === taskId) };
  }
  return async (action, args, signal) => {
    const c = await context(signal);
    if (action === "status" && !args.work) {
      if (args.step) throw Error("查询步骤必须指定 work");
      return {
        works: storage()
          .prepare(
            "SELECT name FROM work WHERE project=? AND owner=? ORDER BY rowid DESC",
          )
          .all(c.project, c.owner)
          .map((r) => r.name),
      };
    }
    const scope = [c.project, c.owner, key(args.work)];
    if (action === "plan") {
      const spec = normalize(args, c.members);
      return transaction((conn) => {
        let plan = load(conn, scope);
        if (plan && JSON.stringify(plan.spec) !== JSON.stringify(spec))
          throw Error("工作编号已被另一方案使用");
        if (!plan) {
          plan = {
            spec,
            goal: spec.goal,
            steps: spec.steps.map((s) => ({ ...s, attempts: [] })),
          };
          save(conn, scope, plan);
        }
        return snapshot(plan);
      });
    }
    const plan = load(storage(), scope);
    if (!plan) throw Error("工作不存在");
    if (action === "status") {
      const view = snapshot(plan);
      for (const item of view.steps) {
        if (!c.members.has(item.member)) item.memberUnavailable = true;
      }
      async function inspect(action) {
        let value, error;
        try {
          value = await action();
        } catch (e) {
          error = String(e);
        }
        signal?.throwIfAborted();
        const now = await context(signal);
        if (now.owner !== c.owner || now.project !== c.project)
          throw Error("项目归属已变化");
        return { value, error, members: now.members };
      }
      if (args.step) {
        const step = getStep(plan, args.step),
          id = latest(step)?.taskId;
        const pending = latest(step);
        if (!id && pending?.message)
          briefs.set(pending.message, {
            scope,
            step: step.id,
            member: step.member,
            id: pending.id,
            message: pending.message,
          });
        const detail = {
          step: view.steps.find((s) => s.id === args.step),
          history: step.attempts,
        };
        if (id) {
          const result = await inspect(() =>
            hostTask(id, step.member, c, signal),
          );
          if (result.value && result.members.has(step.member))
            detail.host = result.value;
          else detail.hostUnavailable = result.error ?? "成员已离开项目";
        }
        return detail;
      }
      const active = view.steps.filter(
        (s) => s.state === "dispatched" && c.members.has(s.member),
      );
      if (active.length) {
        const batch = await inspect(() =>
          ctx.call("ashub:collaboration:wait", {
            targets: active.map((s) => ({ id: s.taskId })),
            waitMs: 0,
            signal,
          }),
        );
        if (batch.error)
          view.hostUnavailable = "部分回执不可用，可按步骤查询：" + batch.error;
        for (const s of active) {
          const host =
            batch.members.has(s.member) &&
            batch.value?.statuses.find(
              (r) =>
                r.id === s.taskId &&
                r.sourceId === c.owner &&
                r.recipientId === s.member,
            );
          if (host) {
            s.hostState = host.state;
            if (host.terminal) s.state = "awaiting_review";
          }
        }
      }
      return view;
    }
    const step = getStep(plan, args.step);
    if (!c.members.has(step.member)) throw Error("成员已离开当前项目");
    if (action === "brief")
      return transaction((conn) => {
        const p = load(conn, scope),
          s = getStep(p, args.step),
          last = latest(s);
        if (waiting(p, s).length) throw Error("前置步骤尚未验收通过");
        if (
          last &&
          (!last.review ||
            last.review.decision === "accepted" ||
            last.taskId !== args.previousTaskId)
        ) {
          return {
            state:
              decision(s) ?? (last.taskId ? "dispatched" : "receipt_pending"),
            attempt: last.id,
            taskId: last.taskId,
            note: "已有派发记录，请核对原回执；不自动重发。返工需明确传入上一轮 taskId。",
          };
        }
        if (!last && args.previousTaskId) throw Error("没有可返工的上一轮任务");
        const id = randomUUID();
        const upstream = s.dependsOn.map((d) => {
          const prev = latest(getStep(p, d));
          return d + "：" + prev.review.reason;
        });
        const message = [
          "[项目协作 " + scope[2] + "/" + s.id + " · " + id + "]",
          "目标：" + p.goal,
          "交付：" + s.output,
          "验收：" + s.criteria,
          ...upstream.map((v) => "已验收输入：" + v),
          ...(last ? ["仅处理上一轮缺口：" + last.review.reason] : []),
        ].join("\n");
        if (message.length > 8000)
          throw Error("派发说明超过宿主 8000 字符限制，请使用简短的输入引用");
        s.attempts.push({ id, message });
        save(conn, scope, p);
        briefs.set(message, {
          scope,
          step: s.id,
          member: s.member,
          id,
          message,
        });
        return { attempt: id, send: { id: s.member, message } };
      });
    const taskId = text(args.taskId, 160, "taskId"),
      attempt = latest(step);
    if (!attempt || attempt.id !== args.attempt)
      throw Error("派发尝试已变化，请查看当前记录");
    if (action === "review" && attempt.taskId !== taskId)
      throw Error("仅能验收本步骤已登记的回执");
    const host = await hostTask(taskId, step.member, c, signal);
    const current = await context(signal);
    if (
      current.owner !== c.owner ||
      current.project !== c.project ||
      !current.members.has(step.member)
    )
      throw Error("项目归属已变化");
    if (action === "link") {
      const result = attach(scope, step.id, attempt.id, taskId);
      if (attempt.message) briefs.delete(attempt.message);
      return result;
    }
    if (
      !["accepted", "revise", "blocked"].includes(args.decision) ||
      !host.status.terminal
    )
      throw Error("须在任务结束后选择有效的验收决定");
    if (args.decision === "accepted" && host.status.state !== "completed")
      throw Error("失败、中断或取消的任务不能验收通过");
    const review = {
      decision: args.decision,
      reason: text(args.reason, 420, "reason"),
    };
    return transaction((conn) => {
      const p = load(conn, scope),
        a = latest(getStep(p, step.id));
      if (a.id !== args.attempt || a.taskId !== taskId)
        throw Error("任务已变化，请重新核对");
      if (a.review && JSON.stringify(a.review) !== JSON.stringify(review))
        throw Error("本轮验收已登记，请勿覆盖");
      a.review = review;
      save(conn, scope, p);
      return snapshot(p);
    });
  };
}

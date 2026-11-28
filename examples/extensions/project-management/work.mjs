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
const scenarioFields = ["initialState", "action", "expected"];
const isStructured = (criteria) => Array.isArray(criteria) && typeof criteria[0] === "object";
const checkOutcomes = ["met", "unmet", "unverified"];
function normalizeCriteria(input) {
  if (!Array.isArray(input)) return text(input, 1200, "criteria");
  if (!input.length || input.length > 8) throw Error("验收条件须为 1–8 项");
  const structured = isStructured(input);
  const criteria = Array.from(input, (value) => {
    if (!structured) return text(value, 240, "criterion");
    if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((name) => !scenarioFields.includes(name)))
      throw Error("结构化条件须统一提供 initialState、action、expected");
    return Object.fromEntries(scenarioFields.map((name) => [name, text(value[name], 240, name)]));
  });
  const keys = structured ? criteria.map((criterion) => JSON.stringify(criterion)) : criteria;
  const characters = structured ? criteria.flatMap((criterion) => Object.values(criterion)) : criteria;
  if (characters.join("\n").length > 1200 || new Set(keys).size !== criteria.length)
    throw Error("验收条件须互不重复，合计最多 1200 字符");
  return criteria;
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
    if (s.mode !== undefined && s.mode !== "inline-review") throw Error("无效字段：mode");
    return {
      id: key(s.id),
      member: s.member,
      ...(s.mode ? { mode: s.mode } : {}),
      output: text(s.output, 1200, "output"),
      criteria: normalizeCriteria(s.criteria),
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
const dispatchLimit = 8000;
const handoffSummaryReserve = 128;
const inlineReview = "inline-review";
const artifactLine = ({ label, path }) => "产物引用（核对访问权限与当前版本）：" + JSON.stringify({ label, path });
function handoffArtifacts(plan, step, requested) {
  const available = new Map(step.dependsOn.map((dependency) => [
    dependency, latest(plan.steps.find((item) => item.id === dependency)).review.artifacts ?? [],
  ]));
  const selected = new Map(available);
  if (requested === undefined) return { available, selected };
  if (!Array.isArray(requested) || requested.length > available.size) throw Error("无效字段：artifactSelection");
  const sources = new Set();
  for (const row of requested) {
    const artifacts = available.get(row?.step);
    const ids = row?.artifactIndexes;
    if (!artifacts || sources.has(row.step) || !Array.isArray(ids) || new Set(ids).size !== ids.length ||
      ids.some((id) => !artifacts.some((artifact) => artifact.index === id)))
      throw Error("只能选择本步骤前置验收中已登记的产物编号");
    sources.add(row.step);
    selected.set(row.step, artifacts.filter((artifact) => ids.includes(artifact.index)));
  }
  return { available, selected };
}
function briefParts(work, plan, step, id, previousAttempt, selected) {
  const structured = isStructured(step.criteria);
  const previousReview = previousAttempt?.review;
  const criteria = Array.isArray(step.criteria)
    ? step.criteria.map((criterion, i) => {
      const label = structured
        ? "初始状态：" + JSON.stringify(criterion.initialState) + " · 操作：" + JSON.stringify(criterion.action) +
          " · 预期结果：" + JSON.stringify(criterion.expected)
        : criterion;
      return (i + 1) + ". " + label;
    }).join("\n")
    : step.criteria;
  const lines = [
    "[项目协作 " + work + "/" + step.id + " · " + id + "]",
    "目标：" + plan.goal,
    "交付：" + step.output,
    "验收：" + (structured ? "\n" : "") + criteria,
  ];
  if (structured) lines.push(
    '交付时将 conversation_deliver 的 summary 写为 JSON：{"checks":[{"criterion":1,"observation":"实际观察","outcome":"met","evidence":"证据或产物定位"}]}。',
    "按原编号逐项提交。符合预期用 met，不符合用 unmet，材料不足用 unverified（在 observation 说明缺失，evidence 可留空）。较长证据放在 artifacts，summary 最多 2000 字符。",
  );
  if (previousReview) {
    lines.push("仅处理上一轮缺口：" + previousReview.reason);
    if (structured) {
      const checks = previousReview.checks ?? [];
      lines.push("上一轮任务：" + previousAttempt.taskId + " · 任务版本 " + previousReview.taskRevision);
      for (const { criterion, outcome, evidence } of checks)
        lines.push("上一轮核对 " + criterion + "（" + outcome + "）：" + JSON.stringify(evidence));
      const confirmed = new Set(checks.filter((item) => item.outcome === "met").map((item) => item.criterion));
      const remaining = step.criteria.map((_, i) => i + 1).filter((index) => !confirmed.has(index));
      if (remaining.length) lines.push("上一轮未通过或未验证的编号：" + remaining.join("、"));
      lines.push("返工沿用原条件及编号，仍提交各项结果。旧证据仅供参考，改动影响已核对项时须重验；需要核对原回复时，用 conversation_task 读取上一轮任务。");
    }
  }
  const summaries = [];
  let artifactChars = 0;
  for (const dependency of step.dependsOn) {
    const attempt = latest(plan.steps.find((item) => item.id === dependency));
    const review = attempt?.review;
    lines.push("已验收输入：" + dependency);
    if (attempt.taskId) lines.push("来源任务：" + attempt.taskId +
      (review.taskRevision === undefined ? "" : " · 任务版本 " + review.taskRevision));
    for (const artifact of selected.get(dependency)) {
      const line = artifactLine(artifact);
      lines.push(line);
      artifactChars += line.length + 1;
    }
    const exceptions = (review.unresolved ?? []).filter((item) => item.disposition === "accepted_exception")
      .map(({ issue, reason }) => JSON.stringify({ issue, reason }));
    if (exceptions.length) lines.push("已接受的例外：" + exceptions.join("；"));
    summaries.push({ dependency, reason: review.reason });
  }
  return { base: lines.join("\n"), summaries, artifactChars };
}
function formatBrief({ base, summaries }) {
  if (!summaries.length) return base;
  const conclusions = summaries.map(({ dependency, reason }) => ({
    prefix: dependency + " 验收结论：",
    reason,
  }));
  const remaining = dispatchLimit - base.length;
  const full = conclusions.map(({ prefix, reason }) => "\n" + prefix + reason).join("");
  if (full.length <= remaining) return base + full;
  const space = Math.floor(remaining / conclusions.length);
  return base + conclusions.map(({ prefix, reason }) => {
    const available = space - prefix.length - 1;
    if (available < 2) return "";
    const excerpt = reason.length <= available ? reason : reason.slice(0, available - 1).toWellFormed() + "…";
    return "\n" + prefix + excerpt;
  }).join("");
}
function indexed(items, size, indexOf, label) {
  if (items === undefined) return [];
  if (!Array.isArray(items) || items.length > size) throw Error("无效字段：" + label);
  const indexes = new Set();
  for (const item of items) {
    const index = indexOf(item);
    if (!Number.isInteger(index) || index < 1 || index > size || indexes.has(index))
      throw Error("无效或重复的编号：" + label);
    indexes.add(index);
  }
  return [...items].sort((a, b) => indexOf(a) - indexOf(b));
}
function structuredDelivery(delivery, size) {
  const checks = Array.from({ length: size }, (_, i) => ({
    criterion: i + 1, outcome: "unverified", observation: "", evidence: "",
  }));
  if (!delivery) return { state: "missing", checks };
  try {
    const report = JSON.parse(text(delivery.summary, 2000, "summary"));
    if (!report || Object.keys(report).length !== 1 || !Array.isArray(report.checks)) throw Error("无效交付");
    const submitted = indexed(report.checks, size, (item) => item?.criterion, "summary.checks").map((item) => {
      if (Object.keys(item).some((name) => !["criterion", "observation", "outcome", "evidence"].includes(name)) ||
        !checkOutcomes.includes(item.outcome)) throw Error("无效交付");
      return {
        criterion: item.criterion,
        outcome: item.outcome,
        observation: text(item.observation, 2000, "observation"),
        evidence: item.outcome === "unverified" && item.evidence === "" ? "" : text(item.evidence, 2000, "evidence"),
      };
    });
    for (const item of submitted) checks[item.criterion - 1] = item;
    return { state: submitted.length === size ? "complete" : "incomplete", checks };
  } catch {
    return { state: "invalid", checks };
  }
}
function reviewEvidence(step, args, host) {
  const accepted = args.decision === "accepted";
  const delivery = host.result?.delivery;
  if (host.status.deliverySubmitted && !delivery) throw Error("交付详情暂不可用，请重新核对任务");
  const criteria = Array.isArray(step.criteria) ? step.criteria : [step.criteria];
  const issues = delivery?.unresolved ?? [];
  const artifacts = delivery?.artifacts ?? [];
  const checks = indexed(args.checks, criteria.length, (item) => item?.criterion, "checks").map((item) => {
    if (!checkOutcomes.includes(item.outcome)) throw Error("无效的条件核对结果");
    return { criterion: item.criterion, outcome: item.outcome, evidence: text(item.evidence, 420, "evidence") };
  });
  if (accepted && (Array.isArray(step.criteria) || checks.length) &&
    (checks.length !== criteria.length || checks.some((item) => item.outcome !== "met")))
    throw Error("通过前必须逐项满足验收条件并记录证据");
  if (accepted && isStructured(step.criteria)) {
    const report = structuredDelivery(delivery, criteria.length);
    if (report.state !== "complete" || report.checks.some((item) => item.outcome !== "met"))
      throw Error("结构化交付仍有未通过或未验证的条件，请核对实际观察和证据");
  }
  const unresolved = indexed(args.unresolved, issues.length, (item) => item?.item, "unresolved").map((item) => {
    if (!["resolved", "accepted_exception", "blocking"].includes(item.disposition)) throw Error("无效的未决事项处理决定");
    return { item: item.item, issue: issues[item.item - 1], disposition: item.disposition, reason: text(item.reason, 420, "reason") };
  });
  if (accepted && (unresolved.length !== issues.length || unresolved.some((item) => item.disposition === "blocking")))
    throw Error("通过前必须逐项处理未决事项；仍阻塞的事项不能通过");
  const selected = indexed(args.artifactIndexes, artifacts.length, (index) => index, "artifactIndexes")
    .map((index) => ({ index, label: artifacts[index - 1].label, path: artifacts[index - 1].path }));
  if (selected.length && !accepted) throw Error("只有通过的交付可以向下游传递产物");
  return {
    ...(Number.isSafeInteger(host.status.revision) ? { taskRevision: host.status.revision } : {}),
    ...(checks.length ? { checks } : {}),
    ...(unresolved.length ? { unresolved } : {}),
    ...(selected.length ? { artifacts: selected } : {}),
  };
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
        ...(step.mode ? { mode: step.mode } : {}),
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
              review: attempt.review && { decision: attempt.review.decision, reason: attempt.review.reason },
            }
          : {}),
      };
    }),
  };
}
export function workflow(ctx) {
  const canVerifyDispatch = (ctx.list?.() ?? []).includes("ashub:collaboration:dispatch-receipt");
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
  const briefKey = (requestKey, message) => requestKey ? `key:${requestKey}` : `message:${message}`;
  ctx.bus.on("agent:tool-started", (event) => {
    if (event.name !== "conversation_send" || !event.toolCallId) return;
    const a = event.rawInput,
      issued = briefs.get(briefKey(a?.requestKey, a?.message));
    if (issued && a.id === issued.member && a.requestKey === issued.requestKey && a.message === issued.message)
      calls.set(event.toolCallId, issued);
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
      briefs.delete(briefKey(issued.requestKey, issued.message));
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
      members: new Map(
        c.conversations
          .filter((s) => s.projectId === c.currentProjectId && s.id !== c.currentId)
          .map((s) => [s.id, s]),
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
          for (const step of spec.steps) {
            const reviewOnly = c.members.get(step.member).projectTaskProfile === inlineReview;
            if (reviewOnly !== (step.mode === inlineReview))
              throw Error(`${step.id}：${reviewOnly ? '该成员仅审阅提供的文字，请改为 inline-review 步骤；文件操作、测试和文件交付须另行分配' : '该成员未声明 inline-review 能力'}`);
          }
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
        const member = c.members.get(item.member);
        if (!member) item.memberUnavailable = true;
        else if (member.projectTaskProfile === inlineReview) item.projectTaskProfile = inlineReview;
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
          briefs.set(briefKey(pending.requestKey, pending.message), {
            scope,
            step: step.id,
            member: step.member,
            id: pending.id,
            message: pending.message,
            requestKey: pending.requestKey,
          });
        const detail = {
          step: view.steps.find((s) => s.id === args.step),
          history: step.attempts,
        };
        if (id) {
          const result = await inspect(() =>
            hostTask(id, step.member, c, signal),
          );
          if (result.value && result.members.has(step.member)) {
            detail.host = result.value;
            if (isStructured(step.criteria) && result.value.status.terminal)
              detail.report = structuredDelivery(result.value.result?.delivery, step.criteria.length);
          } else detail.hostUnavailable = result.error ?? "成员已离开项目";
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
        const reviewOnly = c.members.get(s.member).projectTaskProfile === inlineReview;
        if (s.mode === inlineReview && !reviewOnly) throw Error("成员的文字评审能力当前不可用");
        if (!reviewOnly && args.reviewMaterial !== undefined) throw Error("该步骤不接收 reviewMaterial");
        if (reviewOnly && args.artifactSelection !== undefined) throw Error("文字评审不接收产物引用，请改用 reviewMaterial");
        if (reviewOnly && args.reviewMaterial === undefined) return {
          state: "review_material_required",
          note: "此成员只能评审明确允许发送的文字。请在 reviewMaterial 中提供评审问题和必要正文或摘录；文件路径、产物引用和历史不会自动交接。" +
            (isStructured(s.criteria) ? "如获授权，请在 reviewMaterial 中明确提供场景编号和提交 checks 报告的要求。" : ""),
        };
        if (reviewOnly && !canVerifyDispatch) throw Error("宿主无法验证文字评审的派发回执，请升级后重试");
        const id = randomUUID();
        let message, artifactSelection;
        if (reviewOnly) {
          // Only explicit review material may be sent. Keep all plan text and handoffs local.
          message = text(args.reviewMaterial, dispatchLimit, "reviewMaterial");
        } else {
          const { available, selected } = handoffArtifacts(p, s, args.artifactSelection);
          const parts = briefParts(scope[2], p, s, id, last, selected);
          const requiredCharacters = parts.base.length - parts.artifactChars;
          const remaining = dispatchLimit - requiredCharacters;
          if (remaining < 0) return {
            state: "handoff_capacity_exceeded",
            note: isStructured(s.criteria) && last?.review
              ? "步骤说明、上一轮证据或完整验收例外超出单条派发容量。请按原验收记录拆分后续工作，核对所需证据和例外。"
              : "步骤说明和完整验收例外已超出单条派发容量。请按原验收记录拆分后续工作，分批交接所需例外。",
            characterLimit: dispatchLimit,
            requiredCharacters,
          };
          const artifactBudget = Math.max(0, remaining - parts.summaries.length * handoffSummaryReserve);
          if (parts.artifactChars > artifactBudget) return {
            state: "handoff_selection_required",
            note: "所选产物超出交接可用容量。请在 artifactSelection 中减少或更换产物。",
            artifactBudget,
            selectedCharacters: parts.artifactChars,
            inputs: [...available].map(([step, artifacts]) => ({
              step,
              artifacts: artifacts.map((a) => ({ index: a.index, label: a.label, characters: artifactLine(a).length + 1,
                selected: selected.get(step).includes(a) })),
            })),
          };
          message = formatBrief(parts);
          if (args.artifactSelection !== undefined)
            artifactSelection = [...selected].map(([step, artifacts]) => ({ step, artifactIndexes: artifacts.map((artifact) => artifact.index) }));
        }
        const requestKey = canVerifyDispatch ? id : undefined;
        s.attempts.push({ id, message, ...(requestKey ? { requestKey } : {}), ...(artifactSelection ? { artifactSelection } : {}) });
        save(conn, scope, p);
        briefs.set(briefKey(requestKey, message), {
          scope,
          step: s.id,
          member: s.member,
          id,
          message,
          requestKey,
        });
        return { attempt: id, send: { id: s.member, message, ...(requestKey ? { requestKey } : {}) } };
      });
    const attempt = latest(step);
    if (!attempt || attempt.id !== args.attempt)
      throw Error("派发尝试已变化，请查看当前记录");
    if (action === "link") {
      const taskId = args.taskId === undefined ? undefined : text(args.taskId, 160, "taskId");
      if (attempt.taskId) {
        if (taskId && attempt.taskId !== taskId) throw Error("派发尝试已绑定其他回执");
        return { taskId: attempt.taskId };
      }
      if (!canVerifyDispatch) throw Error("宿主暂不支持验证派发回执，请升级后补登记");
      if (!taskId && !attempt.requestKey) throw Error("旧派发需要提供原始 taskId");
      const receipt = await ctx.call("ashub:collaboration:dispatch-receipt", {
        ...(taskId ? { taskId } : { requestKey: attempt.requestKey }), signal,
      });
      signal?.throwIfAborted();
      const current = await context(signal);
      if (current.owner !== c.owner || current.project !== c.project || !current.members.has(step.member))
        throw Error("项目归属已变化");
      if (!receipt) return { state: "receipt_pending", note: "未查到已受理回执，请核对原始发送；未自动重发。" };
      if (!attempt.message || receipt.recipientId !== step.member ||
        (taskId && receipt.taskId !== taskId) || receipt.requestKey !== attempt.requestKey ||
        receipt.messageDigest !== createHash("sha256").update(attempt.message).digest("hex"))
        throw Error("回执与本次派发不匹配");
      const result = attach(scope, step.id, attempt.id, text(receipt.taskId, 160, "taskId"));
      briefs.delete(briefKey(attempt.requestKey, attempt.message));
      return result;
    }
    const taskId = text(args.taskId, 160, "taskId");
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
    if (
      !["accepted", "revise", "blocked"].includes(args.decision) ||
      !host.status.terminal
    )
      throw Error("须在任务结束后选择有效的验收决定");
    if (args.decision === "accepted" && host.status.state !== "completed")
      throw Error("失败、中断或取消的任务不能验收通过");
    const coreReview = {
      decision: args.decision,
      reason: text(args.reason, 420, "reason"),
    };
    return transaction((conn) => {
      const p = load(conn, scope),
        a = latest(getStep(p, step.id));
      if (a.id !== args.attempt || a.taskId !== taskId)
        throw Error("任务已变化，请重新核对");
      // Historical reviews remain immutable even if their evidence predates this format.
      if (a.review && JSON.stringify(a.review) === JSON.stringify(coreReview) &&
        args.checks === undefined && args.unresolved === undefined && args.artifactIndexes === undefined)
        return snapshot(p);
      if (isStructured(step.criteria) &&
        (!Number.isSafeInteger(args.taskRevision) || args.taskRevision < 0 || args.taskRevision !== host.status.revision))
        throw Error("结构化验收需要实际核对的 taskRevision，请重新查询交付版本后验收");
      const review = { ...coreReview, ...reviewEvidence(step, args, host) };
      if (a.review) {
        if (JSON.stringify(a.review) === JSON.stringify(review)) return snapshot(p);
        throw Error("本轮验收已登记，请勿覆盖");
      }
      a.review = review;
      save(conn, scope, p);
      return snapshot(p);
    });
  };
}

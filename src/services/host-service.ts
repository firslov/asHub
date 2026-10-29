import * as fs from "node:fs";
import * as path from "node:path";
import type { HostAccess, HostOperations, Operation, PreparedOperation } from "../host-operations.js";
import type { ProjectStore } from "../projects.js";
import type { Session } from "./session-types.js";
import type { SessionService, SessionSetup } from "./session-service.js";
import { HOST_OPERATION_TYPES } from "./host-contract.js";
import { projectWorkingDirectory } from "./project-service.js";
import { selectSessionModel, selectSessionThinking } from "./session-configuration.js";
import { readNetworkPolicy, writeNetworkPolicy } from "../network-policy.js";
export interface HostServiceRuntime {
  sessions: Map<string, Session>;
  projects: ProjectStore;
  operations: HostOperations;
  signal?: AbortSignal;
  deleting(): boolean;
  busy(session: Session): boolean;
  describe: SessionService["describe"];
  version(): { epoch: string; revision: number };
  writeNetworkPolicy?: typeof writeNetworkPolicy;
  sessionThinkingLevel(session: Session): unknown;
  expandHome(value: string): string;
  withContextLock<T>(session: Session, fn: () => Promise<T>): Promise<T>;
  setSessionTitle(session: Session, title: string, user?: boolean): Promise<void>;
  saveSessionMeta(session: Session): Promise<void>;
  create(cwd: string, setup: SessionSetup): Promise<Session>;
  archive(id: string): Promise<void>;
  delete(id: string, approvedOperation?: boolean): Promise<void>;
}

/** Versioned host services for trusted extensions. No team/role policy lives here. */
export function createHostAccess(sourceId: string, runtime: HostServiceRuntime): HostAccess {
  const { sessions, projects, operations, deleting, expandHome, sessionThinkingLevel, withContextLock, setSessionTitle, saveSessionMeta } = runtime;
  const opts = { signal: runtime.signal };
  const source = () => {
    const s = sessions.get(sourceId);
    if (opts.signal?.aborted || !s || s.kind !== 'agent' || s._closing || s._closed) throw new Error('Source conversation unavailable');
    return s;
  };
  const busy = runtime.busy;
  const describe = (session: Session, groups = projects.list(), network = readNetworkPolicy()) => runtime.describe(session, groups, network);
  const catalog = async (signal?: AbortSignal) => {
    signal?.throwIfAborted(); const s = source();
    const models = (await s.bridge.getModels?.())?.models ?? [];
    signal?.throwIfAborted(); source();
    const groups = projects.list(), network = readNetworkPolicy();
    return { version: 1, operations: [...HOST_OPERATION_TYPES], currentId: sourceId,
      currentProjectId: groups.find(p => p.sessionIds.includes(sourceId))?.id ?? null,
      conversations: [...sessions.values()].filter(s => s.kind === 'agent' && !s._closed && !s._closing).map(s => describe(s, groups, network)),
      projects: groups, models, network: { proxyEnabled: network.proxyEnabled }, host: runtime.version() };
  };
  const prepare = async (op: Operation, signal?: AbortSignal): Promise<PreparedOperation> => {
    signal?.throwIfAborted(); source();
    const b = op.input;
    const text = (value: unknown, name: string, max: number) => {
      if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error(`Invalid ${name}`);
      return value.trim();
    };
    const directory = (value: unknown) => {
      const raw = text(value, 'directory', 4096), expanded = expandHome(raw);
      if (!path.isAbsolute(expanded)) throw new Error('Directory must be absolute');
      const cwd = path.resolve(expanded);
      if (!fs.statSync(cwd).isDirectory()) throw new Error('Directory must exist');
      return cwd;
    };
    const fields = (values: Record<string, unknown>) => Object.entries(values).map(([label, value]) => ({ label, value: String(value) }));
    if (op.type === 'project.create') {
      const name = text(b.name, 'project name', 80), cwd = directory(b.cwd), real = fs.realpathSync(cwd);
      if (b.members !== undefined && (!Array.isArray(b.members) || b.members.some(id => id !== sourceId) || b.members.length > 1)) throw new Error('Only the requesting conversation can be added at creation');
      const members = (b.members ?? []) as string[];
      const originalProject = projects.list().find(p => p.sessionIds.includes(sourceId))?.id;
      const validate = () => {
        signal?.throwIfAborted(); source(); if (deleting()) throw new Error('Project deletion in progress');
        if (directory(cwd) !== cwd || fs.realpathSync(cwd) !== real) throw new Error('Directory changed');
        if (members.length && source()._hostOperation) throw new Error('Conversation operation in progress');
        if (members.length && projects.list().find(p => p.sessionIds.includes(sourceId))?.id !== originalProject) throw new Error('Conversation membership changed');
      };
      validate();
      return { preview: { title: '创建项目 / Create project', fields: fields({ '名称 / Name': name, '路径 / Directory': cwd, '加入的对话 / Members': members.length ? `${source().title || sourceId} (${sourceId})` : '—', ...(members.length && originalProject ? { '移出项目 / Move from': projects.list().find(p => p.id === originalProject)?.name ?? originalProject } : {}) }) }, validate,
        async execute() {
          validate(); const before = new Set(projects.list().map(p => p.id));
          const next = projects.update({ action: 'create', name, cwd, add: members }, id => sessions.has(id));
          return { type: op.type, project: next.find(p => !before.has(p.id)) };
        } };
    }
    if (['conversation.update', 'conversation.detach', 'conversation.archive', 'conversation.delete'].includes(op.type)) {
      const id = text(b.id, 'conversation id', 100), target = sessions.get(id);
      if (!target || target.kind !== 'agent' || target._closing || target._closed) throw new Error('Target conversation unavailable');
      if (id === sourceId && ['conversation.archive', 'conversation.delete'].includes(op.type)) throw new Error('Cannot archive or delete the requesting conversation');
      const updating = op.type === 'conversation.update';
      const allowed = updating ? ['id', 'title', 'provider', 'model', 'thinking', 'proxyEnabled'] : ['id'];
      if (Object.keys(b).some(k => !allowed.includes(k))) throw new Error('Unsupported conversation parameter');
      if (updating && Object.keys(b).length === 1) throw new Error('No configuration changes requested');
      const changes: Record<string, string | boolean | null> = {};
      if (b.title !== undefined) changes.title = text(b.title, 'conversation title', 100);
      if ((b.provider === undefined) !== (b.model === undefined)) throw new Error('Model and provider must be specified together');
      if (b.model !== undefined) {
        changes.model = text(b.model, 'model', 200); changes.provider = text(b.provider, 'provider', 100);
        if (/[\s@]/.test(String(changes.model) + changes.provider)) throw new Error('Invalid model or provider');
        // Never silently carry an old model's thinking setting to a new model.
        changes.thinking = b.thinking === undefined ? 'default' : text(b.thinking, 'thinking', 30);
      } else if (b.thinking !== undefined) changes.thinking = text(b.thinking, 'thinking', 30);
      if ('proxyEnabled' in b) {
        if (b.proxyEnabled !== null && typeof b.proxyEnabled !== 'boolean') throw new Error('Invalid VPN setting');
        changes.proxyEnabled = b.proxyEnabled as boolean | null;
      }
      const idle = () => {
        signal?.throwIfAborted(); source();
        if (deleting()) throw new Error('Project deletion in progress');
        if (sessions.get(id) !== target || target._closing || target._closed) throw new Error('Target conversation unavailable');
        if (busy(target)) throw new Error('Conversation is busy; wait for its work to finish');
      };
      idle();
      if (target._hostOperation) throw new Error('Conversation operation in progress');
      if (updating && ('model' in changes || 'thinking' in changes)) await target._ensureBridge?.();
      idle();
      const before = describe(target), originalProject = projects.list().find(p => p.id === before.projectId);
      if (op.type === 'conversation.detach' && !originalProject) throw new Error('Conversation is not in a project');
      const snapshot = () => JSON.stringify({ ...describe(target), busy: undefined,
        lastModified: target.lastModified, project: projects.list().find(p => p.sessionIds.includes(id))?.name });
      const expected = snapshot();
      const check = () => { idle(); if (snapshot() !== expected) throw new Error('Conversation changed; submit a new plan'); };
      const validate = async () => {
        check();
        if (target._hostOperation) throw new Error('Conversation operation in progress');
        if ('model' in changes || 'thinking' in changes) {
          const model = changes.model ?? before.model, provider = changes.provider ?? before.provider;
          const available = (await target.bridge.getModels?.())?.models.find(m => m.model === model && m.provider === provider);
          check();
          if (!available) throw new Error('Model is not available in the target conversation');
          if (changes.thinking !== 'default' && !available.thinkingLevels?.includes(String(changes.thinking))) throw new Error('Unsupported thinking level');
          if ('model' in changes && !target.bridge.execCommand) throw new Error('Backend does not support model selection');
          if (!target.bridge.setThinking && changes.thinking !== 'default') throw new Error('Backend does not support thinking selection');
        }
      };
      await validate();
      const labels = { 'conversation.update': '修改对话 / Update conversation', 'conversation.detach': '移出项目 / Remove from project',
        'conversation.archive': '归档对话 / Archive conversation', 'conversation.delete': '永久删除对话 / Permanently delete conversation' };
      const display = (key: string, value: unknown) => key === 'proxyEnabled' ? value === null ? '继承全局 / Inherit global' : value ? '开启 / On' : '关闭 / Off' : String(value ?? 'default');
      const fieldNames: Record<string, string> = { title: '名称 / Name', model: '模型 / Model', provider: '提供商 / Provider', thinking: '思考 / Thinking', proxyEnabled: 'VPN' };
      const previewFields = fields({ '对话 / Conversation': `${before.title} (${id})`, '项目 / Project': originalProject ? `${originalProject.name} (${originalProject.id})` : '独立对话 / Independent', '目录 / Directory': before.cwd });
      for (const [key, value] of Object.entries(changes)) previewFields.push({ label: fieldNames[key]!, value: `${display(key, before[key as keyof typeof before])} → ${display(key, value)}` });
      if (!updating) previewFields.push({ label: '影响 / Effect', value: op.type === 'conversation.detach' ? '保留历史和原目录，放回会话列表 / Keep history and directory; return to conversations'
        : op.type === 'conversation.archive' ? '移出项目并归档，保留历史，可从归档恢复 / Remove from project and archive; history can be restored'
        : '永久删除对话历史和上传附件，无法撤销；不删除工作目录文件 / Delete history and uploaded attachments permanently; workspace files are kept' });
      return { preview: { title: labels[op.type as keyof typeof labels], fields: previewFields }, validate,
        async execute() {
          await validate(); check();
          if (target._hostOperation) throw new Error('Conversation operation in progress');
          target._hostOperation = true; target._onHostChange?.("operation-start");
          try {
            if (updating) {
              await withContextLock(target, async () => {
                check();
                if ('model' in changes) {
                  await selectSessionModel(target, String(changes.model), String(changes.provider), idle);
                }
                if ('thinking' in changes) {
                  selectSessionThinking(target, String(changes.thinking), idle);
                }
                idle();
                if ('proxyEnabled' in changes) (runtime.writeNetworkPolicy ?? writeNetworkPolicy)(changes.proxyEnabled as boolean | null, id);
                if ('title' in changes) await setSessionTitle(target, String(changes.title), true);
                target.lastModified = Date.now(); await saveSessionMeta(target);
              });
            } else {
              check();
              if (op.type === 'conversation.archive') await runtime.archive(id);
              if (op.type === 'conversation.delete') await runtime.delete(id, true);
              // Detach only after archive/delete succeeds, retaining retry context on failure.
              const currentProject = projects.list().find(p => p.sessionIds.includes(id));
              if (currentProject) projects.update({ action: 'members', id: currentProject.id, remove: [id] }, () => false);
            }
            return { type: op.type, instanceId: id, ...(updating ? { conversation: { ...describe(target), busy: false } } : {}) };
          } catch (error) {
            // Model changes can already have succeeded. Persist/report actual state;
            // the durable receipt prevents a blind replay of partial operations.
            if (updating && !target._closed && !target._closing) {
              try { await saveSessionMeta(target); } catch { /* Report the original failure. */ }
            }
            throw new Error(`Conversation ${id}: operation may be partially applied; inspect before retrying. ${String(error)}`);
          } finally { target._hostOperation = false; target._onHostChange?.("operation-finished"); }
        } };
    }
    if (op.type !== 'conversation.create') throw new Error(`Unsupported host operation: ${op.type}`);
    const title = text(b.title, 'conversation title', 100);
    const projectId = b.projectId === null || b.projectId === undefined ? null : text(b.projectId, 'project id', 100);
    const project = projectId ? projects.list().find(p => p.id === projectId) : undefined;
    if (projectId && !project) throw new Error('Project no longer exists');
    const cwd = directory(project ? projectWorkingDirectory(project, b.cwd, expandHome) : b.cwd), real = fs.realpathSync(cwd);
    const provider = text(b.provider ?? source().provider, 'provider', 100), model = text(b.model ?? source().model, 'model', 200);
    if (/[\s@]/.test(provider + model)) throw new Error('Invalid model or provider');
    const thinking = b.thinking === undefined ? 'default' : text(b.thinking, 'thinking', 30);
    if (b.proxyEnabled !== undefined && b.proxyEnabled !== null && typeof b.proxyEnabled !== 'boolean') throw new Error('Invalid VPN setting');
    const proxyEnabled = b.proxyEnabled ?? null;
    const instructions = b.instructions === undefined ? '' : text(b.instructions, 'conversation instructions', 8000);
    const checkState = () => {
      signal?.throwIfAborted(); source(); if (deleting()) throw new Error('Project deletion in progress');
      const current = projectId ? projects.list().find(p => p.id === projectId) : undefined;
      if (projectId && (!current || current.cwd !== project?.cwd || current.name !== project?.name)) throw new Error('Project changed; submit a new plan');
      if (directory(cwd) !== cwd || fs.realpathSync(cwd) !== real) throw new Error('Directory changed');
    };
    const validate = async () => {
      checkState();
      const available = (await catalog(signal)).models.find(m => m.model === model && m.provider === provider);
      checkState();
      if (!available) throw new Error('Model is not available in this conversation');
      if (thinking !== 'default' && !available.thinkingLevels?.includes(thinking)) throw new Error('Unsupported thinking level');
    };
    await validate();
    return { preview: { title: '创建对话 / Create conversation', fields: fields({ '名称 / Name': title, '项目 / Project': project ? `${project.name} (${project.id})` : '独立对话 / Independent', '路径 / Directory': cwd,
      '模型 / Model': `${model}@${provider}`, '思考 / Thinking': thinking, VPN: proxyEnabled === null ? '继承全局 / Inherit global' : proxyEnabled ? '开启 / On' : '关闭 / Off',
      ...(instructions ? { '说明 / Instructions': instructions } : {}) }) }, validate,
      async execute() {
        await validate(); checkState();
        const created = await runtime.create(cwd, { model, provider, instructions, proxyEnabled });
        try {
          await validate();
          if (instructions && created.bridge.getRestoreState?.()?.conversationInstructions !== instructions) throw new Error('Backend does not support persistent conversation instructions');
          await selectSessionModel(created, model, provider, checkState);
          selectSessionThinking(created, thinking, checkState);
          await validate();
          checkState();
          if (projectId) projects.update({ action: 'members', id: projectId, add: [created.id] }, id => sessions.has(id));
          await setSessionTitle(created, title, true);
          await saveSessionMeta(created);
          return { type: op.type, instanceId: created.id, title, projectId, cwd, model, provider, thinking, proxyEnabled };
        } catch (e) {
          // Preserve created resources; never blindly replay a partially applied operation.
          let detail = String(e);
          try { await saveSessionMeta(created); }
          catch (saveError) { detail += `; metadata save failed: ${String(saveError)}`; }
          throw new Error(`Conversation ${created.id} was created but setup did not finish: ${detail}`);
        }
      } };
  };
  return { catalog, execute: (request, approve, signal) => {
    source();
    const signals = [opts.signal, signal].filter((s): s is AbortSignal => !!s);
    const combined = signals.length ? AbortSignal.any(signals) : undefined;
    const targets = new Set<string>();
    return operations.run(sourceId, request, op => {
      if (['conversation.update', 'conversation.detach', 'conversation.archive', 'conversation.delete'].includes(op.type)) {
        const id = String(op.input.id);
        if (targets.has(id)) throw new Error('Only one operation per existing conversation is allowed in a plan');
        targets.add(id);
      }
      return prepare(op, combined);
    }, approve, combined);
  } };
}

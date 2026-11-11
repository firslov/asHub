import fs from 'node:fs';
import { memoryContext, topicKey, observedAt, memoryIdentity } from './memory-context.mjs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const kinds = { principle: '长期要求', preference: '个人偏好', fact: '事实与知识', experience: '任务经验', procedure: '可复用流程' };
export const states = { candidate: '观察中', active: '正式记忆', retired: '已替代', forgotten: '已忘记' };
export function text(value, max, label = '内容') {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw Error(`${label}须为 1–${max} 个字符`);
  return value.trim().toWellFormed();
}
// Keep the existing UTF-16 length budget without cutting a surrogate pair.
export function previewText(value, max) {
  let end = Math.min(value.length, max);
  if (end > 0 && end < value.length && /[\uD800-\uDBFF]/u.test(value[end - 1]) && /[\uDC00-\uDFFF]/u.test(value[end])) end--;
  return value.slice(0, end).toWellFormed();
}
export function terms(value) {
  // Chinese character bigrams and Unicode words; no network/embedding dependency.
  const out = [];
  for (const part of value.normalize('NFKC').toLocaleLowerCase('en-US').match(/[\p{L}\p{N}_]+/gu) ?? []) {
    for (const run of part.match(/\p{Script=Han}+|[^\p{Script=Han}]+/gu) ?? []) {
      const chars = [...run];
      if (/\p{Script=Han}/u.test(run)) {
        out.push(...chars);
        for (let i = 1; i < chars.length; i++) out.push(chars[i - 1] + chars[i]);
      } else out.push(run);
    }
  }
  return [...new Set(out)];
}
const fingerprint = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const parsed = row => {
  if (!row) return undefined;
  const source = JSON.parse(row.source);
  // Old scope values remain provenance, not retrieval boundaries. Read-time
  // adaptation preserves IDs, revisions, tombstones and rollback compatibility.
  return { ...row, source: row.state === 'forgotten' ? source : { ...source, context: memoryContext(row.scope, source) } };
};

/** One application-owned connection, synchronous bounded transactions. SQLite
 * also serializes writers if another authorized process opens the same profile. */
export class MemoryStore {
  constructor(directory) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(directory, 'memory.sqlite'));
    try {
      fs.chmodSync(path.join(directory, 'memory.sqlite'), 0o600);
      this.db.exec('PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;');
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (version !== 0 && version !== 1) throw Error('记忆库版本不受支持，请升级插件，不要删除数据');
      this.db.exec(`PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS learning_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS profile (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL, revision INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS bindings (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, personal INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS memories (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL, kind TEXT NOT NULL,
          scope TEXT NOT NULL, state TEXT NOT NULL, source TEXT NOT NULL,
          revision INTEGER NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL,
          replaces TEXT, replaces_revision INTEGER, fingerprint TEXT NOT NULL UNIQUE);
        CREATE TABLE IF NOT EXISTS versions (memory_id TEXT NOT NULL, revision INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(memory_id,revision));
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_search USING fts5(id UNINDEXED, terms);
        CREATE TABLE IF NOT EXISTS changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, memory_id TEXT, action TEXT NOT NULL, at INTEGER NOT NULL);
        PRAGMA user_version=1;`);
      this.db.prepare('INSERT OR IGNORE INTO profile VALUES(1,?,1)').run(JSON.stringify({ assistantId: randomUUID(), name: '个人助手', enabled: true }));
    } catch (e) { this.db.close(); throw e; }
  }
  close() { this.db.close(); }
  transaction(run) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = run(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  profile() { const row = this.db.prepare('SELECT * FROM profile WHERE id=1').get(); return { ...JSON.parse(row.value), revision: row.revision }; }
  configure(values, revision) {
    return this.transaction(() => {
      const old = this.profile();
      if (old.revision !== revision) throw Error('设置已变化，请重新预览');
      const name = text(values.name, 60, '助手名称');
      if (typeof values.enabled !== 'boolean') throw Error('无效的启用状态');
      this.db.prepare('UPDATE profile SET value=?,revision=revision+1 WHERE id=1').run(JSON.stringify({ assistantId: old.assistantId, name, enabled: values.enabled }));
    });
  }
  bindings() { return this.db.prepare('SELECT * FROM bindings ORDER BY id').all(); }
  bind(id, cwd, personal) {
    if (this.bindings().length >= 100 && !this.bindings().some(b => b.id === id)) throw Error('最多关联 100 个对话');
    this.db.prepare('INSERT INTO bindings VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET cwd=excluded.cwd,personal=excluded.personal').run(id, cwd, personal ? 1 : 0);
  }
  unbind(id) { this.db.prepare('DELETE FROM bindings WHERE id=?').run(id); }
  get(id) { return parsed(this.db.prepare('SELECT * FROM memories WHERE id=?').get(id)); }
  list(state = 'active', offset = 0) {
    if ((state !== 'all' && !Object.hasOwn(states, state)) || !Number.isSafeInteger(offset) || offset < 0) throw Error('无效的列表参数');
    if (state === 'all') return this.db.prepare("SELECT * FROM memories WHERE state!='forgotten' ORDER BY updated DESC,id LIMIT 31 OFFSET ?").all(offset).map(parsed);
    return this.db.prepare('SELECT * FROM memories WHERE state=? ORDER BY updated DESC,id LIMIT 31 OFFSET ?').all(state, offset).map(parsed);
  }
  memoryTargets() { return this.db.prepare("SELECT * FROM memories WHERE state IN ('active','candidate')").all().map(parsed); }
  memoryIds() { return this.db.prepare("SELECT id FROM memories WHERE state!='forgotten'").all().map(r=>r.id); }
  activeMemories() { return this.db.prepare("SELECT * FROM memories WHERE state='active' ORDER BY updated DESC,id LIMIT 1000").all().map(parsed); }
  counts() { return Object.fromEntries(this.db.prepare('SELECT state,count(*) as n FROM memories GROUP BY state').all().map(r => [r.state, r.n])); }
  check(id, revision) { const row = this.get(id); if (!row || row.state === 'forgotten' || row.revision !== revision) throw Error('记忆已变化，请重新查看'); return row; }
  normalize(input) {
    if (!Object.hasOwn(kinds, input.kind)) throw Error('请选择记忆类型');
    if (typeof input.scope !== 'string' || !/^(personal|(?:project|conversation):[-a-zA-Z0-9]+)$/.test(input.scope)) throw Error('无效的记忆范围');
    return { title: text(input.title, 100, '标题'), content: text(input.content, 2000), kind: input.kind, scope: input.scope };
  }
  record(row, action) {
    this.db.prepare('DELETE FROM memory_search WHERE id=?').run(row.id);
    if (row.state === 'active') this.db.prepare('INSERT INTO memory_search(id,terms) VALUES(?,?)').run(row.id, terms(row.title + ' ' + row.content + ' ' + (row.source.aliases ?? []).join(' ')).join(' '));
    if (row.state !== 'forgotten') this.db.prepare('INSERT INTO versions VALUES(?,?,?)').run(row.id, row.revision, JSON.stringify(row));
    this.db.prepare('DELETE FROM versions WHERE memory_id=? AND revision NOT IN (SELECT revision FROM versions WHERE memory_id=? ORDER BY revision DESC LIMIT 10)').run(row.id, row.id);
    this.db.prepare('INSERT INTO changes(memory_id,action,at) VALUES(?,?,?)').run(row.id, action, Date.now());
    this.db.prepare('DELETE FROM changes WHERE seq NOT IN (SELECT seq FROM changes ORDER BY seq DESC LIMIT 1000)').run();
  }
  add(input, source, state = 'candidate') {
    const value = this.normalize(input);
    if (!['candidate', 'active'].includes(state)) throw Error('无效的初始状态');
    return this.transaction(() => {
      const hash = fingerprint([value, source.conversationId ?? source.userOperation ?? 'user', input.replaces ?? null, input.replacesRevision ?? null]);
      const prior = parsed(this.db.prepare('SELECT * FROM memories WHERE fingerprint=?').get(hash));
      if (prior) return prior; // Includes tombstones: retries never resurrect forgotten content.
      const replacement = input.replaces ? this.check(input.replaces, input.replacesRevision) : null;
      if (replacement && (replacement.state !== 'active' || replacement.scope !== value.scope)) throw Error('只能修订相同范围的正式记忆');
      const total = this.db.prepare('SELECT count(*) as n FROM memories').get().n;
      const counts = this.counts();
      if (total >= 10000 || (state === 'candidate' && (counts.candidate ?? 0) >= 100) || (state === 'active' && (counts.active ?? 0) >= 1000)) throw Error('记忆容量已满，请先整理记录');
      const id = randomUUID(), now = Date.now();
      this.db.prepare('INSERT INTO memories VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, value.title, value.content, value.kind, value.scope, state, JSON.stringify(source), 1, now, now, replacement?.id ?? null, replacement?.revision ?? null, hash);
      const row = this.get(id); this.record(row, state === 'candidate' ? 'propose' : 'create'); return row;
    });
  }
  approve(id, revision) {
    return this.transaction(() => {
      const row = this.check(id, revision);
      if (row.state !== 'candidate') throw Error('只有观察中的记忆可以启用');
      if ((this.counts().active ?? 0) >= 1000 && !row.replaces) throw Error('正式记忆最多 1000 条');
      if (row.replaces) {
        const old = this.check(row.replaces, row.replaces_revision);
        if (old.state !== 'active' || old.scope !== row.scope) throw Error('原记忆已变化，请重新提出修订');
        this.db.prepare("UPDATE memories SET state='retired',revision=revision+1,updated=? WHERE id=?").run(Date.now(), old.id);
        this.record(this.get(old.id), 'replace');
      }
      this.db.prepare("UPDATE memories SET state='active',revision=revision+1,updated=? WHERE id=?").run(Date.now(), id);
      this.record(this.get(id), 'approve'); return this.get(id);
    });
  }
  evidenceIds(row) {
    // User corrections are authoritative, but forgetting must still exclude the
    // original messages. Recover IDs from retained versions for older edits.
    const sources = [row.source, ...this.history(row.id).map(v => v.value.source)];
    const refs = sources.flatMap(s => [...(s.refs ?? []), ...(s.originRefs ?? [])]);
    return [...new Map(refs.filter(r => typeof r.id === 'string' && typeof r.conversationId === 'string')
      .map(r => [JSON.stringify([r.conversationId, r.id]), { id:r.id, conversationId:r.conversationId }])).values()];
  }
  edit(id, revision, input) {
    const value = this.normalize(input);
    return this.transaction(() => {
      const row = this.check(id, revision);
      if (row.state !== 'active') throw Error('只能编辑正式记忆');
      this.db.prepare('UPDATE memories SET title=?,content=?,kind=?,scope=?,source=?,revision=revision+1,updated=? WHERE id=?').run(value.title, value.content, value.kind, value.scope, JSON.stringify({ type: 'user-edit', at: Date.now(), context: value.scope === row.scope ? row.source.context : memoryContext(value.scope, {type:'user-edit'}), topic: row.source.topic, ...(row.source.namespace ? {namespace:row.source.namespace} : {}), originRefs:this.evidenceIds(row) }), Date.now(), id);
      this.record(this.get(id), 'edit'); return this.get(id);
    });
  }
  forgottenCopy(row) {
    const id = this.state('forgotten-content:' + fingerprint(memoryIdentity(row)));
    return id && !row.source?.renewedFrom?.includes(id) ? this.get(id) : undefined;
  }
  forget(id, revision) {
    return this.transaction(() => {
      const old = this.check(id, revision);
      // Save the global topic before clearing provenance, including records
      // that still use only a legacy per-conversation topic key.
      if (old.source.topic) {
        const key = topicKey(old.source);
        if (!this.state(key)) this.setState(key, old.id);
      }
      this.setState('forgotten-content:' + fingerprint(memoryIdentity(old)), old.id);
      for (const ref of this.evidenceIds(old)) {
        const key = 'ignored:' + ref.conversationId;
        this.setState(key, [...new Set([...(this.state(key) ?? []), ref.id])]);
      }
      // Retain only a fingerprint to block replay, not the old memory text or versions.
      this.db.prepare("UPDATE memories SET title='',content='',source='{}',state='forgotten',revision=revision+1,updated=? WHERE id=?").run(Date.now(), id);
      this.db.prepare('DELETE FROM versions WHERE memory_id=?').run(id);
      this.record(this.get(id), 'forget');
    });
  }

  state(key) { const row = this.db.prepare('SELECT value FROM learning_state WHERE key=?').get(key); return row ? JSON.parse(row.value) : undefined; }
  setState(key, value) { this.db.prepare('INSERT INTO learning_state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  legacyCandidates(conversationId, projectId) {
    const scopes = new Set(['personal', 'conversation:' + conversationId, ...(projectId ? ['project:' + projectId] : [])]);
    return this.db.prepare("SELECT * FROM memories WHERE state='candidate' AND json_extract(source,'$.type')='model-proposal' ORDER BY created,id LIMIT 100").all().map(parsed)
      .filter(row => row.source.conversationId === conversationId && scopes.has(row.scope) && !row.replaces);
  }
  adoptLegacy(id, revision, input, source) {
    const value = this.normalize(input);
    return this.transaction(() => {
      const old = this.get(id);
      if (!old || old.revision !== revision || old.state !== 'candidate' || old.source.type !== 'model-proposal' || old.replaces) return null;
      if (source.type !== 'learned' || !source.refs?.length || source.refs.some(ref => ref.conversationId !== old.source.conversationId)) return null;
      if (old.scope !== 'personal' && old.scope !== value.scope) {
        if (value.scope === 'personal' && value.kind === 'fact' && source.certainty === 'explicit') value.scope = old.scope;
        else return null;
      }
      if (old.kind !== value.kind) return null;
      if (this.forgottenCopy({ ...value, source })) return null;
      // A stable private topic prevents collision with an unrelated learned record.
      source = { ...source, topic:'legacy-' + id, migratedFrom:'model-proposal', migratedAt:Date.now() };
      const distinct = new Set(source.refs.map(r => r.conversationId + ':' + r.id)).size;
      const support = Math.min(distinct,new Set(source.refs.map(r => r.fingerprint)).size);
      const qualified = source.certainty === 'explicit' || support >= 2;
      const state = qualified && !['procedure','experience'].includes(value.kind) ? 'active' : 'candidate';
      if (state === 'active' && (this.counts().active ?? 0) >= 1000) throw Error('记忆容量已满');
      source.mode = state === 'active' ? (source.certainty === 'explicit' ? 'explicit' : 'supported') : 'hypothesis';
      this.db.prepare('UPDATE memories SET title=?,content=?,kind=?,scope=?,state=?,source=?,revision=revision+1,updated=? WHERE id=?')
        .run(value.title,value.content,value.kind,value.scope,state,JSON.stringify(source),Date.now(),id);
      this.setState('topic:' + value.scope + ':' + source.topic,id);
      const row = this.get(id); this.record(row,'legacy-reconcile'); return row;
    });
  }
  learnedTopics(scope, visible = () => true) { return this.db.prepare("SELECT * FROM memories WHERE state IN ('active','candidate') AND json_extract(source,'$.type')='learned' ORDER BY updated DESC").all().map(parsed).filter(r => (r.scope === scope || ['user','assistant'].includes(r.source.context.subject)) && visible(r)).slice(0,12).map(r => ({ id:r.id, topic:r.source.topic, title:r.title, content:previewText(r.content,100), scope:r.scope, context:r.source.context, kind:r.kind, state:r.state })); }
  learn(input, source, { explicitRequest = false, priorValid = () => true } = {}) {
    const value = this.normalize(input);
    source = { ...source, context: memoryContext(value.scope, source) };
    const key = topicKey(source);
    return this.transaction(() => {
      // Resolve legacy topic keys without rewriting the database. Migrate a
      // key on first update, preserving edits and forgotten-topic tombstones.
      const oldKey = 'topic:' + value.scope + ':' + source.topic;
      const legacyId = this.state(oldKey), legacy = legacyId ? this.get(legacyId) : null;
      const priorId = this.state(key) ?? (!source.namespace && legacy && (legacy.state === 'forgotten' || topicKey(legacy.source) === key) ? legacy.id : null);
      let prior = priorId ? this.get(priorId) : this.db.prepare("SELECT * FROM memories WHERE json_extract(source,'$.topic')=? ORDER BY updated DESC").all(source.topic).map(parsed).find(r => topicKey(r.source) === key);
      if (prior) this.setState(key, prior.id);
      // Carry only a host-validated explicit renewal forward during later updates.
      if (prior?.source.renewedFrom) source = { ...source, renewedFrom:prior.source.renewedFrom };
      const forgotten = this.forgottenCopy({ ...value, source });
      const blocked = [prior?.state === 'forgotten' ? prior : null, forgotten].filter(Boolean);
      const renewed = explicitRequest && (!prior || prior.state === 'forgotten') && source.certainty === 'explicit' && blocked.length > 0
        && source.refs?.length > 0 && source.refs.every(ref => blocked.every(row => ref.at > row.updated)
          && !(this.state('ignored:' + ref.conversationId) ?? []).includes(ref.id));
      if (renewed) { source = { ...source, renewedFrom:[...new Set(blocked.map(row => row.id))] }; prior = undefined; }
      else if (forgotten && (!prior || prior.source.type === 'learned')) return forgotten;
      // User edits and explicit forgetting always outrank automatic learning.
      if (prior && (['forgotten','retired'].includes(prior.state) || prior.source.type !== 'learned' || this.state('blocked:' + prior.id))) return prior;
      // A rewound live source cannot support the new version. Keep the record
      // identity/history, but rebuild evidence and qualification from this batch.
      const evidencePrior = prior && priorValid(prior) ? prior : null;
      // For a global user/assistant topic, scope records provenance rather than
      // a different conclusion. Independent projects can corroborate it too.
      const sameGlobalTopic = evidencePrior && ['user','assistant'].includes(source.context.subject) && topicKey(evidencePrior.source) === key;
      const unchanged = evidencePrior && ['title','content','kind'].every(k => evidencePrior[k] === value[k]) && (evidencePrior.scope === value.scope || sameGlobalTopic);
      if (evidencePrior?.source.type === 'learned' && observedAt({ source }) < observedAt(evidencePrior)) {
        if (!unchanged) return prior;
        // Older independent evidence may support the same conclusion, but must
        // not replace newer content, provenance, aliases or feedback metadata.
        source = { ...source, ...prior.source, refs: source.refs };
        value.scope = prior.scope;
      }
      const refs = [...new Map([...(unchanged ? prior.source.refs : []), ...source.refs].map(r => [r.conversationId + ':' + r.id, r])).values()]
        .sort((a,b) => a.at - b.at || a.conversationId.localeCompare(b.conversationId) || a.id.localeCompare(b.id)).slice(-12);
      const support = Math.min(new Set(refs.map(r => r.fingerprint)).size, refs.length);
      const qualified = source.certainty === 'explicit' || support >= 2;
      let state = (['procedure','experience'].includes(value.kind) ? false : qualified) ? 'active' : 'candidate';
      if (unchanged && prior?.state === 'active') state = 'active';
      if (evidencePrior?.state === 'active' && state === 'candidate') return prior;
      source = { ...source, refs, ...(unchanged && prior?.source.feedback ? { feedback:prior.source.feedback } : {}), mode: unchanged && prior?.source.mode === 'feedback-supported' ? 'feedback-supported' : state === 'active' ? (source.certainty === 'explicit' ? 'explicit' : 'supported') : 'hypothesis' };
      if (unchanged && JSON.stringify(prior.source.refs) === JSON.stringify(refs) && prior.state === state) return prior;
      const counts = this.counts();
      if ((counts[state] ?? 0) >= (state === 'active' ? 1000 : 100) && prior?.state !== state) throw Error('记忆容量已满');
      if (!prior && Object.values(counts).reduce((a,b) => a+b,0) >= 10000) throw Error('记忆容量已满');
      const now = Date.now(), id = prior?.id ?? randomUUID();
      if (prior) this.db.prepare('UPDATE memories SET title=?,content=?,kind=?,scope=?,source=?,state=?,revision=revision+1,updated=? WHERE id=?').run(value.title,value.content,value.kind,value.scope,JSON.stringify(source),state,now,id);
      else this.db.prepare('INSERT INTO memories VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,value.title,value.content,value.kind,value.scope,state,JSON.stringify(source),1,now,now,null,null,fingerprint(renewed ? ['learning',key,source.refs.map(ref=>[ref.conversationId,ref.id])] : ['learning',key]));
      this.setState(key,id); const row = this.get(id); this.record(row, prior ? 'learn-update' : 'learn'); return row;
    });
  }


  evaluate(id, decision, ref) {
    if (!['support','reject'].includes(decision)) return;
    return this.transaction(() => {
      const row = this.get(id);
      if (!row || !['active','candidate'].includes(row.state) || row.source.type !== 'learned' || !['procedure','experience'].includes(row.kind)) return;
      if (row.source.refs.some(r => r.conversationId === ref.conversationId && r.id === ref.id) || ref.at <= observedAt(row)) return;
      const feedback = row.source.feedback ?? [];
      if (feedback.some(f => f.conversationId === ref.conversationId && f.id === ref.id) || feedback.some(f => f.fingerprint === ref.fingerprint)) return;
      const next = [...feedback, { ...ref, decision }].slice(-20);
      const withdrawn = decision === 'reject' || !!this.state('blocked:' + id);
      if (withdrawn) this.setState('blocked:' + id, true);
      const state = !withdrawn && next.filter(f=>f.decision === 'support').length >= 2 ? 'active' : 'candidate';
      if (state === 'active' && row.state !== 'active' && (this.counts().active ?? 0) >= 1000) throw Error('记忆容量已满');
      const source = { ...row.source, feedback:next, mode:withdrawn ? 'withdrawn' : state === 'active' ? 'feedback-supported' : 'hypothesis' };
      this.db.prepare('UPDATE memories SET state=?,source=?,revision=revision+1,updated=? WHERE id=?').run(state,JSON.stringify(source),Date.now(),id);
      this.record(this.get(id),withdrawn ? 'strategy-withdraw' : 'strategy-feedback');
    });
  }

  history(id) { return this.db.prepare('SELECT revision,value FROM versions WHERE memory_id=? ORDER BY revision DESC LIMIT 10').all(id).map(r => ({ revision: r.revision, value: JSON.parse(r.value) })); }
  search(query, scopes, limit = 8, accept) {
    if (!scopes.length) return [];
    const finish = rows => rows.map(parsed).filter(accept ?? (() => true)).slice(0,limit);
    const fetchLimit = accept ? 1000 : limit;
    const placeholders = scopes.map(() => '?').join(',');
    const words = terms(query.slice(0, 500)).slice(0, 48);
    if (!words.length) return finish(this.db.prepare(`SELECT * FROM memories WHERE state='active' AND scope IN (${placeholders}) ORDER BY CASE kind WHEN 'principle' THEN 0 WHEN 'preference' THEN 1 ELSE 2 END,updated DESC,id LIMIT ?`).all(...scopes, fetchLimit));
    return finish(this.db.prepare(`SELECT m.* FROM memory_search JOIN memories m ON m.id=memory_search.id WHERE memory_search MATCH ? AND m.state='active' AND m.scope IN (${placeholders}) ORDER BY bm25(memory_search),m.id LIMIT ?`).all(words.map(w => '"' + w + '"').join(' OR '), ...scopes, fetchLimit));
  }
  principles(scopes, accept) {
    if (!scopes.length) return [];
    return this.db.prepare(`SELECT * FROM memories WHERE state='active' AND kind IN ('principle','preference') AND scope IN (${scopes.map(() => '?').join(',')}) ORDER BY CASE kind WHEN 'principle' THEN 0 ELSE 1 END,scope,id LIMIT 1000`).all(...scopes).map(parsed).filter(accept ?? (() => true)).slice(0,51);
  }
}

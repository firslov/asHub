import { canonicalEvidence, correctionCue, eventTerms } from './events.mjs';
import { claimFingerprints, historyGuard } from './forgotten-history.mjs';
import fs from 'node:fs';
import { memoryContext, topicKey, observedAt, memoryIdentity, applicability } from './memory-context.mjs';
import { identifiers } from './precision.mjs';
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
const scopedTombstoneKey = (row, identity = memoryIdentity(row)) => 'forgotten-claim:' + fingerprint([row.scope,identity]);
function formerClaimScopes(row, versions) {
  const identity = memoryIdentity(row);
  const scopes = new Set(row.source.formerScopes ?? []);
  for (const { value } of versions) {
    if (value.scope === row.scope && !value.source.formerScopes?.length) continue;
    if (memoryIdentity(value) !== identity) continue;
    scopes.add(value.scope);
    for (const scope of value.source.formerScopes ?? []) scopes.add(scope);
  }
  scopes.delete(row.scope);
  return [...scopes];
}
const memoryError = (code, message) => Object.assign(Error(message), { code });
const significant = value => terms(value).filter(term => [...term].length >= 2 && !['用户','个人','我的','你的','我是','现在','之前','这个','那个','记忆'].includes(term));
const boundedLabels = (labels, max = 60) => [...new Set(labels.filter(value => typeof value === 'string' && value.trim() && value.length <= max))].slice(0, 5);
const parsed = row => {
  if (!row) return undefined;
  const source = JSON.parse(row.source);
  // Old scope values remain provenance, not retrieval boundaries. Read-time
  // adaptation preserves IDs, revisions, tombstones and rollback compatibility.
  return { ...row, source: row.state === 'forgotten' ? source : { ...source, context: memoryContext(row.scope, source) } };
};

const themeEvidenceRoles = new Set(['support', 'exception', 'counterexample', 'context']);
const themeReviewDigest = /^[a-f0-9]{64}$/u;
const parsedThemeEvidence = row => ({ memoryId:row.memory_id, revision:row.memory_revision,
  conversationId:row.conversation_id, sourceId:row.source_id, start:row.start, end:row.end, role:row.role });

function validProjectCommitment(commitment, sourceEnd, originalText) {
  if (!commitment || Object.keys(commitment).length !== 2 ||
      !Number.isSafeInteger(commitment.start) || !Number.isSafeInteger(commitment.end) ||
      commitment.start < 0 || commitment.end <= commitment.start || commitment.end > sourceEnd) return false;
  if (originalText === undefined) return true;
  if (typeof originalText !== 'string' || originalText.length !== sourceEnd) return false;
  const excerpt = originalText.slice(commitment.start, commitment.end);
  return excerpt.isWellFormed() && !!excerpt.trim();
}

export function validProjectDecisionReview(review, evidence, originalText) {
  if (!review || (review.version !== 1 && review.version !== 2) ||
      Object.keys(review).length !== (review.version === 2 ? 3 : 2) || !Array.isArray(review.context) ||
      !Array.isArray(evidence) || evidence.length > 16 || evidence.length !== 1 + review.context.length) return false;
  const [source, ...dependencies] = evidence;
  if (source?.role !== 'support' || source.start !== 0 || !Number.isSafeInteger(source.end) || source.end <= 0 ||
      typeof source.memoryId !== 'string' || !Number.isSafeInteger(source.revision) || source.revision < 1 ||
      typeof source.conversationId !== 'string' || typeof source.sourceId !== 'string' || !source.sourceId) return false;
  if (review.version === 2 && !validProjectCommitment(review.commitment, source.end, originalText)) return false;
  const seen = new Set([source.sourceId]);
  return dependencies.every((dependency, index) => {
    const reference = review.context[index];
    if (!reference || Object.keys(reference).length !== 2 || typeof reference.sourceId !== 'string' || !reference.sourceId ||
        typeof reference.digest !== 'string' || !themeReviewDigest.test(reference.digest) || seen.has(reference.sourceId) ||
        dependency?.role !== 'context' || dependency.sourceId !== reference.sourceId ||
        dependency.memoryId !== source.memoryId || dependency.revision !== source.revision ||
        dependency.conversationId !== source.conversationId || dependency.start !== 0 ||
        !Number.isSafeInteger(dependency.end) || dependency.end <= 0) return false;
    seen.add(reference.sourceId);
    return true;
  });
}

function normalizeProjectReviewProgress(progress) {
  if (!progress || !Array.isArray(progress.reviewed) || progress.reviewed.length > 1000 ||
      Object.keys(progress).some(key=>key!=='reviewed' && key!=='complete') ||
      (progress.complete!==undefined && (typeof progress.complete!=='string' || !themeReviewDigest.test(progress.complete)))) {
    throw Error('无效的项目审查进度');
  }
  const sources = new Set();
  const reviewed = Array.from(progress.reviewed,entry=>{
    if (!entry || Object.keys(entry).length!==2 || typeof entry.basisKey!=='string' || !themeReviewDigest.test(entry.basisKey)) {
      throw Error('无效的项目审查进度');
    }
    const sourceId = text(entry.sourceId,200,'来源标识');
    if (sourceId!==entry.sourceId || sources.has(sourceId))throw Error('无效的项目审查来源');
    sources.add(sourceId);
    return {sourceId,basisKey:entry.basisKey};
  });
  return {reviewed,...(progress.complete===undefined?{}:{complete:progress.complete})};
}

// Routing tags are index-only metadata, never evidence or injected content.
export const indexStyle = row => ['preference','principle'].includes(row.kind) && row.source.context?.subject==='user'
  && /回答|回复|表达|语言|称呼|简洁|中文|english|response|answer|tone/i.test(row.title+' '+row.content)
  && !/如果|当.+时|仅在|只在|这个项目|本项目|修改|写代码|when |if |only /i.test(row.content);
export const exactIndexTerm = value => 'exact' + Buffer.from(value, 'utf8').toString('hex');
function indexTerms(row) {
  const body = row.title + ' ' + row.content + ' ' + [...(row.source.aliases ?? []), ...(row.source.scenarios ?? [])].join(' ');
  return [...terms(body), ...identifiers(body,true).map(exactIndexTerm),
    ...applicability(body.normalize('NFKC').toLocaleLowerCase('en-US')).map(key=>'route'+key), ...(indexStyle(row)?['routestyle']:[]),
    ...(['user','assistant'].includes(row.source.context?.subject)?['routeprofile']:[])].join(' ');
}

/** One application-owned connection, synchronous bounded transactions. SQLite
 * also serializes writers if another authorized process opens the same profile. */
export class MemoryStore {
  constructor(directory) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(directory, 'memory.sqlite'));
    this.transactionActive = false;
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
        CREATE TABLE IF NOT EXISTS theme_statements (
          id TEXT PRIMARY KEY, revision INTEGER NOT NULL, theme_key TEXT NOT NULL, kind TEXT NOT NULL,
          project_id TEXT NOT NULL, title TEXT NOT NULL, basis_key TEXT NOT NULL,
          slot INTEGER NOT NULL, body TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL,
          UNIQUE(theme_key,kind,project_id,slot));
        CREATE TABLE IF NOT EXISTS theme_evidence (
          statement_id TEXT NOT NULL REFERENCES theme_statements(id) ON DELETE CASCADE,
          ordinal INTEGER NOT NULL, memory_id TEXT NOT NULL, memory_revision INTEGER NOT NULL,
          conversation_id TEXT NOT NULL, source_id TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL,
          role TEXT NOT NULL, PRIMARY KEY(statement_id,ordinal));
        CREATE INDEX IF NOT EXISTS theme_evidence_memory ON theme_evidence(memory_id);
        CREATE INDEX IF NOT EXISTS theme_evidence_source ON theme_evidence(conversation_id,source_id);
        PRAGMA user_version=1;`);
      this.db.prepare('INSERT OR IGNORE INTO profile VALUES(1,?,1)').run(JSON.stringify({ assistantId: randomUUID(), name: '个人助手', enabled: true }));
      this.ensureRecallIndex();
      // Reconcile old-version writes before exposing any derived data.
      this.transaction(()=>{
        this.enforceThemeAuthorizationInTransaction();
        if(this.themeOverviewEnabled())this.pruneThemeStatements();
        else this.clearThemeOverviewInTransaction();
      });
    } catch (e) { this.db.close(); throw e; }
  }
  close() { this.db.close(); }
  transaction(run) {
    this.db.exec('BEGIN IMMEDIATE');
    this.transactionActive = true;
    try { const result = run(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.transactionActive = false; }
  }
  // A rollback version maintains the shared FTS table but knows nothing about
  // routing tags. The change sequence detects its writes across version changes.
  recallSequence() { return this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM changes').get().seq; }
  recallIndexSequence() { return this.db.prepare("SELECT value FROM learning_state WHERE key='recall-index-seq'").get()?.value; }
  recallIndexCountsMatch() {
    const active=this.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE state='active'").get().n;
    const indexed=this.db.prepare('SELECT COUNT(*) AS n FROM memory_search').get().n;
    return active===indexed;
  }
  ensureRecallIndex() {
    if (this.recallIndexSequence() === String(this.recallSequence()) && this.db.prepare("SELECT 1 FROM learning_state WHERE key='recall-index-format' AND value='3'").get() && this.recallIndexCountsMatch()) return;
    this.transaction(() => {
      const sequence=String(this.recallSequence());
      // Recheck under the writer lock: another connection may have repaired it.
      if (this.recallIndexSequence() === sequence && this.db.prepare("SELECT 1 FROM learning_state WHERE key='recall-index-format' AND value='3'").get() && this.recallIndexCountsMatch()) return;
      this.db.prepare('DELETE FROM memory_search').run();
      const insert=this.db.prepare('INSERT INTO memory_search(id,terms) VALUES(?,?)');
      for (const raw of this.db.prepare("SELECT * FROM memories WHERE state='active'").iterate()) {
        const row=parsed(raw); insert.run(row.id,indexTerms(row));
      }
      this.db.prepare("INSERT INTO learning_state(key,value) VALUES('recall-index-seq',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(sequence);
      this.db.prepare("INSERT INTO learning_state(key,value) VALUES('recall-index-format','3') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
    });
  }
  clearThemeOverviewInTransaction() {
    this.db.prepare('DELETE FROM theme_statements').run();
    this.db.prepare("DELETE FROM learning_state WHERE key LIKE 'theme-overview:review:%'").run();
  }
  disableThemeOverviewInTransaction() {
    if (!this.themeOverviewEnabled()) return;
    this.setState('theme-overview:generation',this.themeOverviewGeneration()+1);
    this.setState('theme-overview:enabled',false);
    this.clearThemeOverviewInTransaction();
  }
  enforceThemeAuthorizationInTransaction() {
    const learning=this.state('learning');
    if(this.themeOverviewEnabled() && (!learning?.enabled || !learning.grantId || !this.profile().enabled))this.disableThemeOverviewInTransaction();
  }
  themeOverviewGeneration() { return this.state('theme-overview:generation') ?? 0; }
  themeOverviewEnabled() { return this.state('theme-overview:enabled') === true; }
  setThemeOverviewEnabled(enabled) {
    if(typeof enabled!=='boolean')throw Error('无效的主题概览状态');
    return this.transaction(()=>{
      const previous=this.themeOverviewEnabled(), learning=this.state('learning');
      if(enabled && (!learning?.enabled || !learning.grantId || !this.profile().enabled)) throw Error('请先开启已授权的长期记忆');
      if(previous!==enabled) {
        this.setState('theme-overview:generation',this.themeOverviewGeneration()+1);
        this.setState('theme-overview:enabled',enabled);
        if(!enabled)this.clearThemeOverviewInTransaction();
      }
      return {enabled:this.themeOverviewEnabled(),generation:this.themeOverviewGeneration()};
    });
  }
  deleteThemeEvidenceMatches(where, values) {
    const filter='SELECT statement_id FROM theme_evidence WHERE '+where;
    this.db.prepare('DELETE FROM theme_statements WHERE id IN ('+filter+')').run(...values);
  }
  themeEvidenceCurrent(evidence, {pruning=false, decisionText, commitment}={}) {
    const row=this.get(evidence.memoryId);
    if(!row || row.state!=='active' || row.revision!==evidence.revision) return false;
    const ignored=this.state('ignored:'+evidence.conversationId) ?? [];
    if(!Array.isArray(ignored) || ignored.includes(evidence.sourceId))return false;
    const guard=historyGuard(this,evidence.conversationId);
    // The reviewed dependency is bound to the support row by its envelope.
    // Only the authorized history reader can revalidate the context digest.
    if(evidence.role==='context')return guard.complete || pruning;
    const refs=decisionText===undefined ? [...(row.source.refs ?? []),...(row.source.feedback ?? [])] : (row.source.refs ?? []);
    const source=refs.find(ref=>ref.conversationId===evidence.conversationId && ref.id===evidence.sourceId);
    if(!source || typeof source.quote!=='string')return false;
    if(decisionText!==undefined && (source.quote.length!==evidence.end || source.quote.trim().toWellFormed()!==decisionText))return false;
    if(commitment!==undefined && !validProjectCommitment(commitment,evidence.end,source.quote))return false;
    // Also block late results citing a different source that repeats forgotten
    // text. The same guard is used by the history authorization boundary.
    if(guard.matches(source.quote))return false;
    // An old database may have ignored IDs without recoverable fingerprints.
    // Refuse new writes, but retain independently sourced existing bodies until
    // the runtime can revalidate them with its authorized history reader.
    return guard.complete || pruning;
  }
  // On reopen/rollback, inspect current pointers directly. Do not rely on the
  // bounded changes log: legacy versions can change or forget old evidence.
  pruneThemeStatements() {
    const all=this.db.prepare('SELECT id,kind,body FROM theme_statements ORDER BY id').all();
    const query=this.db.prepare('SELECT * FROM theme_evidence WHERE statement_id=? ORDER BY ordinal');
    const remove=this.db.prepare('DELETE FROM theme_statements WHERE id=?');
    for(const {id,kind,body} of all) {
      const evidence=query.all(id).map(parsedThemeEvidence);
      let statement;
      try { statement=JSON.parse(body); } catch { remove.run(id); continue; }
      const review=statement?.decisionReview;
      const validShape=review===undefined ? !evidence.some(ref=>ref.role==='context') :
        kind==='project' && typeof statement.text==='string' && validProjectDecisionReview(review,evidence);
      if(!evidence.length || !validShape || evidence.some(ref=>!this.themeEvidenceCurrent(ref,{
        pruning:true,decisionText:review===undefined?undefined:statement.text,
        commitment:review?.version===2?review.commitment:undefined,
      })))remove.run(id);
    }
  }
  listThemeStatements() {
    return this.transaction(()=>{
      this.enforceThemeAuthorizationInTransaction();
      this.pruneThemeStatements();
      if(!this.themeOverviewEnabled())return [];
      const rows=this.db.prepare('SELECT * FROM theme_statements ORDER BY theme_key,kind,project_id,slot,id').all();
      const read=this.db.prepare('SELECT * FROM theme_evidence WHERE statement_id=? ORDER BY ordinal');
      return rows.map(row=>({id:row.id,revision:row.revision,themeKey:row.theme_key,kind:row.kind,
        ...(row.project_id ? {projectId:row.project_id} : {}),title:row.title,basisKey:row.basis_key,
        ...JSON.parse(row.body),evidence:read.all(row.id).map(parsedThemeEvidence)}));
    });
  }
  saveThemeStatements(input) {
    if(!input || typeof input!=='object' || !['project','preference'].includes(input.kind))throw Error('无效的主题类型');
    if(input.reviewed!==undefined && (input.reviewed!==true || input.kind!=='project'))throw Error('无效的项目决策审查记录');
    if(input.reviewProgress!==undefined && !input.reviewed)throw Error('缺少项目决策审查记录');
    const reviewProgress=input.reviewProgress===undefined?undefined:normalizeProjectReviewProgress(input.reviewProgress);
    const themeKey=text(input.themeKey,200,'主题标识'),title=text(input.title,100,'主题标题'),basisKey=text(input.basisKey,256,'证据版本');
    const projectId=input.kind==='project' ? text(input.projectId,200,'项目标识') : '';
    if(input.kind==='preference' && input.projectId!=null)throw Error('偏好概览不能指定项目');
    if(!Number.isSafeInteger(input.generation) || input.generation<0)throw Error('需要有效的主题概览代次');
    if(!Array.isArray(input.statements) || input.statements.length>8)throw Error('主题陈述最多8条');
    const statements=input.statements.map(statement=>{
      if(!statement || typeof statement!=='object')throw Error('无效的主题陈述');
      const body={text:text(statement.text,1000,'主题陈述')};
      for(const key of ['validFrom','validTo'])if(statement[key]!==undefined){
        const value=statement[key];
        if(!(Number.isSafeInteger(value) && value>=0) && !(typeof value==='string' && value.length<=40 && !Number.isNaN(Date.parse(value))))throw Error('无效的陈述时间');
        body[key]=value;
      }
      if(body.validFrom!==undefined && body.validTo!==undefined && new Date(body.validFrom).getTime()>new Date(body.validTo).getTime())throw Error('陈述时间顺序无效');
      if(!Array.isArray(statement.evidence) || !statement.evidence.length || statement.evidence.length>16)throw Error('主题陈述须包含来源证据');
      const evidence=statement.evidence.map(ref=>{
        if(!ref || typeof ref!=='object' || !Number.isSafeInteger(ref.revision) || ref.revision<1 ||
          !Number.isSafeInteger(ref.start) || !Number.isSafeInteger(ref.end) || ref.start<0 || ref.end<=ref.start || ref.end>10000000 ||
          !themeEvidenceRoles.has(ref.role))throw Error('无效的主题证据');
        return {memoryId:text(ref.memoryId,200,'记忆标识'),revision:ref.revision,conversationId:text(ref.conversationId,200,'对话标识'),
          sourceId:text(ref.sourceId,200,'来源标识'),start:ref.start,end:ref.end,role:ref.role};
      });
      if(!evidence.some(e=>e.role==='support'))throw Error('主题陈述须有支持证据');
      if(statement.decisionReview!==undefined) {
        if(input.kind!=='project' || !validProjectDecisionReview(statement.decisionReview,evidence))throw Error('无效的项目决策审查记录');
        const {version,context,commitment}=statement.decisionReview;
        body.decisionReview={version,context:context.map(({sourceId,digest})=>({sourceId,digest})),
          ...(version===2?{commitment:{start:commitment.start,end:commitment.end}}:{})};
      } else if(input.reviewed || evidence.some(ref=>ref.role==='context'))throw Error('缺少项目决策审查记录');
      return {body,evidence};
    });
    return this.transaction(()=>{
      const learning=this.state('learning');
      if(!this.themeOverviewEnabled() || this.themeOverviewGeneration()!==input.generation || !learning?.enabled || !learning.grantId || !this.profile().enabled)throw Error('主题概览授权已变化');
      for(const {body,evidence} of statements)for(const ref of evidence) {
        if(!this.themeEvidenceCurrent(ref,{
          decisionText:body.decisionReview?body.text:undefined,commitment:body.decisionReview?.commitment,
        }))throw Error('主题证据已变化');
      }
      const previous=this.db.prepare('SELECT * FROM theme_statements WHERE theme_key=? AND kind=? AND project_id=? ORDER BY slot').all(themeKey,input.kind,projectId);
      const write=this.db.prepare(`INSERT INTO theme_statements(id,revision,theme_key,kind,project_id,title,basis_key,slot,body,created,updated)
        VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,title=excluded.title,basis_key=excluded.basis_key,slot=excluded.slot,body=excluded.body,updated=excluded.updated`);
      const del=this.db.prepare('DELETE FROM theme_evidence WHERE statement_id=?');
      const add=this.db.prepare('INSERT INTO theme_evidence VALUES(?,?,?,?,?,?,?,?,?)');
      const now=Date.now(),saved=[];
      for(let slot=0;slot<statements.length;slot++) {
        const {body,evidence}=statements[slot],old=previous[slot],id=old?.id ?? randomUUID();
        const before=old?this.db.prepare('SELECT * FROM theme_evidence WHERE statement_id=? ORDER BY ordinal').all(id).map(parsedThemeEvidence):[];
        const same=old && old.title===title && old.basis_key===basisKey && old.body===JSON.stringify(body) && JSON.stringify(before)===JSON.stringify(evidence);
        const revision=old ? old.revision+(same?0:1) : 1;
        write.run(id,revision,themeKey,input.kind,projectId,title,basisKey,slot,JSON.stringify(body),old?.created ?? now,now);
        del.run(id);evidence.forEach((e,i)=>add.run(id,i,e.memoryId,e.revision,e.conversationId,e.sourceId,e.start,e.end,e.role));
        saved.push({id,revision});
      }
      const remove=this.db.prepare('DELETE FROM theme_statements WHERE id=?');
      for(const old of previous.slice(statements.length))remove.run(old.id);
      if(input.reviewed)this.setState('theme-overview:review:'+themeKey,reviewProgress??basisKey);
      else if(input.kind==='project')this.db.prepare('DELETE FROM learning_state WHERE key=?').run('theme-overview:review:'+themeKey);
      return saved;
    });
  }
  profile() { const row = this.db.prepare('SELECT * FROM profile WHERE id=1').get(); return { ...JSON.parse(row.value), revision: row.revision }; }
  configure(values, revision) {
    return this.transaction(() => {
      const old = this.profile();
      if (old.revision !== revision) throw Error('设置已变化，请重新预览');
      const name = text(values.name, 60, '助手名称');
      if (typeof values.enabled !== 'boolean') throw Error('无效的启用状态');
      this.db.prepare('UPDATE profile SET value=?,revision=revision+1 WHERE id=1').run(JSON.stringify({ assistantId: old.assistantId, name, enabled: values.enabled }));
      if(!values.enabled)this.disableThemeOverviewInTransaction();
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
    // All mutation callers already hold the same transaction as the memory write.
    this.deleteThemeEvidenceMatches("memory_id=? AND (memory_revision<>? OR ?<>'active')",[row.id,row.revision,row.state]);
    if (row.state !== 'forgotten' && (row.source.type === 'learned' || row.source.namespace === 'assistant-v4')) {
      const versions = this.history(row.id);
      const source = { ...row.source };
      // Version bodies are bounded, but forgetting must still exclude sources
      // from older corrections. Retain only their IDs, never their old text;
      // current refs alone remain the evidence used for qualification/recall.
      if (source.type === 'learned') source.originRefs = this.evidenceIds(row, versions);
      if (source.namespace === 'assistant-v4') {
        const scopes = formerClaimScopes(row, versions);
        if (scopes.length) source.formerScopes = scopes;
        else delete source.formerScopes;
      }
      row.source = source;
      this.db.prepare('UPDATE memories SET source=? WHERE id=?').run(JSON.stringify(row.source),row.id);
    }
    const previousSequence=String(this.recallSequence());
    const indexWasCurrent=this.recallIndexSequence() === previousSequence;
    this.db.prepare('DELETE FROM memory_search WHERE id=?').run(row.id);
    if (row.state === 'active') this.db.prepare('INSERT INTO memory_search(id,terms) VALUES(?,?)').run(row.id, indexTerms({...row,source:{...row.source,context:memoryContext(row.scope,row.source)}}));
    if (row.state !== 'forgotten') this.db.prepare('INSERT INTO versions VALUES(?,?,?)').run(row.id, row.revision, JSON.stringify(row));
    this.db.prepare('DELETE FROM versions WHERE memory_id=? AND revision NOT IN (SELECT revision FROM versions WHERE memory_id=? ORDER BY revision DESC LIMIT 10)').run(row.id, row.id);
    this.db.prepare('INSERT INTO changes(memory_id,action,at) VALUES(?,?,?)').run(row.id, action, Date.now());
    // Do not mask an older writer's unrepaired rows with a newer write.
    if (indexWasCurrent) this.db.prepare("UPDATE learning_state SET value=? WHERE key='recall-index-seq'").run(String(this.recallSequence()));
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
  evidenceIds(row, versions = this.history(row.id)) {
    // User corrections are authoritative, but forgetting must still exclude the
    // original messages and strategy feedback. Recover IDs from retained versions
    // for older edits; record() carries IDs beyond the bounded feedback history.
    const sources = [row.source, ...versions.map(v => v.value.source)];
    const refs = sources.flatMap(s => [...(s.refs ?? []), ...(s.feedback ?? []), ...(s.originRefs ?? [])]);
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
    const key = scopedTombstoneKey(row);
    let id = this.state(key);
    if (id && row.id) {
      const exemption = this.state(key + ':independent');
      if (exemption?.forgottenId === id && exemption.ids.includes(row.id)) return undefined;
    }
    if (!id) {
      // Existing fingerprints stay effective after upgrading normalization.
      const legacy = memoryIdentity(row,{legacy:true});
      id = this.state('forgotten-content-scoped:' + fingerprint([row.scope,legacy]))
        ?? this.state('forgotten-content:' + fingerprint(legacy));
    }
    return id && !row.source?.renewedFrom?.includes(id) ? this.get(id) : undefined;
  }
  forget(id, revision) {
    return this.transaction(() => {
      const old = this.check(id, revision);
      const dedicated = old.source.namespace === 'assistant-v4';
      const identity = memoryIdentity(old,{legacy:!dedicated}), versions = this.history(old.id);
      const evidence = this.evidenceIds(old, versions), sourceIds = new Set(evidence.map(ref => ref.id));
      // Forgetting one source also removes derived statements backed by that
      // same original even if a different independently kept memory cites it.
      for(const ref of evidence)this.deleteThemeEvidenceMatches('conversation_id=? AND source_id=?',[ref.conversationId,ref.id]);
      const evidenceKey = ref => JSON.stringify([ref.conversationId,ref.id]);
      const evidenceKeys = new Set(evidence.map(evidenceKey));
      const forgottenIds = new Set([old.id]);
      const forgottenScopes = new Set([old.scope]);
      this.setState(dedicated ? scopedTombstoneKey(old, identity) : 'forgotten-content:' + fingerprint(identity), old.id);
      if (dedicated) for (const scope of formerClaimScopes(old, versions)) {
        const peers = this.db.prepare(`SELECT * FROM memories WHERE scope=? AND kind=? AND state!='forgotten'
          AND json_extract(source,'$.namespace')=?`).all(scope, old.kind, old.source.namespace)
          .map(parsed).filter(row => memoryIdentity(row) === identity);
        const independent = [];
        for (const peer of peers) {
          // A renamed copy with no additional provenance would otherwise
          // keep recalling evidence this transaction has just forgotten.
          const current = peer.source.type === 'learned' ? [...(peer.source.refs ?? []), ...(peer.source.feedback ?? [])] : [];
          if (current.length && current.every(ref=>evidenceKeys.has(evidenceKey(ref)))) forgottenIds.add(peer.id);
          else if (peer.state === 'active' || peer.state === 'candidate') independent.push(peer.id);
        }
        const key = scopedTombstoneKey({ scope }, identity);
        this.setState(key, old.id);
        // Give the existing independent row a narrow exception. A later
        // correction of that row cannot erase the scope's forgetting rule.
        if (independent.length) this.setState(key + ':independent', {forgottenId:old.id, ids:independent});
        else forgottenScopes.add(scope);
      }
      for (const ref of evidence) {
        const key = 'ignored:' + ref.conversationId;
        this.setState(key, [...new Set([...(this.state(key) ?? []), ref.id])]);
      }
      // Scope raw-text suppression to the originating conversation. This
      // does not change the visibility of independently established memories.
      const claims = [old, ...versions.map(v=>v.value)], guards = new Map();
      for (const conversationId of new Set([...evidence.map(ref=>ref.conversationId),
        old.source.conversationId, old.source.context?.conversationId,
        this.state('learning')?.modelSessionId].filter(Boolean))) {
        const key = 'raw-forgotten:'+conversationId, prior = this.state(key) ?? {};
        const hashes = new Set(prior.hashes ?? []), covered = new Set(prior.covered ?? []);
        const {assistantId} = this.profile(), anchors = new Map((prior.anchors ?? []).map(([h,n])=>[h,new Set(n)]));
        const add = value=>claimFingerprints(assistantId,value,(h,n,anchor)=>{
          hashes.add(h);
          if(anchor!==undefined) {
            if(!anchors.has(anchor))anchors.set(anchor,new Set());
            anchors.get(anchor).add(n);
          }
        });
        for (const claim of claims) {
          add(claim.content);
          for (const ref of [...(claim.source.refs ?? []), ...(claim.source.feedback ?? [])]) {
            if (ref.conversationId!==conversationId || !ref.quote) continue;
            add(ref.quote); covered.add(ref.id);
          }
        }
        this.setState(key,{hashes:[...hashes],anchors:[...anchors].map(([h,n])=>[h,[...n]]),covered:[...covered]});
        guards.set(conversationId,historyGuard(this,conversationId));
      }
      // A different source can repeat a forgotten claim. If the existing
      // history guard identifies its stored quotation as a forgotten copy,
      // remove statements backed by that source in this same transaction.
      if(guards.size) {
        const dependencies=this.db.prepare('SELECT DISTINCT memory_id,conversation_id,source_id FROM theme_evidence').all();
        const blocked=new Set();
        for(const dep of dependencies) {
          const guard=guards.get(dep.conversation_id);if(!guard)continue;
          const row=this.get(dep.memory_id);
          const refs=[...(row?.source.refs ?? []),...(row?.source.feedback ?? [])];
          if(refs.some(ref=>ref.conversationId===dep.conversation_id && ref.id===dep.source_id
            && typeof ref.quote==='string' && guard.matches(ref.quote)))blocked.add(JSON.stringify([dep.conversation_id,dep.source_id]));
        }
        for(const key of blocked) this.deleteThemeEvidenceMatches('conversation_id=? AND source_id=?',JSON.parse(key));
      }
      // Short replies grounded only by questions can inherit precisely
      // the forgotten value. Withdraw those derivatives, while separate or
      // independently evidenced facts retain their own lifecycle.
      if(guards.size)for(const row of this.memoryTargets()){
        const refs=row.source.refs??[];
        if(row.source.type!=='learned' || !refs.length || !refs.every(ref=>ref.contextId&&guards.has(ref.conversationId)))continue;
        const fields=[row.title,row.content,row.source.topic,...(row.source.aliases??[]),...(row.source.scenarios??[])];
        if(refs.some(ref=>fields.some(field=>typeof field==='string'&&guards.get(ref.conversationId).matches(field)))){
          forgottenIds.add(row.id);
          for(const ref of refs)sourceIds.add(ref.id);
        }
      }
      // Background recovery state may contain short source text or a completed
      // model result. Erase those derived copies in the same transaction, rather
      // than waiting until the next learning tick to reject their evidence.
      const cacheRows=this.db.prepare("SELECT key,value FROM learning_state WHERE key LIKE 'scan:%' OR key LIKE 'legacy-scan:%' OR key LIKE 'learning-result:%' OR key LIKE 'deferred:%'").all();
      const list = value => Array.isArray(value) ? value : [];
      const quoted = item => list(item?.evidence).some(ref => sourceIds.has(ref?.id));
      for (const cache of cacheRows) {
        let value;try{value=JSON.parse(cache.value);}catch{this.setState(cache.key,null);continue;}if(!value)continue;
        const [type,cacheId]=cache.key.split(':');
        const guard=guards.get(type==='legacy-scan'?this.get(cacheId)?.source.conversationId:cacheId);
        const sealed = text => typeof text==='string' && guard?.matches(text);
        const cachedSource = row => row && (sourceIds.has(row.id) || sealed(row.text)
          || (typeof row.continuation?.text==='string' && sealed(row.continuation.text+row.text)));
        if (cache.key.startsWith('scan:') || cache.key.startsWith('legacy-scan:')) {
          if(Array.isArray(value.context))this.setState(cache.key,{...value,context:value.context.filter(row=>row&&typeof row.id==='string'&&!cachedSource(row))});
        } else if (cache.key.startsWith('learning-result:')) {
          if(list(value.sourceIds).some(id=>sourceIds.has(id))
            || [...list(value.resume?.records),...list(value.resume?.context),...list(value.resume?.state?.context)].some(cachedSource)
            || [...list(value.existing),...list(value.legacy)].some(row=>forgottenIds.has(row?.id)||sealed(row?.content)
              ||cachedSource(row?.priorEvidence)||sourceIds.has(row?.priorEvidence?.contextId))
            || list(value.value?.memories).some(row=>row&&(forgottenIds.has(row.memoryId)||forgottenIds.has(row.legacyId)||quoted(row)||sealed(row.content)
              ||list(row.evidence).some(ref=>sealed(ref?.quote))||(row.kind===old.kind&&row.content===old.content)))
            || list(value.value?.evaluations).some(row=>row&&(forgottenIds.has(row.memoryId)||sourceIds.has(row.evidence?.id)||sealed(row.evidence?.quote))))this.setState(cache.key,null);
        } else if (Array.isArray(value)) {
          this.setState(cache.key,value.filter(row=>row&&!forgottenIds.has(row.alignment?.memoryId)
            && !list(row.source?.refs).some(ref=>ref&&(sealed(ref.quote)||evidence.some(oldRef=>oldRef.id===ref.id&&oldRef.conversationId===ref.conversationId)))
            && !(typeof row.value?.content==='string'&&row.source&&(!dedicated||forgottenScopes.has(row.value.scope))
              && memoryIdentity({...row.value,source:row.source},{legacy:!dedicated})===identity)));
        }
      }
      // Retain only a fingerprint to block replay, not the old memory text or versions.
      for (const targetId of forgottenIds) {
        const target = this.get(targetId);
        if (target.source.topic) {
          const key = topicKey(target.source);
          if (!this.state(key)) this.setState(key, targetId);
        }
        this.db.prepare("UPDATE memories SET title='',content='',source='{}',state='forgotten',revision=revision+1,updated=? WHERE id=?").run(Date.now(), targetId);
        this.db.prepare('DELETE FROM versions WHERE memory_id=?').run(targetId);
        this.record(this.get(targetId), 'forget');
      }
    });
  }

  state(key) { const row = this.db.prepare('SELECT value FROM learning_state WHERE key=?').get(key); return row ? JSON.parse(row.value) : undefined; }
  setState(key, value) {
    const write=()=>{
      if(key==='learning' && this.themeOverviewEnabled()) {
        const old=this.state('learning');
        if(!value?.enabled || !value.grantId || old?.grantId!==value.grantId)this.disableThemeOverviewInTransaction();
      }
      this.db.prepare('INSERT INTO learning_state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
    };
    // Learning configuration is sometimes changed outside an existing transaction.
    return key==='learning' && !this.transactionActive ? this.transaction(write) : write();
  }
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
  learnedTopics(scope, visible = () => true, query = '', events) {
    const queryTerms = significant(query.slice(0, 4000));
    const contexts = applicability(query.slice(0, 4000));
    const ranked = this.db.prepare("SELECT * FROM memories WHERE state IN ('active','candidate') AND json_extract(source,'$.type')='learned' ORDER BY updated DESC,id").all().map(parsed)
      .filter(row => (row.scope === scope || ['user','assistant'].includes(row.source.context.subject)) && visible(row))
      .map(row => {
        const full = [row.title, row.content, row.source.topic, ...(row.source.aliases ?? []), ...(row.source.scenarios ?? [])].join(' ');
        const words = new Set(significant(full)), applicable = applicability(full);
        return { row, score:queryTerms.filter(word => words.has(word)).length + contexts.filter(key => applicable.includes(key)).length * 3 };
      });
    const summarize = (r, proof) => ({ id:r.id, revision:r.revision, topic:r.source.topic, title:r.title,
      content:r.content, scope:r.scope, context:r.source.context, kind:r.kind, state:r.state, mode:r.source.mode,
      ...(proof?{priorEvidence:{id:proof.id,at:proof.at,text:previewText(proof.quote,180),
        ...(proof.start!==undefined?{start:proof.start}:{}),...(proof.contextId?{contextId:proof.contextId}:{})}}:{}) });
    if(events) {
      const queries=events.eventQueries.map((text,index)=>({tokens:eventTerms(text),contexts:applicability(text),priority:correctionCue(text),index}))
        .sort((a,b)=>Number(b.priority)-Number(a.priority)||(a.priority?b.index-a.index:a.index-b.index));
      const selected=new Map();
      const prior=ranked.map(({row})=>{
        const source=(row.source.refs??[]).filter(events.allowedProof).map(ref=>({ref,terms:eventTerms(ref.quote)}));
        const full=[row.title,row.content,...source.map(p=>p.ref.quote)].join(' ');
        return {row,source,terms:eventTerms(full),contexts:applicability(full)};
      });
      const fallback=prior.filter(item=>item.source.some(({ref})=>events.previousIds?.has(ref.id)));
      const byQuery=queries.map(q=>{
        const overlap=terms=>[...q.tokens].filter(term=>terms.has(term)).length;
        const related=prior.map(item=>({...item,score:overlap(item.terms)
          +q.contexts.filter(key=>item.contexts.includes(key)).length*3})).filter(item=>item.score>0)
          .sort((a,b)=>b.score-a.score||b.row.updated-a.row.updated||a.row.id.localeCompare(b.row.id)).slice(0,2);
        return (related.length?related:fallback.slice(0,1)).map(item=>{
          const proof=[...item.source].sort((a,b)=>overlap(b.terms)-overlap(a.terms)||b.ref.at-a.ref.at)[0]?.ref;
          return summarize(item.row,proof);
        });
      });
      // First give each event one candidate, with explicit corrections first.
      // Do not let early events consume the whole budget with second choices.
      for(const index of [0,1])for(const rows of byQuery){
        const row=rows[index];
        if(row&&!selected.has(row.id)&&selected.size<8)selected.set(row.id,row);
      }
      return [...selected.values()].slice(0,8);
    }
    ranked.sort((a, b) => b.score - a.score || b.row.updated - a.row.updated || a.row.id.localeCompare(b.row.id));
    return ranked.slice(0,12).map(({row})=>summarize(row));
  }
  // Called inside a write transaction. Only unconfirmed automatic hypotheses
  // can leave the working set; original rows and versions remain recoverable.
  reserveCandidate(exceptId) {
    if ((this.counts().candidate ?? 0) < 100) return;
    const candidates = this.db.prepare("SELECT * FROM memories WHERE state='candidate' AND json_extract(source,'$.type')='learned'").all().map(parsed)
      .filter(row => row.id !== exceptId && !row.replaces && row.source.mode !== 'contradicted')
      .sort((a,b) => Number(!!a.source.feedback?.length) - Number(!!b.source.feedback?.length)
        || (a.source.refs?.length ?? 0) - (b.source.refs?.length ?? 0) || observedAt(a) - observedAt(b) || a.id.localeCompare(b.id));
    const victim = candidates[0];
    if (!victim) throw memoryError('MEMORY_CAPACITY', '待观察记忆容量已满，等待后续整理');
    const source = { ...victim.source, archivedReason:'capacity', archivedAt:Date.now() };
    this.db.prepare("UPDATE memories SET state='retired',source=?,revision=revision+1,updated=? WHERE id=?").run(JSON.stringify(source),Date.now(),victim.id);
    this.record(this.get(victim.id),'candidate-archive');
  }
  findExactClaim(value, source, identity, accept = () => true) {
    return this.db.prepare(`SELECT * FROM memories
        WHERE scope=? AND kind=? AND state!='forgotten'
          AND json_extract(source,'$.namespace')=? AND json_extract(source,'$.type') IN ('learned','user-edit')
        ORDER BY CASE state WHEN 'active' THEN 0 WHEN 'candidate' THEN 1 ELSE 2 END,updated DESC,id`)
      .all(value.scope,value.kind,source.namespace).map(parsed).find(row=>memoryIdentity(row) === identity && accept(row));
  }
  learn(input, source, { explicitRequest = false, priorValid = () => true, priorIdentity, revisionOrder, alignment } = {}) {
    const value = this.normalize(input);
    source = { ...source, context: memoryContext(value.scope, source) };
    const dedicated = source.namespace === 'assistant-v4';
    const personalObservation = source.personalObservation;
    delete source.personalObservation;
    let key = topicKey(source);
    return this.transaction(() => {
      // Resolve legacy topic keys without rewriting the database. Migrate a
      // key on first update, preserving edits and forgotten-topic tombstones.
      let priorId = this.state(key);
      if (!priorId && !source.namespace) {
        const legacyId = this.state('topic:' + value.scope + ':' + source.topic);
        const legacy = legacyId && this.get(legacyId);
        if (legacy && (legacy.state === 'forgotten' || topicKey(legacy.source) === key)) priorId = legacy.id;
      }
      let prior = priorId ? this.get(priorId) : this.db.prepare("SELECT * FROM memories WHERE json_extract(source,'$.topic')=? ORDER BY updated DESC").all(source.topic).map(parsed).find(r => topicKey(r.source) === key);
      let alignmentStamp, incomingKey, priorVerified, knownReplacement, unresolved = false;
      if (alignment) {
        const selected = this.get(alignment.memoryId);
        alignmentStamp = fingerprint([alignment, value, source.refs]);
        if (!selected || !['active','candidate'].includes(selected.state)
          || selected.source.type !== 'learned' || !['support','revise','contradict','conflict'].includes(alignment.relation)
          || !priorValid(selected)
          || topicKey({ ...source, topic:selected.source.topic }) !== topicKey(selected.source)
          || value.kind !== selected.kind) throw memoryError('MEMORY_CONFLICT','待修订记忆已变化或主体不匹配');
        const personalSubject = ['user','assistant'].includes(source.context.subject);
        const compatibleScope = value.scope === selected.scope || (personalSubject && (value.scope === 'personal'
          || (['support','conflict'].includes(alignment.relation) && personalObservation && selected.scope === 'personal')));
        if (dedicated && !compatibleScope) {
          throw memoryError('MEMORY_CONFLICT','记忆适用范围不匹配');
        }
        if (selected.source.alignmentStamp === alignmentStamp) return selected;
        if (selected.revision !== alignment.revision) throw memoryError('MEMORY_CONFLICT','待修订记忆已变化，请重新核对');
        if (this.state('blocked:' + selected.id)) return selected;
        if (alignment.relation !== 'support' && observedAt({source}) < observedAt(selected)) return selected;
        if (['revise','contradict'].includes(alignment.relation) && revisionOrder &&
          observedAt({source})===observedAt(selected) && !revisionOrder(source,selected.source))return selected;
        if (alignment.relation === 'revise' && source.certainty !== 'explicit') throw memoryError('MEMORY_CONFLICT','修订已有认识需要明确的新证据');
        if (alignment.relation === 'support' && selected.source.mode === 'contradicted') throw memoryError('MEMORY_CONFLICT','已有反证的记忆需要明确修订');
        if (dedicated && alignment.relation === 'revise') {
          // An explicit correction can confirm the matching observation from
          // this topic. The old conclusion and the contender swap states.
          const confirmsContender = row => selected.state === 'active' && row.state === 'candidate' && row.source.mode === 'unresolved'
            && row.scope === selected.scope && !['procedure','experience'].includes(row.kind) && topicKey(row.source) === topicKey(selected.source)
            && !this.state('blocked:' + row.id);
          knownReplacement = this.findExactClaim(value,source,memoryIdentity({...value,source}),
            row=>row.id !== selected.id && (row.state === 'active' || confirmsContender(row)) && priorValid(row) && !this.forgottenCopy(row));
        }
        if (prior && prior.id !== selected.id && prior.id !== knownReplacement?.id
          && (!dedicated || topicKey(prior.source) !== topicKey(selected.source))) {
          throw memoryError('MEMORY_CONFLICT','待修订记忆已变化或主体不匹配');
        }
        if (!knownReplacement) incomingKey = key;
        prior = selected;
        priorVerified = true;
        source = { ...source, topic:prior.source.topic };
        key = topicKey(source);
        if (alignment.relation === 'support') Object.assign(value,{title:prior.title,content:prior.content,kind:prior.kind,scope:prior.scope});
        if (alignment.relation === 'conflict') {
          if (source.certainty!=='inferred' || memoryIdentity({...value,source})===memoryIdentity(selected))return selected;
          value.scope=selected.scope;
          const contender=this.findExactClaim(value,source,memoryIdentity({...value,source}),
            row=>row.id!==selected.id && row.state==='candidate' && row.source.mode==='unresolved');
          prior=contender;
          priorVerified=undefined;
          alignmentStamp=undefined;
          unresolved=true;
        }
      } else if (dedicated && prior?.state !== 'forgotten') {
        // A topic is a grouping hint. Match claim content and applicability
        // before reusing an ID, even when the model changes the topic or title.
        const identity = memoryIdentity({ ...value, source });
        const matches = row => row.scope === value.scope && memoryIdentity(row) === identity;
        const exact = prior && matches(prior) ? prior : this.findExactClaim(value,source,identity);
        if (exact) {
          prior = exact;
          Object.assign(value,{title:prior.title,content:prior.content});
        } else if (prior?.source.type === 'learned' && prior.source.mode !== 'contradicted' && !this.state('blocked:' + prior.id)) {
          if (prior.state === 'retired') return prior;
          const sameApplicability = prior.scope === value.scope && prior.kind === value.kind;
          // Rebuild a claim whose evidence disappeared after a branch change.
          // A valid prior requires alignment before its conclusion can change.
          if (!(sameApplicability && source.certainty === 'explicit' && !(priorVerified = priorValid(prior)))) {
            if (sameApplicability && observedAt({source}) < observedAt(prior)) return prior;
            source = {...source,topic:prior.source.topic};
            key = topicKey(source);
            unresolved = true;
            prior = undefined;
          }
        }
      }
      // A previous explicit alignment may have registered a second topic key.
      // Keep the original canonical topic when that alias is used again.
      if (prior?.source.topic && prior.source.type === 'learned'
        && topicKey({...source,topic:prior.source.topic}) === topicKey(prior.source)) {
        incomingKey ??= key;
        source = {...source,topic:prior.source.topic};key = topicKey(source);
      }
      // Carry only a host-validated explicit renewal forward during later updates.
      if (prior?.source.renewedFrom) source = { ...source, renewedFrom:prior.source.renewedFrom };
      const claim = { ...value, source };
      if (dedicated && prior && prior.state !== 'forgotten' && prior.scope === claim.scope && memoryIdentity(prior) === memoryIdentity(claim)) {
        claim.id = prior.id;
      }
      const forgotten = this.forgottenCopy(claim);
      const blocked = [prior?.state === 'forgotten' ? prior : null, forgotten].filter(Boolean);
      const renewed = explicitRequest && (!prior || prior.state === 'forgotten') && source.certainty === 'explicit' && blocked.length > 0
        && source.refs?.length > 0 && source.refs.every(ref => blocked.every(row => ref.at > row.updated)
          && !(this.state('ignored:' + ref.conversationId) ?? []).includes(ref.id));
      if (renewed) { source = { ...source, renewedFrom:[...new Set(blocked.map(row => row.id))] }; prior = undefined; }
      else if (forgotten && (!prior || prior.source.type === 'learned')) return forgotten;
      const bindTopic = (topic, id) => {
        const bound = this.state(topic);
        if (bound !== id && (!dedicated || bound === undefined || renewed)) this.setState(topic,id);
      };
      // User edits and explicit forgetting always outrank automatic learning.
      if (prior?.state === 'retired' && prior.source.archivedReason === 'capacity'
        && observedAt({source}) >= observedAt(prior)
        && source.refs.some(ref => !(prior.source.refs ?? []).some(old => old.id === ref.id && old.conversationId === ref.conversationId))) {
        // An archived hypothesis may return only with fresh independent evidence,
        // never by repeatedly replaying the batch that originally created it.
        prior = { ...prior, state:'candidate' };
      }
      if (prior && (['forgotten','retired'].includes(prior.state) || prior.source.type !== 'learned' || this.state('blocked:' + prior.id))) return prior;
      if (prior?.source.mode === 'contradicted' && !['revise','contradict'].includes(alignment?.relation)) return prior;
      // A rewound live source cannot support the new version. Keep the record
      // identity/history, but rebuild evidence and qualification from this batch.
      const evidencePrior = prior && (priorVerified ?? priorValid(prior)) ? prior : null;
      unresolved ||= prior?.source.unresolved === true;
      if (unresolved) source = {...source,unresolved:true};
      // Reuse an exact replacement and withdraw the obsolete conclusion
      // while preserving both records' histories.
      if (alignment?.relation === 'contradict' || knownReplacement) {
        if (source.certainty !== 'explicit') throw memoryError('MEMORY_CONFLICT','撤回已有认识需要明确的反证');
        const promotesContender = knownReplacement?.state === 'candidate';
        if (prior.state !== 'candidate' && !promotesContender) this.reserveCandidate(prior.id);
        const challenged = { ...source, certainty:'inferred', mode:'contradicted', alignmentStamp };
        this.db.prepare("UPDATE memories SET state='candidate',source=?,revision=revision+1,updated=? WHERE id=?").run(JSON.stringify(challenged),Date.now(),prior.id);
        bindTopic(key,prior.id); if (incomingKey && incomingKey !== key) bindTopic(incomingKey,prior.id);
        const row=this.get(prior.id);this.record(row,'learn-contradict');
        if (promotesContender) {
          const confirmed = { ...source, topic:knownReplacement.source.topic, mode:'explicit',
            aliases:boundedLabels([...(knownReplacement.source.aliases ?? []), ...(source.aliases ?? [])]),
            scenarios:boundedLabels([...(knownReplacement.source.scenarios ?? []), ...(source.scenarios ?? [])],40) };
          delete confirmed.unresolved;
          delete confirmed.renewedFrom;
          this.db.prepare("UPDATE memories SET state='active',source=?,revision=revision+1,updated=? WHERE id=?")
            .run(JSON.stringify(confirmed),Date.now(),knownReplacement.id);
          this.record(this.get(knownReplacement.id),'learn-update');
        }
        return row;
      }
      // For a global user/assistant topic, scope records provenance rather than
      // a different conclusion. Independent projects can corroborate it too.
      const sameGlobalTopic = evidencePrior && ['user','assistant'].includes(source.context.subject) && topicKey(evidencePrior.source) === key;
      const unchanged = evidencePrior && alignment?.relation !== 'revise' && ['title','content','kind'].every(k => evidencePrior[k] === value[k]) && (evidencePrior.scope === value.scope || sameGlobalTopic);
      if (evidencePrior?.source.type === 'learned' && observedAt({ source }) < observedAt(evidencePrior)) {
        if (!unchanged) return prior;
        // Older independent evidence may support the same conclusion, but must
        // not replace newer content, provenance, aliases or feedback metadata.
        source = { ...source, ...prior.source, refs: source.refs };
        value.scope = prior.scope;
      }
      const former=unchanged ? prior.source.refs : [];
      const identity = ref => ref.whole ?? priorIdentity?.(ref) ?? null;
      const proofKeys=new Set(former.map(identity).filter(Boolean));
      const literal=new Set(former.map(r=>canonicalEvidence(r.quote)).filter(Boolean));
      const incoming=dedicated?source.refs.filter(ref=>{
        const key=identity(ref), quote=canonicalEvidence(ref.quote);
        if((key && proofKeys.has(key)) || (quote && literal.has(quote)))return false;
        if(key)proofKeys.add(key);
        if(quote)literal.add(quote);
        return true;
      }):source.refs;
      if(dedicated && unchanged && !incoming.length){
        bindTopic(key,prior.id);if(incomingKey && incomingKey!==key)bindTopic(incomingKey,prior.id);
        return prior;
      }
      const refs = [...new Map([...former,...incoming].map(r => [r.conversationId + ':' + r.id, r])).values()]
        .sort((a,b) => a.at - b.at || a.conversationId.localeCompare(b.conversationId) || a.id.localeCompare(b.id)).slice(-12);
      const support = new Set(refs.map(r => identity(r) ?? r.fingerprint)).size;
      const qualified = source.certainty === 'explicit' || support >= 2;
      let state = !unresolved && !['procedure','experience'].includes(value.kind) && qualified ? 'active' : 'candidate';
      if (unchanged && prior?.state === 'active') state = 'active';
      if (evidencePrior?.state === 'active' && state === 'candidate') return prior;
      source = { ...source, refs, ...(alignmentStamp ? {alignmentStamp} : {}),
        ...(unchanged ? { aliases:boundedLabels([...(prior.source.aliases ?? []), ...(source.aliases ?? [])]), scenarios:boundedLabels([...(prior.source.scenarios ?? []), ...(source.scenarios ?? [])],40) } : {}),
        ...(unchanged && prior?.source.feedback ? { feedback:prior.source.feedback } : {}), mode: unresolved ? 'unresolved' : unchanged && prior?.source.mode === 'feedback-supported' ? 'feedback-supported' : state === 'active' ? (source.certainty === 'explicit' ? 'explicit' : 'supported') : 'hypothesis' };
      if (unchanged && JSON.stringify(prior.source.refs) === JSON.stringify(refs) && prior.state === state) {
        bindTopic(key,prior.id); if (incomingKey && incomingKey !== key) bindTopic(incomingKey,prior.id);
        return prior;
      }
      const persistedState=prior ? this.get(prior.id)?.state : null;
      if (state === 'candidate' && persistedState !== 'candidate') this.reserveCandidate(prior?.id);
      const counts = this.counts();
      if (state === 'active' && (counts.active ?? 0) >= 1000 && persistedState !== 'active') throw memoryError('MEMORY_CAPACITY','正式记忆容量已满，已有记忆保留');
      if (!prior && Object.values(counts).reduce((a,b) => a+b,0) >= 10000) throw memoryError('MEMORY_CAPACITY','记忆容量已满，已有记录保留');
      const now = Date.now(), id = prior?.id ?? randomUUID();
      if (prior) this.db.prepare('UPDATE memories SET title=?,content=?,kind=?,scope=?,source=?,state=?,revision=revision+1,updated=? WHERE id=?').run(value.title,value.content,value.kind,value.scope,JSON.stringify(source),state,now,id);
      else this.db.prepare('INSERT INTO memories VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,value.title,value.content,value.kind,value.scope,state,JSON.stringify(source),1,now,now,null,null,fingerprint(renewed ? ['learning',key,source.refs.map(ref=>[ref.conversationId,ref.id])] : unresolved ? ['learning-unresolved',id] : ['learning',key]));
      if (prior || !unresolved) bindTopic(key,id);
      if (incomingKey && incomingKey !== key) bindTopic(incomingKey,id);
      const row = this.get(id); this.record(row, prior ? 'learn-update' : 'learn'); return row;
    });
  }


  evaluate(id, decision, ref) {
    if (!['support','reject'].includes(decision)) return;
    return this.transaction(() => {
      const row = this.get(id);
      if (!row || !['active','candidate'].includes(row.state) || row.source.type !== 'learned' || !['procedure','experience'].includes(row.kind)) return;
      if (row.source.unresolved && decision === 'support') return;
      if (row.source.refs.some(r => r.conversationId === ref.conversationId && r.id === ref.id) || ref.at <= observedAt(row)) return;
      const feedback = row.source.feedback ?? [];
      if (feedback.some(f => f.conversationId === ref.conversationId && f.id === ref.id)
        || feedback.some(f => f.fingerprint === ref.fingerprint || (f.whole && f.whole===ref.whole))
        || row.source.refs.some(old=>ref.whole && old.whole===ref.whole)) return;
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
  recallCandidates(tokens, limit=24, offset=0) {
    if (!tokens.length) return [];
    this.ensureRecallIndex();
    const terms=[...new Set(tokens)].map(w=>'"'+w.replaceAll('"','""')+'"');
    const match=terms.join(' OR ');
    return this.db.prepare(`SELECT m.* FROM memory_search JOIN memories m ON m.id=memory_search.id
      WHERE memory_search MATCH ? AND m.state='active' ORDER BY bm25(memory_search),m.id LIMIT ? OFFSET ?`)
      .all(match,limit,offset).map(parsed);
  }
  ftsRanks(words, eligible) {
    const match = words.map(w=>'"'+w.replaceAll('"','""')+'"').join(' OR ');
    if (!match || !eligible.length) return new Map();
    return new Map(this.db.prepare(`SELECT id FROM memory_search WHERE memory_search MATCH ?
      AND id IN (SELECT value FROM json_each(?)) ORDER BY bm25(memory_search),id LIMIT 1000`)
      .all(match,JSON.stringify(eligible)).map(({id},rank)=>[id,rank]));
  }
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

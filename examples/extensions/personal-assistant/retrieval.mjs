import { terms, indexStyle, exactIndexTerm } from './store.mjs';
import { identifiers } from './precision.mjs';
import { observedAt, memoryIdentity, applicability } from './memory-context.mjs';
export const norm = s => s.normalize('NFKC').toLocaleLowerCase('en-US');
const stop = new Set(['用户','个人','我的','你的','我是','你是','我想','请问','这个','那个','一下','什么','多少','是否','知道','关于','现在','之前','记录','记忆','请帮','帮我','the','what','about','does','this','that','user','please','with','have','from']);
export const words = s => terms(s).filter(w=>!stop.has(w) && [...w].length>=2);
export const ftsTerms = terms => terms.length<=96 ? terms : [...terms.slice(0,48),...terms.slice(-48)];
export function queryPlan(query) {
  const value=norm(query), expanded=[];
  const age=/(?:年龄|多少岁|几岁|多大|出生|how old|\bage\b|birth)/i.test(value);
  const specialty=/(?:专业|学科|教什么|研究方向|major|specialty|discipline)/i.test(value);
  const identity=/(?:我是谁|我叫什么|我的名字|称呼我|my name|who am i)/i.test(value);
  if(age) expanded.push('年龄','岁','出生','age','born');
  if(specialty) expanded.push('专业','学科','教授','教师','教学','研究','major','discipline');
  if(identity) expanded.push('姓名','名字','称呼','name');
  return {value,terms:words(value),expanded,contexts:applicability(value),profile:/(?:对我的了解|了解我|关于我|我的背景|know about me|(?:用户|主人).*(?:背景|习惯|偏好))/.test(value)};
}
export const defaultStyle = indexStyle;
// Every matched candidate is scored before authorization; only a bounded
// window of the best candidates is prefetched and validated at a time.
export const recallWindow = 24;
export function retrieve(assistant, session, query, limit=8, automatic=false, fts, options={}) {
  const plan=queryPlan(query), valid=assistant.learning.validator(), projects=assistant.snapshot().projects;
  const exact=identifiers(plan.value), ranked=[];
  let rows;
  // unicode61 drops standalone underscores which the existing word matcher keeps.
  if(options.legacy || plan.terms.some(term=>/^_+$/u.test(term)) || typeof assistant.store.recallCandidates !== 'function') rows=assistant.store.activeMemories();
  else {
    const lexical=[...new Set([...plan.terms,...plan.expanded])], lanes=[];
    if(exact.length)lanes.push(exact.map(exactIndexTerm));
    for(let i=0;i<lexical.length;i+=64)lanes.push(lexical.slice(i,i+64));
    const routing=[...plan.contexts.map(key=>'route'+key),...(plan.profile?['routeprofile']:[]),...(automatic?['routestyle']:[])];
    if(routing.length)lanes.push(routing);
    try {
      const candidates=new Map();
      // Active memories are limited to 1000. Read the complete matching set,
      // not just the highest BM25 page, and deduplicate across query lanes.
      for(const lane of lanes) for(const row of assistant.store.recallCandidates(lane,1000,0)) candidates.set(row.id,row);
      rows=[...candidates.values()];
    } catch { rows=assistant.store.activeMemories(); }
  }
  for(const row of rows) {
    if(options.accept && !options.accept(row)) continue;
    const c=row.source.context ?? {}, full=norm(row.title+' '+row.content+' '+[...(row.source.aliases ?? []),...(row.source.scenarios ?? [])].join(' '));
    const set=new Set(words(full)), actual=new Set(identifiers(full,true));
    const exactCount=exact.filter(value=>actual.has(value)).length;
    const hits=plan.terms.filter(w=>set.has(w));
    const concept=plan.expanded.filter(w=>/\p{Script=Han}/u.test(w) ? full.includes(w) : set.has(w));
    const contexts=applicability(full), applicable=plan.contexts.filter(key=>contexts.includes(key));
    const personal=['user','assistant'].includes(c.subject), broad=plan.profile && personal, style=automatic && defaultStyle(row);
    if(!hits.length && !concept.length && !applicable.length && !broad && !style && !exactCount) continue;
    const foreign=c.projectId && c.projectId!==session.projectId && !personal;
    if(automatic && foreign) {
      const projectName=c.projectName ?? projects.find(p=>p.id===c.projectId)?.name;
      if(!(projectName && plan.value.includes(norm(projectName))) && !(row.title.length>=4 && plan.value.includes(norm(row.title)))) continue;
    }
    const score=hits.length*3+concept.length*5+applicable.length*4+(broad?5:0)+(style?2:0)+(c.projectId && c.projectId===session.projectId?1:0);
    ranked.push({row,score,style,exactCount,observed:observedAt(row)});
  }
  if(fts && plan.terms.length && ranked.length) {
    try {
      const ranks=assistant.store.ftsRanks(ftsTerms(plan.terms),ranked.map(item=>item.row.id));
      for(const item of ranked) if(ranks.has(item.row.id)) item.score+=1/(1+ranks.get(item.row.id)/8);
    } catch { /* Ranking bonus is optional. */ }
  }
  ranked.sort((a,b)=>b.exactCount-a.exactCount || b.score-a.score || b.observed-a.observed || a.row.id.localeCompare(b.row.id));
  const chosen=[],seen=new Set(),window=options.window===12?12:recallWindow;let styles=0;
  for(let offset=0;offset<ranked.length && chosen.length<limit;offset+=window) {
    const batch=ranked.slice(offset,offset+window);
    valid.prefetch?.(batch.map(item=>item.row));
    for(const item of batch) {
      const r=item.row,key=memoryIdentity(r);
      if(seen.has(key) || (item.style && styles>=2 && !plan.terms.some(w=>words(r.title+' '+r.content).includes(w)) && !plan.profile)) continue;
      if(!valid(r))continue;
      const admission=options.admit?.(r);
      if(admission==='stop') return chosen;
      if(admission===false)continue;
      seen.add(key);chosen.push(r);if(item.style)styles++;
      if(chosen.length>=limit)break;
    }
  }
  return chosen;
}

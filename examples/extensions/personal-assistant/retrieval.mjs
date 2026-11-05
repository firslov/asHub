import { terms } from './store.mjs';
import { observedAt, memoryIdentity } from './memory-context.mjs';
const norm = s => s.normalize('NFKC').toLocaleLowerCase('en-US');
const stop = new Set(['用户','个人','我的','你的','我是','你是','我想','请问','这个','那个','一下','什么','多少','是否','知道','关于','现在','之前','记录','记忆','请帮','帮我','the','what','about','does','this','that','user','please','with','have','from']);
const words = s => terms(s).filter(w=>!stop.has(w) && [...w].length>=2);
export function queryPlan(query) {
  const value=norm(query), expanded=[];
  const age=/(?:年龄|多少岁|几岁|多大|出生|how old|\bage\b|birth)/i.test(value);
  const specialty=/(?:专业|学科|教什么|研究方向|major|specialty|discipline)/i.test(value);
  const identity=/(?:我是谁|我叫什么|我的名字|称呼我|my name|who am i)/i.test(value);
  if(age) expanded.push('年龄','岁','出生','age','born');
  if(specialty) expanded.push('专业','学科','教授','教师','教学','研究','major','discipline');
  if(identity) expanded.push('姓名','名字','称呼','name');
  return {value,terms:words(value),expanded,profile:/(?:对我的了解|了解我|关于我|我的背景|know about me|(?:用户|主人).*(?:背景|习惯|偏好))/.test(value)};
}
const defaultStyle = row => ['preference','principle'].includes(row.kind) && row.source.context?.subject==='user'
  && /回答|回复|表达|语言|称呼|简洁|中文|english|response|answer|tone/i.test(row.title+' '+row.content)
  && !/如果|当.+时|仅在|只在|这个项目|本项目|修改|写代码|when |if |only /i.test(row.content);
export function retrieve(assistant, session, query, limit=8, automatic=false) {
  const plan=queryPlan(query), ranked=[], valid=assistant.learning.validator();
  const projects=assistant.snapshot().projects;
  for(const row of assistant.store.activeMemories()) {
    if(!valid(row)) continue;
    const c=row.source.context ?? {}, full=norm(row.title+' '+row.content+' '+(row.source.aliases ?? []).join(' ')), set=new Set(words(full));
    const hits=plan.terms.filter(w=>set.has(w));
    const concept=plan.expanded.filter(w=>/\p{Script=Han}/u.test(w) ? full.includes(w) : set.has(w));
    const personal=['user','assistant'].includes(c.subject);
    const broad=plan.profile && personal;
    const style=automatic && defaultStyle(row);
    if(!hits.length && !concept.length && !broad && !style) continue;
    // Global explicit search can find other projects. Automatic context needs a
    // named project/title before bringing another project's specific conclusion in.
    const foreign=c.projectId && c.projectId!==session.projectId && !personal;
    if(automatic && foreign) {
      const projectName=c.projectName ?? projects.find(p=>p.id===c.projectId)?.name;
      if(!(projectName && plan.value.includes(norm(projectName))) && !(row.title.length>=4 && plan.value.includes(norm(row.title)))) continue;
    }
    const score=hits.length*3+concept.length*5+(broad?5:0)+(style?2:0)+(c.projectId && c.projectId===session.projectId?1:0);
    ranked.push({row,score,style,observed:observedAt(row)});
  }
  ranked.sort((a,b)=>b.score-a.score || b.observed-a.observed || a.row.id.localeCompare(b.row.id));
  const chosen=[],seen=new Set();let styles=0;
  for(const item of ranked) {
    const r=item.row,key=memoryIdentity(r);
    if(seen.has(key) || (item.style && styles>=2 && !plan.terms.some(w=>words(r.title+' '+r.content).includes(w)) && !plan.profile)) continue;
    seen.add(key);chosen.push(r);if(item.style)styles++;
    if(chosen.length>=limit)break;
  }
  return chosen;
}

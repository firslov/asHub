import { DatabaseSync } from 'node:sqlite';
import { forgetCommand, generatedHistory, historyGuard, sensitiveHistory, normalizedClaim } from './forgotten-history.mjs';
import { ftsTerms, norm, words } from './retrieval.mjs';
import { identifiers, valueTokens } from './precision.mjs';
import { previewText } from './store.mjs';

const maxEntries = 96, maxSourceChars = 12000, maxScannedChars = 120000;
const noise = new Set(['当时','以前','过去','告诉','记得','提到','说过','怎么','如何','哪里','哪个','哪些','有没有','帮忙','能否','可以','应该','是不是','相关','一下','具体','对应','使用','之前']);


export function completeHistory(api, grantId, id, sourceId, needComplete=true) {
  const first = api.entry(grantId,id,sourceId,0);
  if (first.id!==sourceId || (first.offset??0)!==0 || typeof first.text!=='string') throw Error('历史记录位置不匹配');
  if(!needComplete)return {...first,more:false}; // Only test role and header; caller returns the original page.
  let {text,more,nextOffset} = first;
  while (more && text.length < maxSourceChars) {
    if(nextOffset!==text.length || nextOffset<=0)throw Error('历史记录位置不连续');
    const part=api.entry(grantId,id,sourceId,nextOffset);
    if(part.id!==first.id || part.role!==first.role || part.offset!==nextOffset || !part.text)throw Error('历史记录位置不连续');
    text+=part.text; ({more,nextOffset}=part);
  }
  return {...first,text,more:!!more || text.length>maxSourceChars,nextOffset};
}
export function originalGuard(assistant,id,grantId) {
  return historyGuard(assistant.store,id,ref=>completeHistory(assistant.services.background,grantId,id,ref));
}
export function eligibleOriginal(row,guard) {
  return guard.complete && row.role==='user' && !row.more && !guard.ignored.has(row.id)
    && !generatedHistory.test(row.text.trimStart()) && !forgetCommand.test(row.text.trimStart())
    && !sensitiveHistory.test(row.text) && !guard.matches(row.text);
}
export function recentOriginals(assistant,id,currentText) {
  if (!assistant.dedicated || id!==assistant.conversationId()) return [];
  const c=assistant.learning.config(), api=assistant.services.background;
  if (!c.enabled || !c.grantId || !api?.latestUser || !api.entry) return [];
  const grant=api.status(c.grantId);
  if(grant.includedIds?.length!==1 || grant.includedIds[0]!==id || grant.excludedIds?.includes(id))return [];
  const guard=originalGuard(assistant,id,c.grantId);
  if(!guard.complete)return [];
  let cursor=api.latestUser(c.grantId,id);
  const current=currentText && norm(currentText.trim()), result=[], visited=new Set();
  let scanned=0;
  while (cursor && visited.size<maxEntries && !visited.has(cursor)) {
    visited.add(cursor);
    const first=api.entry(c.grantId,id,cursor,0);
    // Do not request tool, assistant or generated payload continuations.
    if (first.role==='user' && !guard.ignored.has(cursor) && !generatedHistory.test(first.text.trimStart())
      && !(visited.size===1 && current && (first.more ? current.startsWith(norm(first.text)) : current===norm(first.text.trim())))) {
      const row=first.more ? completeHistory(api,c.grantId,id,cursor) : first;
      scanned+=row.text.length;
      if(scanned>maxScannedChars)break;
      if(eligibleOriginal(row,guard))result.push(row);
    }
    cursor=first.previousId;
  }
  return result;
}
function snippets(text) {
  const values=[];
  for(const sentence of text.split(/(?<=[。！？!?；;])|\n+/u)) {
    let start=0;
    while(start<sentence.length) {
      const cut=previewText(sentence.slice(start),360);
      if(cut.trim())values.push(cut.trim());
      if(start+cut.length>=sentence.length)break;
      start+=previewText(cut,cut.length-64).length;
    }
  }
  return values;
}
export const historyDocs = rows => rows.flatMap(row=>snippets(row.text).map((text,index)=>({
  id:row.id+':'+index, sourceId:row.id, at:row.at, text,
})));
export function rankHistory(docs,query) {
  const plan = ftsTerms(words(query).filter(w=>!noise.has(w)));
  const exact = new Set(identifiers(query));
  if(!plan.length && !exact.size || !docs.length)return [];
  // Encode words as single tokens, including numbers with punctuation. The
  // Unicode tokenizer cannot otherwise treat a hyphenated identifier atomically.
  const encode=w=>'w'+Buffer.from(w).toString('hex');
  const expr=[...new Set([...exact,...plan])].map(encode).join(' OR ');
  const db=new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA temp_store=MEMORY; CREATE VIRTUAL TABLE hits USING fts5(words); BEGIN');
    const insert=db.prepare('INSERT INTO hits(rowid,words) VALUES(?,?)');
    const cached = new Map();
    const tokenSets=docs.map(({text},i)=>{
      let entry=cached.get(text);
      if(!entry){
        const tokens=new Set([...words(text),...identifiers(text,true)]);
        entry={tokens,encoded:[...tokens].map(encode).join(' ')};
        cached.set(text,entry);
      }
      insert.run(i+1,entry.encoded);
      return entry.tokens;
    });
    db.exec('COMMIT');
    const ranked=[];
    for(const row of db.prepare('SELECT rowid,bm25(hits) AS rank FROM hits WHERE hits MATCH ? ORDER BY rank,rowid').all(expr)) {
      const i=row.rowid-1, tokens=tokenSets[i];
      const matched=plan.filter(w=>tokens.has(w));
      const exactHits=[...exact].filter(w=>tokens.has(w)).length;
      if (exact.size ? !exactHits : matched.length < (plan.length<=2 ? 1 : 2)) continue;
      ranked.push({...docs[i],score:row.rank,exactHits});
    }
    return ranked.sort((a,b)=>b.exactHits-a.exactHits||a.score-b.score||b.at-a.at||a.id.localeCompare(b.id));
  } finally { db.close(); }
}
export function alreadyVisible(text,prior) {
  const body=normalizedClaim(text), values=valueTokens(text), known=new Set(valueTokens(prior));
  const shown=normalizedClaim(prior);
  // Merely mentioning a short name or identifier in a question does
  // not supply the earlier answer that consisted only of that value.
  return !!body && values.every(value=>known.has(value)) && (body.length<8?shown===body:shown.includes(body));
}
export function exactNumberMatch(query,text) {
  const exact=identifiers(query);
  return !exact.length || exact.some(id=>identifiers(text,true).includes(id));
}
export function overlapsClaim(a,b) {
  const valuesA=new Set(valueTokens(a)), valuesB=new Set(valueTokens(b));
  if(valuesA.size && valuesB.size && (valuesA.size!==valuesB.size || [...valuesA].some(v=>!valuesB.has(v))))return false;
  const x=normalizedClaim(a),y=normalizedClaim(b);
  if(Math.min(x.length,y.length)>=8 && (x.includes(y)||y.includes(x)))return true;
  const old=new Set(words(a)), next=words(b);
  return Math.min(old.size,next.length)>=4 && next.filter(w=>old.has(w)).length/Math.max(old.size,next.length)>=0.72;
}

// A small, deterministic view over the authorized batch. Span offsets are
// UTF-16 offsets in the original message, never synthetic evidence or a cursor.
import { identifiers } from './precision.mjs';

const gap = 6 * 60 * 60 * 1000;
const shift = /^(?:换个话题|另一个话题|回到(?:刚才|之前)|接下来(?:聊|谈|处理)|另一个(?:问题|任务)|新话题|另外(?:[，,:：]|关于)|unrelated|new topic|separately)/iu;
const linked = /^(?:更正|纠正|刚才|我(?:改主意|说错|收回)|不是|不对|补充|还是|那(?:就|么|件)|而是|也就是|correction|actually|instead)/iu;
export const correctionCue = text => /更正|纠正|说错|收回|撤回|不再|从今|改(?:成|用|为)|correction|no longer|from now on/iu.test(text);
const stop = new Set(['用户','助手','知道','这个','那个','现在','今天','可以','我的','这次','本次','之前','刚才','默认','我','你','the','and','for','you','your']);
const segmenter = new Intl.Segmenter('zh',{granularity:'word'});
const clauses = /[。！？!?；;\n]\s*(?=(?:换个话题|另一个(?:话题|问题|任务)|回到(?:刚才|之前)|新话题|另外(?:[，,:：]|关于)|new topic|separately))/giu;

export const eventTerms = value => {
  const text=value.normalize('NFKC').toLowerCase();
  const tokens=new Set(identifiers(text));
  let lastHan=null;
  for(const {segment,isWordLike} of segmenter.segment(text)) {
    if(isWordLike && segment.length>=2 && !stop.has(segment) && !/^\d+$/.test(segment))tokens.add(segment);
    // ICU often splits less common Chinese names into single characters.
    const single=/^\p{Script=Han}$/u.test(segment);
    if(single&&lastHan)tokens.add(lastHan+segment);
    lastHan=single?segment:null;
  }
  return tokens;
};

export const canonicalEvidence = value => (value??'').normalize('NFKC').trim()
  .replace(/[。！？!?]+$/u,'').replace(/\s+/gu,' ');

function pieces(row) {
  const parts=[];
  let start=0;
  for(const m of row.text.matchAll(clauses)) {
    const end=m.index+m[0].length;
    if(row.text.slice(start,end).trim())parts.push([start,end]);
    start=end;
  }
  if(row.text.slice(start).trim())parts.push([start,row.text.length]);
  return parts;
}
const direct = (a,b) => a && (a.id===b.id || (b.previousId===undefined || b.previousId===a.id));
const answerTo = (a,b) => a.role==='assistant' && b.role==='user'
  && (b.text.trim().length<=24 || linked.test(b.text.trim()))
  && /[?？]\s*$/u.test(a.text);
export function segmentEvents(records, context = []) {
  const events=[];
  const contextual=new Set(context);
  let current,last,lastUserTerms;
  for(const row of [...context,...records]) {
    if(!row || !['user','assistant'].includes(row.role) || !row.text?.trim()) {current=null;last=null;continue;}
    for(const [start,end] of pieces(row)) {
      const text=row.text.slice(start,end), terms=row.role==='user'?eventTerms(text):null;
      const closeAnswer=last && direct(last,row) && answerTo(last,row);
      const bridge=closeAnswer && current?.parts.at(-1);
      const likelyShift=terms?.size>=3 && lastUserTerms?.size>=3
        && ![...terms].some(term=>lastUserTerms.has(term)) && !linked.test(text.trimStart()) && !closeAnswer;
      if(!current || !direct(last,row) || (last.id!==row.id && row.at-last.at>=gap && !closeAnswer)
        || shift.test(text.trimStart()) || likelyShift || current.parts.length>=6 || current.chars+text.length>4500) {
        current={parts:[],chars:0};lastUserTerms=null;events.push(current);
        if(bridge && bridge.text.length+text.length<=4500 && !bridge.row.truncated && !(bridge.row.offset>0)){
          current.parts.push({...bridge,context:true});current.chars+=bridge.text.length;
        }
      }
      current.parts.push({row,text,id:row.id,start:(row.offset??0)+start,end:(row.offset??0)+end,
        ...(contextual.has(row)?{context:true}:{})});
      current.chars+=text.length;last=row;
      if(terms?.size>=2)lastUserTerms=terms;
    }
  }
  return events.filter(event=>event.parts.some(p=>p.row.role==='user'&&!p.context)).map(event=>event.parts);
}

export const eventSpans = events => events.map(parts=>parts.map(({id,start,end,context})=>({id,start,end,...(context?{context:true}:{})})));

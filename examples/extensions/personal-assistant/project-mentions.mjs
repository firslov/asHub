// A name embedded in an uninterrupted identifier or Chinese name is not a
// standalone project mention. Common sentence markers delimit a mention.
const beforeMarker=/(?:关于|针对|对于|提到|负责|推进|支持|关注|以及|参与|梳理|总结|概览|比较|项目|给我|在|对|将|为|给|从|由|和|与)$/u;
const afterMarker=/^(?:项目|的|已经|已|将|曾|最初|后来|随后|目前|现在|最终|决定|确定|选用|采用|改为|选择|和|与|及|是|在|由|要|会|需要|方案|决策|路线|设计|架构|选型|主题|如何|为什么|演变|变化|脉络|历程|取舍|过去|长期)/u;
export function projectNameLeftBoundary(before,latin) {
  if(latin)return !/[a-z0-9_]/i.test(before.at(-1)??'');
  return !/[\p{L}\p{N}_]/u.test(before.at(-1)??'') || beforeMarker.test(before);
}
export function projectNameRightBoundary(after,latin) {
  if(latin)return !/[a-z0-9_]/i.test(after[0]??'');
  return !/\p{Script=Han}/u.test(after[0]??'') || afterMarker.test(after);
}

// An adjacent word can be part of a longer name even if it contains a
// decision verb. Require a complete decision phrase or an explicit separator.
const decisionLead=/^(?:项目)?(?:(?:已经|已|最初|后来|随后|目前|现在|最终|正式)\s*)*/u;
const compoundDecision=/(?:决定|确定)[ \t]*(?:采用|选用|使用|改为|选择|选定|定为)/u;
const nextProjectMention=/^(?:和|与|及|以及)\s*(?:项目|project\s)/iu;
const clauseBreak=/[。！？、，；：,;:!?（）()「」“”\n]/u;
const explicitSelection=/(?:选择|选定|敲定|确定)[ \t]*(?:方案|选项|版本)/u;
const directDecision=/(?:(?:采用|选用)(?![率度])(?:了)?|改为|选定|敲定|定为|(?:选|定|更换|停用|启用|保留)了)/u;
const englishDecision=/\b(?:already\s+|then\s+)?(?:decided\s+to|chose|selected)\b/i;
// A nominal predicate followed by a copula (选定的是…) still asserts a
// decision. Only a following noun phrase turns the predicate into a modifier.
const relativeDecision=/^[ \t]*(?:(?:过了|过|了|好|后)[ \t]*)?的[ \t]*(?!(?:是|为|即|就是|不是|并非))[\p{L}\p{N}]/u;
const decisionPatterns=[compoundDecision,explicitSelection,directDecision,englishDecision].map(pattern=>
  new RegExp(pattern.source,pattern.flags+'g'));
function compoundDecisionLength(rest) {
  const lead=rest.match(decisionLead)[0].length;
  const match=compoundDecision.exec(rest.slice(lead));
  if(match?.index===0)return lead+match[0].length;
  if(rest[0]==='的' && match && match.index>1 && match.index<=33 && !clauseBreak.test(rest.slice(0,match.index)))return match.index+match[0].length;
  return 0;
}
export function projectEvidenceRightBoundary(after) {
  const rest=after.trimStart();
  if(!rest || clauseBreak.test(rest[0]) || nextProjectMention.test(rest))return true;
  return compoundDecisionLength(rest)>0 || (rest!==after && englishDecision.exec(rest)?.index===0);
}

export function projectDecisionPhraseLength(clause) {
  const compound=compoundDecisionLength(clause);
  if(compound && !relativeDecision.test(clause.slice(compound)))return compound;
  const lead=clause.match(decisionLead)[0].length;
  const afterLead=clause.slice(lead);
  const selection=explicitSelection.exec(afterLead);
  if(selection?.index===0 && !relativeDecision.test(afterLead.slice(selection[0].length)))return lead+selection[0].length;
  const direct=directDecision.exec(afterLead);
  if(direct?.index===0 && !relativeDecision.test(afterLead.slice(direct[0].length)))return lead+direct[0].length;
  const english=englishDecision.exec(clause);
  return english?.index===0 ? english[0].length : 0;
}

export function hasUnboundProjectDecision(text) {
  // A predicate used as a relative modifier describes the chosen object.
  // It does not assert another decision about that object.
  return decisionPatterns.some(pattern=>[...text.matchAll(pattern)].some(match=>
    !relativeDecision.test(text.slice(match.index+match[0].length))));
}

export function projectMentionForms(name) {
  const quotes=[['「','」'],['『','』'],['“','”'],['"','"'],['《','》']];
  return [name,...quotes.map(([left,right])=>left+name+right)].flatMap((label,i)=>[
    {term:'项目'+label}, {term:'项目 '+label}, {term:label+'项目',suffix:true}, {term:'project '+label,english:true},
  ].map(form=>({...form,quoted:i>0})));
}

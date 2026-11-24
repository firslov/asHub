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

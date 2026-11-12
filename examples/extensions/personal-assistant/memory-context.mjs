const userVoice = /(?:我(?:是一名|是一个|是位|是\d|今年|叫|从事|任职|教授|教的是|的(?:年龄|专业|职业|姓名|生日))|\b(?:I am|I'm|I work|my (?:age|name|profession|preference))\b)/i;
const quoted = /(?:假设|假如|例如|举例|他说|她说|客户说|学生说|文中|文章|引用|台词|角色扮演|suppose|for example|he said|she said)/i;
export function explicitUser(refs = []) { return refs.length > 0 && refs.every(r => userVoice.test(r.quote ?? '') && !quoted.test(r.quote ?? '')); }
export function memoryContext(scope, source = {}) {
  const prior = source.context ?? {};
  const subject = prior.subject ?? (source.type === 'learned' && source.certainty === 'explicit' && explicitUser(source.refs) ? 'user' : scope === 'personal' ? 'user' : scope.startsWith('project:') ? 'project' : 'other');
  return { ...prior, subject, origin:prior.origin ?? scope,
    ...(scope.startsWith('project:') && !prior.projectId ? {projectId:scope.slice(8)} : {}),
    ...(!prior.conversationId && (scope.startsWith('conversation:') || source.conversationId || source.refs?.[0]?.conversationId) ? {conversationId:scope.startsWith('conversation:') ? scope.slice(13) : source.conversationId ?? source.refs[0].conversationId} : {}),
  };
}
export function topicKey(source) {
  const c=source.context ?? {};
  const domain=c.subject==='user' || c.subject==='assistant' ? c.subject : c.projectId ? 'project:'+c.projectId : c.conversationId ? 'origin:'+c.conversationId : 'general';
  return 'topic:global:'+(source.namespace ? source.namespace+':' : '')+domain+':'+source.topic;
}
export function observedAt(row) {
  const refs=row.source.refs ?? [];
  return refs.length ? Math.max(...refs.map(r=>Number(r.at)||0)) : row.source.at ?? row.created;
}

// Small, local applicability groups. These route already-evidenced memories;
// they do not infer facts about the user or issue additional model requests.
const contexts = [
  ['food', /饮食|吃饭|晚餐|早餐|午餐|菜单|聚餐|用餐|食谱|忌口|过敏|花生|素食|\b(?:meal|dinner|lunch|breakfast|food|allerg\w*|diet|vegetarian)\b/iu],
  ['residence', /居住|住在|搬到|搬家|定居|所在地|现住|\b(?:residen\w*|moved?|living|live)\b/iu],
  ['occupation', /职业|任职|工作单位|大学教师|教授|老师|律师|医生|转行|\b(?:profession|occupation|teacher|professor|lawyer|career)\b/iu],
];
export function applicability(value) {
  return contexts.filter(([key, pattern]) => pattern.test(value)
    && !(key === 'food' && /菜单(?:栏|按钮|样式|组件|布局)|右键菜单|导航菜单|\bmenu (?:bar|button|component)|\bdropdown\b/iu.test(value))).map(([key]) => key);
}

// Exact content identity, not a semantic similarity guess. Keep word boundaries
// and meaningful punctuation (decimal points, signs, code operators).
export function memoryIdentity(row) {
  const c = memoryContext(row.scope, row.source);
  const domain = ['user','assistant'].includes(c.subject) ? null : c.projectId ?? c.conversationId;
  const content = row.content.normalize('NFKC').trim().replace(/\s+/g,' ').replace(/[。.!！?？]+$/u,'');
  return JSON.stringify([row.kind, c.subject, domain, content]);
}

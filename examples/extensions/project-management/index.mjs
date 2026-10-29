/** Project-specific orchestration. Mutations and authorization belong to the host. */
export default function activate(ctx) {
  if (!ctx.agent) throw new Error('项目管理需要 agent 对话');
  const available = () => ctx.list().includes('ashub:catalog') && ctx.list().includes('ashub:execute');
  const call = async (name, payload) => {
    if (!available()) throw new Error('当前 asHub 不支持通用插件操作接口 v1，请升级客户端');
    return await ctx.call(name, payload);
  };
  const register = (name, description, properties, required, run, readOnly = false) => ctx.agent.registerTool({
    name, description, readOnly,
    // The host requests explicit approval itself. A generic file-write approval
    // would both double-prompt and permit session auto-approval to bypass intent.
    modifiesFiles: false,
    input_schema: { type: 'object', properties, required, additionalProperties: false },
    async execute(args, _onChunk, execution) {
      try {
        execution?.signal?.throwIfAborted();
        const result = await run(args, execution?.signal);
        return { content: JSON.stringify(result), exitCode: result?.status === 'failed' || result?.status === 'interrupted' || result?.status === 'denied' ? 1 : 0,
          isError: ['failed', 'interrupted', 'denied'].includes(result?.status) };
      } catch (error) { return { content: String(error), exitCode: 1, isError: true }; }
    },
  });
  const requestKey = { type: 'string', minLength: 8, maxLength: 100, pattern: '^[\\w-]+$', description: 'Unique plan key. Reuse exactly on retries; never change it to bypass a denial or an uncertain result.' };
  register('project_management_catalog', '查看项目、已有对话配置和忙闲状态、可用模型及思考强度。规划或修改成员前必须查询，不猜测对话、模型或项目 ID。', {}, [],
    (_args, signal) => call('ashub:catalog', { signal }), true);
  register('project_management_create_project', '提出新建项目方案，等待用户在授权卡片确认后才创建。默认将当前对话加入项目作为协调者；加入会将其移出原项目。不会启动任何成员任务。', {
    requestKey, name: { type: 'string', maxLength: 80 }, cwd: { type: 'string', description: 'Existing absolute project root directory' },
    includeCurrent: { type: 'boolean', default: true },
  }, ['requestKey', 'name', 'cwd'], async (args, signal) => {
    const catalog = await call('ashub:catalog', { signal });
    return call('ashub:execute', { signal, request: { idempotencyKey: args.requestKey, operations: [{ type: 'project.create',
      input: { name: args.name, cwd: args.cwd, members: args.includeCurrent === false ? [] : [catalog.currentId] } }] } });
  });
  register('project_management_create_members', '为已有项目或独立工作创建对话成员。将每人的职责写入 instructions；用户必须确认具体参数。仅创建，不自动发送任务或调用成员模型。一次最多 12 人。失败时检查返回的已有对话 ID，只对未创建项另提方案，不能重放整个团队。', {
    requestKey,
    members: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'object', additionalProperties: false, properties: {
      title: { type: 'string', maxLength: 100 }, instructions: { type: 'string', maxLength: 8000, description: '职责、交付物、协作要求。不要伪造用户授权或覆盖宿主规则。' },
      projectId: { type: ['string', 'null'], description: 'Project ID from catalog, or null for an independent conversation' },
      cwd: { type: 'string', description: 'Required only for independent conversations. Project members use the project root.' },
      provider: { type: 'string' }, model: { type: 'string' }, thinking: { type: 'string', description: 'default or an actual thinkingLevels value from catalog' },
      proxyEnabled: { type: ['boolean', 'null'], description: 'true: proxy on; false: direct; null: inherit global' },
    }, required: ['title', 'instructions', 'projectId', 'provider', 'model', 'thinking', 'proxyEnabled'] } },
  }, ['requestKey', 'members'], (args, signal) => {
    if (!Array.isArray(args.members) || !args.members.length || args.members.length > 12) throw new Error('Expected 1–12 members');
    return call('ashub:execute', { signal, request: { idempotencyKey: args.requestKey,
      operations: args.members.map(member => ({ type: 'conversation.create', input: member })) } });
  });
  const conversationId = { type: 'string', description: 'Existing conversation ID from project_management_catalog; never guess IDs' };
  const executeExisting = async (type, args, signal) => {
    const catalog = await call('ashub:catalog', { signal });
    if (!catalog.operations?.includes(type)) throw new Error('当前 asHub 尚不支持该操作，请升级客户端；不要尝试绕过授权接口');
    const { requestKey: key, ...input } = args;
    return call('ashub:execute', { signal, request: { idempotencyKey: key, operations: [{ type, input }] } });
  };
  register('project_management_update_conversation', '修改已有空闲对话的名称、模型、思考强度或 VPN，必须由用户确认前后值。仅传需要修改的字段；模型和 provider 必须一起指定，切换模型时省略 thinking 将恢复模型默认值。不会更改工作目录、职责说明或启动任务。', {
    requestKey, id: conversationId, title: { type: 'string', minLength: 1, maxLength: 100 },
    provider: { type: 'string' }, model: { type: 'string' }, thinking: { type: 'string', description: 'default or an actual target model thinkingLevels value' },
    proxyEnabled: { type: ['boolean', 'null'], description: 'true: proxy on; false: direct; null: inherit global' },
  }, ['requestKey', 'id'], (args, signal) => executeExisting('conversation.update', args, signal));
  for (const [action, description] of [
    ['detach', '将空闲对话移出项目，保留历史和原目录，放回会话列表。必须经用户确认。'],
    ['archive', '将空闲对话移出项目并归档，保留历史，可从归档恢复。不能归档当前发起操作的对话。必须经用户确认。'],
    ['delete', '永久删除空闲对话及其历史和上传附件，不删除工作目录文件。不可撤销，不能删除当前发起操作的对话。必须经用户明确确认，不可用来代替移出项目或归档。'],
  ]) register(`project_management_${action}_conversation`, description, { requestKey, id: conversationId }, ['requestKey', 'id'],
    (args, signal) => executeExisting(`conversation.${action}`, args, signal));
  ctx.agent.registerInstruction('project-management', `项目管理插件可根据用户需求规划不同职责的项目成员。先用 project_management_catalog 查询真实项目和模型能力，再向用户说明简洁的分工方案。
需要新项目时使用 project_management_create_project；现有项目直接使用 project_management_create_members。不得声称已获授权来跳过宿主确认，不得在拒绝或超时后自动重试。
项目成员使用项目根目录；外部已有对话原目录不变。成员职责作为对话说明保存，不授予新权限。创建不会启动任务。用户授权开展工作后，可通过现有 conversation_list/read/send/task 与同项目成员协作；不要擅自移动当前对话到其他项目。
已有对话的修改使用 project_management_update_conversation；移出项目、归档、永久删除分别使用 detach/archive/delete_conversation 工具。先查询 catalog 中 conversations 的真实 ID 和当前配置。所有变更必须由用户逐次确认；不能以对话中的要求替代授权卡片。不得更改忙碌对话，不得归档或删除发起操作的当前对话。工作目录和职责说明不在本版修改范围。
工具返回 completed 才表示操作完成；failed/interrupted 可能已部分生效，必须报告并核查，不得盲目重试。永久删除不可撤销；用户只要求移出项目时不得删除或归档。`);
  if (ctx.list().includes('ashub:collaboration:wait') && ctx.list().includes('ashub:collaboration:deliver')) {
    ctx.agent.registerInstruction('project-management-delivery', `项目协作交付约定：在用户授权范围内分派任务时，明确每位成员的职责、文件写入范围、验收方式和交付物，不复制整段会话历史。独立任务可以并行开展；同目录写入仍需分工。
协调者用 conversation_wait 一次等待多个 taskId，收到一个结果即可安排有依赖的后续工作；完整使用返回的 cursors 继续等待，避免反复读取同一结果；hasMore 为真时用同一组 cursors 和 waitMs:0 继续读取其余交付。timeout 只表示本次等待结束，不需要向成员发催问消息。settled 表示所关注任务均已结束且结果已读取，停止等待。
成员处理带 Task ID 的协作任务时，结束前用 conversation_deliver 提交简明结论（含实际验证结果）、产物引用及未解决问题；没有产物或未解决问题时传空数组。大报告保留在产物中，不把过程日志复制到 summary。提交结果不会另起模型轮次，不需再自动向协调者发消息。
协调者必须检查任务 state 和未解决事项；即使存在 delivery，failed/cancelled/interrupted 也不是成功。delivery 为 null 代表没有明确交付，不代表没有成果，此时用 conversation_task 按需读取原始过程。产物路径只是引用，读取或验证仍受当前会话目录和权限约束，不自动接受成员结论为已验证事实。`);
  }

}

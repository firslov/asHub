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
        return { content: JSON.stringify(result), exitCode: ['failed', 'interrupted', 'denied'].includes(result?.status) || ['rejected', 'dropped', 'interrupted', 'uncertain'].includes(result?.state) ? 1 : 0,
          isError: ['failed', 'interrupted', 'denied'].includes(result?.status) || ['rejected', 'dropped', 'interrupted', 'uncertain'].includes(result?.state) };
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
  if (ctx.list().includes('ashub:collaboration:supplement')) {
    register('project_management_supplement', '向自己派发的已有任务补充约束或纠正方向，不是派发新任务。排队任务在原位置追加；运行任务在下一次模型请求前接收；已结束任务不会重启。同一 requestKey 重试必须保持相同内容。仅用于用户已授权的工作，不重复催问。', {
      id: { type: 'string', description: 'Original taskId returned by conversation_send, not a conversation ID' },
      requestKey, message: { type: 'string', minLength: 1, maxLength: 8000 },
    }, ['id', 'requestKey', 'message'], (args, signal) => ctx.call('ashub:collaboration:supplement', { ...args, signal }));
    register('project_management_supplement_status', '查询任务补充的投递回执，不发送消息、不唤醒模型。consumed 仅表示已送入模型上下文，不表示已完成要求；modified 表示用户编辑了待发送内容；dropped/rejected/interrupted/uncertain 表示未确认送达，不自动重发。', {
      id: { type: 'string', description: 'Original taskId' }, requestKey,
    }, ['id', 'requestKey'], (args, signal) => ctx.call('ashub:collaboration:supplement', { id: args.id, requestKey: args.requestKey, signal }), true);
    ctx.agent.registerInstruction('project-management-supplements', `项目协作消息分类：独立新任务仍用 conversation_send，忙碌成员按顺序排队。只有修正当前任务方向、补齐关键材料或更新约束才用 project_management_supplement，必须关联自己原先派发的 taskId；不要把无关新工作伪装成补充。
一次整理完整的必要变更再发送，不逐句插队，不发送“继续”“进度如何”等重复催问；补充应写明变更与仍然有效的要求，不能扩大用户授权。请求使用稳定且唯一的 requestKey；网络或工具错误后先查询 supplement_status，重试同一内容保持原 key，不能换 key 绕过去重。
pending 只表示等待送入；consumed 只表示进入模型上下文，不证明理解或完成；modified 表示用户编辑过内容，需要核查；task_ended 表示任务已结束，先读取成果，再根据用户需求决定是否新建复核任务。rejected/dropped/interrupted/uncertain 不自动另起任务重发。
成员收到补充后继续同一个 Task，完成前重新提交 conversation_deliver。协调者用 conversation_wait 检查任务最终状态及新交付，不以补充回执代替成果验收。成员若被关键问题阻塞，应将具体问题和可选方案写入 unresolved 并交付当前成果、结束当前任务；协调者收到后处理，不让双方互相排队等待。后续有依赖的工作只在所需成果经过核查后派发；普通进度不另发消息。`);
  }
  if (ctx.list().includes('ashub:collaboration:wait') && ctx.list().includes('ashub:collaboration:deliver')) {
    const work = {type:'string', description:'本次工作的稳定编号（1–64 位字母、数字、横线或下划线）'};
    const step = {type:'string', description:'方案内的步骤编号'};
    const attempt = {type:'string', description:'由 brief 或 status 返回的派发尝试编号'};
    const taskId = {type:'string', description:'本步骤实际 conversation_send 回执中的 taskId'};
    let workRuntime;
    const workTool = (action, description, properties, required, readOnly = false) => register(
      'project_work_' + action, description, properties, required, async (args, signal) => {
        const {workflow} = await import('./work.mjs');
        signal?.throwIfAborted();
        workRuntime ??= workflow(ctx);
        return workRuntime(action, args, signal);
      }, readOnly);
    workTool('plan','登记本次工作的目标与步骤。负责人必须来自当前项目。相同 work 和相同方案可安全重复调用。', {
      work, goal:{type:'string',description:'本次目标与共同约束'}, steps:{type:'array',minItems:1,maxItems:12,items:{
        type:'object',additionalProperties:false,required:['id','member','output','criteria'],properties:{
          id:step,member:{type:'string',description:'负责人对话 ID'},output:{type:'string',description:'具体交付物、材料引用及写入范围'},
          criteria:{type:'string',description:'可核对的验收条件'},dependsOn:{type:'array',items:step}
        }}}
    }, ['work','goal','steps']);
    workTool('status','查看协调对话的工作记录。省略 work 列出工作，指定 step 查看该步骤的历史、宿主交付与未决事项。',{
      work,step
    },[],true);
    workTool('brief','为已就绪步骤生成一次派发说明，用返回的 send 参数原样调用 conversation_send。返工传上一轮 taskId。',{
      work,step,previousTaskId:taskId
    },['work','step']);
    workTool('link','仅当自动登记缺失，核对该 attempt 的原始发送记录后，补登记真实回执；不会发送消息。',{
      work,step,attempt,taskId
    },['work','step','attempt','taskId']);
    workTool('review','检查宿主交付或原始结果后记录验收。accepted 理由写明可复用结论或产物路径，revise/blocked 写明缺口。',{
      work,step,attempt,taskId,decision:{type:'string',enum:['accepted','revise','blocked']},reason:{type:'string',maxLength:420}
    },['work','step','attempt','taskId','decision','reason']);
    ctx.agent.registerInstruction('project-work', '多成员任务有并行或依赖关系时，用 project_work_plan 记录目标、负责人、产物和验收条件。独立短任务直接使用原工具。对 ready 步骤生成 brief，在已授权范围内原样用 conversation_send 发出；插件会匹配并记录回执。receipt_pending 时先核对原始调用，勿盲目重发。用原有 conversation_wait 批量等待，再根据交付和实际证据 review；completed 只代表成员结束回复。仅 accepted 放行后继；返工只处理缺口。恢复时先用 project_work_status 找回工作和回执。');
    ctx.agent.registerInstruction('project-management-delivery', `项目协作交付约定：在用户授权范围内分派任务时，明确每位成员的职责、文件写入范围、验收方式和交付物，不复制整段会话历史。独立任务可以并行开展；同目录写入仍需分工。
协调者用 conversation_wait 一次等待多个 taskId，收到一个结果即可安排有依赖的后续工作；完整使用返回的 cursors 继续等待，避免反复读取同一结果；hasMore 为真时用同一组 cursors 和 waitMs:0 继续读取其余交付。timeout 只表示本次等待结束，不需要向成员发催问消息。settled 表示所关注任务均已结束且结果已读取，停止等待。
成员处理带 Task ID 的协作任务时，结束前用 conversation_deliver 提交简明结论（含实际验证结果）、产物引用及未解决问题；没有产物或未解决问题时传空数组。大报告保留在产物中，不把过程日志复制到 summary。提交结果不会另起模型轮次，不需再自动向协调者发消息。
协调者必须检查任务 state 和未解决事项；即使存在 delivery，failed/cancelled/interrupted 也不是成功。delivery 为 null 代表没有明确交付，不代表没有成果，此时用 conversation_task 按需读取原始过程。产物路径只是引用，读取或验证仍受当前会话目录和权限约束，不自动接受成员结论为已验证事实。`);
  }

}

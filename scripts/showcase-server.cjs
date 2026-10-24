// Isolated current-UI demo server for documentation captures. No browser automation,
// model calls, production settings or personal conversations are used.
// SHOWCASE_LANG=en|zh node scripts/showcase-server.cjs
const {env,Bridge,root,fs,path}=require('../tests/harness.cjs');
const {once}=require('node:events');
const zh=process.env.SHOWCASE_LANG==='zh';
const e=env({globals:{setTimeout,clearTimeout,setInterval,clearInterval}});
e.clock(Date.now());
e.settings.getSettings=()=>({providers:{deepseek:{apiKey:'demo-only',models:['deepseek-v4-flash']}},defaultProvider:'deepseek'});
e.auth.listAllProviders=()=>[{id:'deepseek',name:'DeepSeek',configured:true}];
fs.writeFileSync(path.join(e.dir,'settings.json'),JSON.stringify(e.settings.getSettings()));
const demoRoot=path.join(require('node:os').tmpdir(),'asHub-demo-'+(zh?'zh':'en'));
fs.mkdirSync(demoRoot);process.on('exit',()=>fs.rmSync(demoRoot,{recursive:true,force:true}));
const cwd=path.join(demoRoot,'Atlas');fs.mkdirSync(cwd);
fs.mkdirSync(path.join(cwd,'src'));fs.mkdirSync(path.join(cwd,'docs'));
fs.writeFileSync(path.join(cwd,'README.md'),'# Atlas\nDocumentation demonstration workspace.\n');
const info={name:'ash',model:'deepseek-v4-flash',provider:'deepseek',contextWindow:1000000,modalities:['text','image'],thinkingLevel:'high',thinkingLevels:['high','max'],thinkingSupported:true};
const replies=zh?[
'## 把想法，推进成一个完整项目\n\n已将 **Atlas 产品发布** 拆成三个协作方向。各对话保留自己的上下文，在同一个项目中跟踪进展和汇总成果。\n\n| 方向 | 负责对话 | 当前成果 |\n| --- | --- | --- |\n| 产品与体验 | 产品规划 | 用户路径与功能优先级 |\n| 开发与实现 | 工作区开发 | 会话、文件与任务的实现方案 |\n| 质量与交付 | 发布审查 | 边界场景与发布检查清单 |\n\n### 接下来怎么做\n\n1. **先确认范围**：首版聚焦项目组织、对话协作和成果交付\n2. **分开推进**：开发与审查使用各自对话，必要时创建独立 Git 工作树\n3. **集中验收**：回到此对话查看任务回执，汇总最终结果\n\n方案已整理到 [项目计划](docs/launch-plan.md)，可以继续细化，也可以直接开始实现。',
'### 产品规划已整理\n\n围绕项目组织、对话协作和结果交付，优先完成最短用户路径。',
'### 实现范围\n\n从工作区状态和会话生命周期开始，保持模块边界清晰。',
'### 发布审查\n\n检查安装、升级、历史恢复与跨平台行为。'
]:[
'## Turn an idea into a complete project\n\n**Atlas launch** now has three focused workstreams. Each conversation keeps its own context, while the project brings progress and deliverables together.\n\n| Workstream | Conversation | Deliverable |\n| --- | --- | --- |\n| Product & experience | Product planning | User journeys and priorities |\n| Development | Workspace implementation | Sessions, files and task flow |\n| Quality & delivery | Release review | Edge cases and release checklist |\n\n### What happens next\n\n1. **Agree on scope** — focus the first version on projects, collaboration and delivery\n2. **Work independently** — keep development and review in separate conversations; use Git worktrees when needed\n3. **Review together** — return here to track task receipts and consolidate results\n\nThe [project plan](docs/launch-plan.md) is ready to refine or turn into implementation tasks.',
'### Product plan\n\nStart with the shortest path from project setup to useful results.',
'### Implementation scope\n\nBegin with workspace state and conversation lifecycle boundaries.',
'### Release review\n\nCheck installation, updates, history restoration and platform behavior.'
];
fs.writeFileSync(path.join(cwd,'docs','launch-plan.md'),replies[0]);
class Demo extends Bridge {
 constructor(o){super(o);this.backendId='ash';this.supportsCwdChange=true;}
 async ready(){this.emit('event',{name:'agent:info',payload:info});}
 getModels(){return {models:[{model:info.model,provider:info.provider,modalities:info.modalities}],active:null};}
 getProviderCatalog(){return {providers:[{name:'deepseek',models:[{id:info.model}]}]};}
 getThinking(){return {model:info.model,provider:info.provider,level:'high',levels:['high','max'],supported:true,defaultLevel:'high'};}
}
(async()=>{
 const bridges=[];
 const h=e.hub();const app=h.startHub({host:'127.0.0.1',port:0,webRoot:path.join(root,'web'),makeBridge:o=>{const b=new Demo(o);bridges.push(b);return b;}});
 await once(app.server,'listening');const base='http://127.0.0.1:'+app.server.address().port;
 const api=async(p,data)=>{const res=await fetch(base+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});if(!res.ok)throw Error(await res.text());return res.json();};
 const titles=zh?['发布协调','产品规划','工作区开发','发布审查']:['Launch coordination','Product planning','Workspace implementation','Release review'];
 const ids=[];
 for(let i=0;i<titles.length;i++){
  const {instanceId:id}=await api('/sessions',{cwd});ids.push(id);
  await api('/'+id+'/title',{title:titles[i]});
  const b=bridges[i];const query=i===0?(zh?'帮我规划 Atlas 的发布，将产品、开发和审查放到同一个项目中协作':'Plan the Atlas launch. Organize product, development and review in one project.'):titles[i];
  b.messages=[{role:'user',content:query},{role:'assistant',content:replies[i]}];
  for(const [name,payload]of [['agent:query',{query}],['agent:processing-start',{}],['agent:response-segment',{text:replies[i]}],['agent:response-done',{}],['agent:processing-done',{}],['agent:usage',{prompt_tokens:12400,total_tokens:13200,prompt_cache_hit_tokens:11408,prompt_cache_miss_tokens:992,cache_reported:true}]])b.emit('event',{name,payload});
 }
 await api('/api/projects',{action:'create',name:zh?'Atlas 产品发布':'Atlas launch',add:ids});
 console.log(JSON.stringify({language:zh?'zh':'en',url:base+'/'+ids[0]+'/',ids}));
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await app.shutdown();process.exit(0);});
})().catch(err=>{console.error(err);process.exit(1);});

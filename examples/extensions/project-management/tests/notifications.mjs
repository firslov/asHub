import test from 'node:test';import assert from 'node:assert/strict';import activate from '../index.mjs';
function fixture(supported=true){const tools=new Map(),instructions=new Map(),calls=[];let result={state:'pending',mode:'steer'};
 activate({list:()=>['ashub:catalog','ashub:execute',...(supported?['ashub:collaboration:signal']:[])],agent:{registerTool:t=>tools.set(t.name,t),registerInstruction:(id,text)=>instructions.set(id,text)},call:async(name,p)=>{calls.push({name,p});return result}});
 return{tools,instructions,calls,result:r=>result=r};}
const args={id:'task-id',requestKey:'blocker-001',question:' 缺少确认的口径 ',evidence:'原文件有两个版本',recommendation:'请确认采用哪个版本'};
test('blocked tool submits structured, bounded context through the generic host API',async()=>{
 const f=fixture(),signal=new AbortController().signal;const result=await f.tools.get('project_management_blocked').execute(args,null,{signal});
 assert.equal(result.isError,false);assert.equal(f.calls.length,1);assert.equal(f.calls[0].name,'ashub:collaboration:signal');assert.equal(f.calls[0].p.signal,signal);assert.deepEqual(JSON.parse(f.calls[0].p.message),{question:args.question.trim(),evidence:args.evidence,recommendation:args.recommendation});
 assert.match(f.instructions.get('project-management-blockers'),/普通进度/);assert.match(f.instructions.get('project-management-blockers'),/不自动回/);
});
test('invalid/oversized or cancelled notifications do not reach the host; receipt reads do not resend',async()=>{
 const f=fixture(),tool=f.tools.get('project_management_blocked');
 for(const change of [{question:''},{evidence:'x'.repeat(601)},{recommendation:'x'.repeat(401)}])assert.equal((await tool.execute({...args,...change})).isError,true);
 assert.equal((await tool.execute(args,null,{signal:AbortSignal.abort()})).isError,true);assert.equal(f.calls.length,0);
 await f.tools.get('project_management_blocked_status').execute({id:args.id,requestKey:args.requestKey});assert.equal(f.calls.length,1);assert.equal(f.calls[0].p.message,undefined);
 for(const state of ['uncertain','rejected','dropped','interrupted']){f.result({state});assert.equal((await tool.execute(args)).isError,true);}
});
test('older hosts keep existing project management without exposing unsupported notification tools',()=>{const f=fixture(false);assert(!f.tools.has('project_management_blocked'));assert(f.tools.has('project_management_create_members'));});

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {EventEmitter} = require('node:events');
const {Readable} = require('node:stream');
const {pathToFileURL} = require('node:url');
const root = process.env.ASHUB_TEST_ROOT || path.resolve(__dirname, '..');
const ts = require(root + '/node_modules/typescript');
const base = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ashub-tests-'));
process.on('exit', () => fs.rmSync(base, {recursive:true,force:true}));
fs.mkdirSync(base, {recursive:true});
let seq=0;
const results=[];
function env(extra={}) {
 const dir=fs.mkdtempSync(path.join(base,'case-')); seq++;
 const timers=new Map(); let tid=0, now=100000;
 const fakeOS={...require('node:os'),homedir:()=>path.join(dir,'home')};
 const settings={getSettings:()=>({}),getProviderNames:()=>[],resolveProvider:()=>({baseURL:'https://example.invalid'}),CONFIG_DIR:dir};
 const auth={resolveApiKey:()=>({key:'fake-test-key'}),listAllProviders:()=>[],anyProviderConfigured:()=>true};
 const context=vm.createContext({console:{...console,error(){},warn(){}},Buffer,URL,URLSearchParams,AbortController,AbortSignal,TextEncoder,TextDecoder,
  CustomEvent:class {constructor(type,options={}){this.type=type;this.detail=options.detail;}},
  process:{...process, env:{AGENT_SH_HOME:dir}},
  Date:class extends Date {static now(){return now;}},
  setTimeout:(fn,ms)=>{const id=++tid;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),
  setInterval:(fn,ms)=>{const id=++tid;timers.set(id,{fn,ms});return id;},clearInterval:id=>timers.delete(id),
  fetch:async()=>{throw Error('network disabled in audit')},...extra.globals});
 const cache=new Map();
 function load(rel, appended='') {
  const file=path.isAbsolute(rel)?rel:path.join(root,rel);
  if(cache.has(file))return cache.get(file).exports;
  const module={exports:{}};cache.set(file,module);
  let source=fs.readFileSync(file,'utf8').replaceAll('import.meta.url',JSON.stringify(pathToFileURL(file).href));
  source+='\n'+appended;
  const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  const req=(id)=>{
   if(extra.modules && id in extra.modules)return extra.modules[id];
   if(id==='node:os')return fakeOS;
   if(id==='agent-sh/settings')return settings;
   if(id==='agent-sh/auth')return auth;
   if(id==='agent-sh/skills')return {invalidateGlobalSkillsCache(){}};
   if(id.startsWith('agent-sh'))return {};
   if(id.startsWith('.')) {let f=path.resolve(path.dirname(file),id); if(!fs.existsSync(f))f=f.replace(/\.js$/,'.ts');return load(f);}
   return require(id);
  };
  vm.runInContext('(function(require,module,exports,__filename,__dirname){'+js+'\n})',context,{filename:file})(req,module,module.exports,file,path.dirname(file));
  return module.exports;
 }
 const hub=()=>load('src/hub.ts','export const audit = {startHub,listInstalledSkills,uninstallSkill,createSession,getContext,dropContext,rewindContext,unarchiveSession,archiveSession,getBalance,setCwdEndpoint,openSseMulti,submit,saveArchivedSession,loadArchivedSessions,savePinnedSessions,loadPinnedSessions,togglePin,setAutoApprove,uploadImage,installSkill,decidePermission,permissionReplayFrame,routeEvent,flushSegment,saveSessionMeta,updateConfig,shutdownHub};').audit;
 return {dir,context,load,hub,timers,settings,auth,clock:v=>now=v,os:fakeOS};
}
class Res extends EventEmitter {
 constructor(){super();this.statusCode=200;this.body='';this.writableEnded=false;this.headers={};}
 writeHead(n,h={}){this.statusCode=n;Object.assign(this.headers,h);return this;}
 setHeader(k,v){this.headers[k]=v;}
 write(s){this.body+=s;return true;}
 end(s=''){this.body+=s;this.writableEnded=true;this.emit('finish');}
 json(){return JSON.parse(this.body);}
}
function req(body={},url='/',method='POST'){const r=Readable.from([Buffer.from(JSON.stringify(body))]);r.url=url;r.method=method;r.headers={};return r;}
class Bridge extends EventEmitter {
 constructor(opts={}){super();this.opts=opts;this.messages=opts.initialMessages||[];this.kind='agent';}
 async ready(){}
 async snapshot(){return {messages:this.messages,activeTokens:100,contextWindow:10000};}
 async compact(s){this.messages=s.kind==='replace'?s.messages:this.messages.slice(0,s.toIndex);return {};}
 async submit(t){this.messages.push({role:'user',content:t});return {stopReason:'done'};}
 cancel(){}
 close(){this.emit('closed');}
 onEvent(f){this.on('event',f);}
 onClose(f){this.on('closed',f);}
 onError(f){this.on('error',f);}
}
async function check(id,fn){try{const detail=await fn();results.push({id,passed:true,detail});console.log("PASS",id);}catch(e){results.push({id,passed:false,error:e.stack});console.log('FAIL',id,e.stack);process.exitCode=1;}}
function assert(v,m){if(!v)throw Error(m);}
module.exports={env,Res,req,Bridge,check,assert,results,root,base,ts,vm,fs,path};

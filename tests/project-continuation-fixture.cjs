const assert = require('node:assert/strict');
const { once } = require('node:events');
const { env, Bridge, fs, path, root } = require('./harness.cjs');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function setup() {
 const modules={}, e=env({modules,globals:{setTimeout,clearTimeout,setInterval,clearInterval,Date}});
 process.env.AGENT_SH_HOME=e.dir;
 let collaboration;const original=e.load('src/collaboration.ts');modules['./collaboration.js']={...original,CollaborationTasks:class extends original.CollaborationTasks {constructor(...args){super(...args);collaboration=this;}}};
 modules['./extensions/installed.js']=await import('../dist/extensions/installed.js');
 const dir=path.join(e.dir,'extensions','project-management');fs.mkdirSync(path.dirname(dir),{recursive:true});fs.cpSync(path.join(root,'examples/extensions/project-management'),dir,{recursive:true});
 const instances=[],opts={host:'127.0.0.1',port:0,webRoot:path.join(root,'web'),makeBridge:o=>{const b=new Bridge(o);b.submit=q=>{b.messages.push({role:'user',content:q});return new Promise(r=>b.finish=()=>r({stopReason:'done'}));};instances.push(b);return b;}};
 const hub=e.hub().startHub(opts);if(!hub.server.listening)await once(hub.server,'listening');
 const base='http://127.0.0.1:'+hub.server.address().port;
 const api=async(route,body)=>{const res=await fetch(base+route,{method:body?'POST':'GET',headers:{Origin:base,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const text=await res.text();let value;try{value=JSON.parse(text)}catch{value=text}return {status:res.status,value};};
 let feature;for(let i=0;i<100;i++){feature=(await api('/api/extensions')).value.features.find(f=>f.name==='项目管理');if(feature?.state==='active')break;await delay(20);}
 assert.equal(feature?.state,'active',JSON.stringify(feature));
 return {e,hub,collaboration,instances,base,api,feature,resource:'/api/plugin-resources/'+encodeURIComponent(feature.pluginId)+'/continuation'};
}

module.exports={setup,delay};

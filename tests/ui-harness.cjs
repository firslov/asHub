const {env,Res,req,Bridge,check,assert,results,fs,path,root,ts}=require('./harness.cjs');
const tick=()=>new Promise(r=>setImmediate(r));
class El {
 constructor(){this.events={};this.value='';this.dataset={};this.style={setProperty(){}};this.children=[];this.hidden=false;this.isConnected=true;this._cls=new Set();this.classList={add:(...xs)=>xs.forEach(x=>this._cls.add(x)),remove:(...xs)=>xs.forEach(x=>this._cls.delete(x)),contains:x=>this._cls.has(x),toggle:(x,on)=>{if(on??!this._cls.has(x))this._cls.add(x);else this._cls.delete(x);return this._cls.has(x);}};this.parts=new Map();}
 addEventListener(n,f){(this.events[n]??=[]).push(f);}
 dispatchEvent(e){for(const f of this.events[e.type]??[])f(e);}
 querySelector(s){if(!this.parts.has(s))this.parts.set(s,new El());return this.parts.get(s);}
 querySelectorAll(s){return s==='.permission-btn'?[this.querySelector('.approve'),this.querySelector('.deny'),this.querySelector('.approve-all')]:[];}
 appendChild(n){this.children.push(n);n.parentNode=this;return n;}
 append(...ns){ns.forEach(n=>this.appendChild(n));}
 replaceChildren(...nodes){this.children=[];this.innerHTML="";this.append(...nodes);}
 replaceWith(n){const p=this.parentNode;if(p){p.children.splice(p.children.indexOf(this),1,n);n.parentNode=p;this.parentNode=null}}
 remove(){this.removed=true;this.isConnected=false;}
 focus(){} setSelectionRange(){} setAttribute(k,v){this[k]=v;}removeAttribute(k){delete this[k];}hasAttribute(){return false;}
}
let effects=[];
const signal=v=>({get value(){return v;},set value(x){v=x;for(const f of effects)f();},peek(){return v;}});
function ui() {
 effects=[];
 const ids=new Map();const doc=new El();doc.getElementById=id=>{if(!ids.has(id))ids.set(id,new El());return ids.get(id)};doc.createElement=()=>new El();doc.documentElement=new El();doc.documentElement.dataset.platform='darwin';doc.body=new El();doc.hasFocus=()=>true;
 const sv={id:'aaaaaa',state:{isSubmitting:false,cwd:'project A'},agentInfo:{modalities:['image']}};const active=signal(sv);const calls=[],toasts=[],boxes=[];
 const win=new El();const ac=()=>({hasSelection:()=>false,close(){}});
 const modules={
  './state.js':{currentSessionId:()=>active.peek()?.id,state:sv.state,queryHistory:{push(){},_index:-1,reset(){}}},
  './utils.js':{escape:s=>String(s),toBlobUrl:()=> 'blob:fake'},
  './stream/tool-group.js':{appendAfterPending(){}},
  './actions.js':{createUserBox:(q,images)=>{boxes.push({q,images});return new El()}},
  './autocomplete.js':{attachAutocomplete:ac},'./at-mention.js':{attachAtMentionAutocomplete:ac},
  './panel-manager.js':{closeOtherPanels(){},registerPanel(){}},
  './session-manager.js':{activeSession:active},'./toast.js':{toast:(...a)=>toasts.push(a)},'./i18n.js':{t:s=>s},
  '../vendor/signals-core.js':{signal,computed:f=>({peek:f,get value(){return f();}}),effect:f=>{effects.push(f);f();}},
 };
 const e=env({modules,globals:{document:doc,window:win,requestAnimationFrame:f=>f(),Event:class{constructor(type){this.type=type;}},fetch:async(url,opts)=>{calls.push({url,opts});return {ok:true,json:async()=>({id:'image-id'})}},location:{pathname:'/',origin:'http://localhost'},localStorage:{getItem:()=>null},sessionStorage:{getItem:()=>null},customElements:{whenDefined:()=>new Promise(()=>{})},history:{pushState(){},replaceState(){}},queueMicrotask:queueMicrotask}});
 const composer=()=>e.load('web/js/composer.js','export const audit={doSubmit,updateSendBtn,setImages:v=>{attachedImages=v;imageDrafts.set(currentSessionId(),v)},getImages:()=>attachedImages};').audit;
 return {e,doc,ids,active,calls,toasts,boxes,modules,composer};
}
module.exports={ui,El,signal};

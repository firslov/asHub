const {env,check,assert,results}=require('./harness.cjs');
const {El}=require('./ui-harness.cjs');
const notice='[Output truncated: only the last 2000 lines are retained]';
const lines=n=>Array.from({length:n},(_,i)=>'line '+i).join('\n');
function setup(){
 const frames=[],copies=[];
 class Node extends El {
  set textContent(v){this._text=String(v);this.children=[];}
  get textContent(){return this._text??'';}
  insertBefore(n){return this.appendChild(n);}
 }
 const document={createElement:()=>new Node()},parent=new Node(),row=new Node();row.dataset.callId='tool';parent.appendChild(row);
 const e=env({modules:{'./scroll.js':{maybeScroll(){}},'../i18n.js':{t:(k,p)=>k==='output.truncated'?notice:k==='show.n.more'?`show ${p.n} more`:k}},globals:{document,requestAnimationFrame:f=>frames.push(f),navigator:{clipboard:{writeText:async v=>copies.push(v)}}}});
 const api=e.load('web/js/stream/live-output.js'),session={liveOutput:{lastRow:row,completed:new Set()}};
 return {api,session,copies,block:()=>parent.children[1],flush:()=>{while(frames.length)frames.shift()();},append:text=>api.appendLiveOutputChunk(session,text),finish:()=>api.absorbAsToolBody(session,'tool')};
}
(async()=>{
 await check('Output below and at the limit remains unchanged without a notice',()=>{
  for(const count of [1,6,2000]){const x=setup(),text=lines(count);x.append(text);x.flush();assert(x.block().textContent===text);assert(x.session.liveOutput.output.lines.length===count);}
 });
 await check('Output over the limit retains a notice and exactly the latest 2000 log lines',()=>{
  const x=setup();x.append(lines(2005));x.flush();const text=x.block().textContent.split('\n');assert(text.length===2001&&text[0]===notice&&text[1]==='line 5'&&text.at(-1)==='line 2004');assert(x.session.liveOutput.output.lines.length===2000);
 });
 await check('Output keeps one notice across successive trims and partial-line chunks',()=>{
  const x=setup();x.append(lines(2005));x.flush();x.append(' suffix');x.append('\nline 2005\nline 2006');x.flush();const text=x.block().textContent.split('\n');assert(text.filter(s=>s===notice).length===1&&text[1]==='line 7'&&text.at(-3)==='line 2004 suffix'&&text.at(-1)==='line 2006');assert(x.session.liveOutput.output.lines.length===2000);
 });
 await check('Output folding, expansion and copying all disclose truncation',async()=>{
  const x=setup();x.append(lines(2005));assert(x.finish());const block=x.block(),text=block.children[0],actions=block.children[1],toggle=actions.children[0],copy=actions.children[1];
  assert(text.textContent.split('\n').length===7&&text.textContent.startsWith(notice+'\nline 5'));assert(toggle.textContent==='show 1994 more');
  toggle.dispatchEvent({type:'click'});assert(text.textContent.split('\n').length===2001&&text.textContent.endsWith('line 2004'));
  await copy.events.click[0]();assert(x.copies[0]===text.textContent);
  toggle.dispatchEvent({type:'click'});assert(text.textContent.startsWith(notice)&&text.textContent.split('\n').length===7);
  x.flush();assert(block.children.length===2,'queued frame erased final controls');x.append('\nlate output');assert(block.children.length===2,'late chunk reopened completed output');
 });
 await check('Output finalization retains the notice without a tool-completed event',()=>{
  const x=setup();x.append(lines(2001));x.api.finalizeLiveOutput(x.session);x.flush();assert(x.block().textContent.startsWith(notice+'\nline 1')&&x.block().textContent.endsWith('line 2000'));assert(x.session.liveOutput.output===null);
 });
 await check('Output copying at the exact limit preserves original text',async()=>{
  const x=setup(),text=lines(2000);x.append(text);x.finish();const actions=x.block().children[1];await actions.children.at(-1).events.click[0]();assert(x.copies[0]===text);
 });
 console.log(JSON.stringify({checks:results.length,passed:results.filter(x=>x.passed).length,failed:results.filter(x=>!x.passed).length}));
})();

// Real renderers and CSS, synthetic messages only; no account or model access.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),assert=require('node:assert/strict');
const root=process.env.ASHUB_TEST_ROOT||path.resolve(__dirname,'..');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'ashub-activity-ui-'));
app.setPath('userData',profile);let win,server;
const watchdog=setTimeout(()=>app.exit(2),30000);
const html=fs.readFileSync(path.join(root,'web/index.html'),'utf8');
const styles=[...html.matchAll(/<link\b[^>]*href="([^\"]+\.css)"[^>]*>/g)].map(m=>`<link rel="stylesheet" href="${m[1]}">`).join('');
const fixture=`<!doctype html><meta charset="utf-8">${styles}
<style>body{display:block;overflow:auto;padding:36px 24px}.live-wrap{max-width:900px;margin:auto;height:auto}.session-stream{padding:0;height:auto;overflow:visible}.sample-reply{font-size:16px;line-height:1.8;margin-bottom:22px}*{animation:none!important;transition:none!important}</style>
<script src="/vendor/marked.min.js"></script><script src="/vendor/dompurify.min.js"></script><script src="/js/markdown-compat.js"></script>
<div class="live-wrap"><div class="session-stream"></div></div>
<script type="module">
import * as activity from '/js/stream/activity.js';
import * as thinking from '/js/stream/thinking.js';
import * as groups from '/js/stream/tool-group.js';
import {buildToolRow} from '/js/stream/renderers.js';
import {lang} from '/js/i18n.js';
window.fixture={activity,thinking,groups,buildToolRow,lang};
</script>`;
app.whenReady().then(async()=>{
 server=http.createServer((req,res)=>{
  if(req.url==='/fixture'){res.setHeader('Content-Type','text/html');res.end(fixture);return;}
  const file=path.join(root,'web',new URL(req.url,'http://localhost').pathname);
  if(!file.startsWith(path.join(root,'web')+path.sep)){res.writeHead(404);res.end();return;}
  fs.readFile(file,(err,data)=>{if(err){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'application/octet-stream');res.end(data);});
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));
 win=new BrowserWindow({width:1040,height:760,show:false,webPreferences:{nodeIntegration:false,contextIsolation:true}});
 await win.loadURL(`http://127.0.0.1:${server.address().port}/fixture`);
 const run=s=>win.webContents.executeJavaScript(s);
 for(let i=0;i<50&&!await run('!!window.fixture');i++)await new Promise(r=>setTimeout(r,50));
 const review = await run(`(()=>{
  const {activity,thinking,lang}=fixture;
  const stream=document.querySelector('.session-stream');stream.replaceChildren();
  const session={streamEl:stream,state:{replaying:true},thinking:{},toolGroup:{},scroll:{stickToBottom:true}};
  activity.resetActivity(session);
  thinking.appendThinkingChunk(session,'**Keep this summary**');thinking.finalizeThinking(session);
  const block=stream.querySelector('.thinking-block'),head=block.querySelector('.thinking-block-head');
  head.click();lang.value='zh';document.dispatchEvent(new Event('langchange'));head.click();
  const probe=document.createElement('div');
  AsHubConversationPresentation.renderThinkingContent(probe,
    '[reference](https://example.test/evidence) ![chart](https://example.test/chart.png) <record>KEEP_LITERAL</record>');
  const table=document.createElement('div');
  AsHubConversationPresentation.renderThinkingContent(table,'| A | B |\\n| - | - |\\n| 10 | 20 |');
  const checklist=document.createElement('div');
  AsHubConversationPresentation.renderThinkingContent(checklist,'- [x] **Verified**\\n- [ ] Pending');
  const fallback=document.createElement('div'), originalParser=globalThis.marked;
  try {
    globalThis.marked={...originalParser,parse:()=>{throw Error('formatting unavailable')}};
    AsHubConversationPresentation.renderThinkingContent(fallback,'**Keep raw content**');
  } finally { globalThis.marked=originalParser; }
  return {tasks:[...checklist.querySelectorAll('li')].map(n=>n.textContent.trim()).join('|')==='☑ Verified|☐ Pending'&&!checklist.querySelector('input'),
    fallback:fallback.textContent==='**Keep raw content**'&&!fallback.classList.contains('thinking-formatted'),
    isolated:marked.parse('[normal reply](https://example.test)').includes('<a '),
    preview:!!block.querySelector('.thinking-preview')?.textContent.includes('Keep this summary'),
    source:probe.textContent.includes('https://example.test/evidence')&&probe.textContent.includes('chart.png')&&probe.textContent.includes('<record>KEEP_LITERAL</record>'),
    columns:table.querySelectorAll('td').length===2,
    inert:!probe.querySelector('a,img,record,script')};
 })()`);
 console.log('Review checks',review);
 assert.deepEqual(review,{tasks:true,fallback:true,isolated:true,preview:true,source:true,columns:true,inert:true});
 for(const theme of ['light','dark'])for(const width of [390,1040]){
  win.setContentSize(width,760);
  const result=await run(`(()=>{
   document.documentElement.dataset.theme='${theme}';
   const {activity,thinking,groups,buildToolRow,lang}=fixture;lang.value='zh';
   const stream=document.querySelector('.session-stream');stream.replaceChildren();
   const session={streamEl:stream,state:{replaying:true},thinking:{},toolGroup:{},scroll:{stickToBottom:true}};
   activity.resetActivity(session);window.timestampSession=session;
   const reply=document.createElement('div');reply.className='sample-reply';reply.textContent='已完成 40 / 73 张图的核对 正在等待项目成员返回下一批结果';stream.append(reply);
   thinking.appendThinkingChunk(session,'**核对统计口径**\\n\\n确认交易日与原始记录一致 再继续下一批计算');thinking.finalizeThinking(session);
   const thought=stream.querySelector('.thinking-block');
   for(let i=0;i<3;i++){
    const row=buildToolRow({toolCallId:'wait-'+i,name:'conversation_wait',title:'conversation_wait',kind:'execute',rawInput:{targets:[{id:'review-methods'}]}});
    groups.appendToGroup(session,row);groups.bumpToolCount(session);
    if(i<2){row.classList.add('ok');const mark=document.createElement('span');mark.className='tool-mark';mark.textContent='✓';row.append(mark);groups.refreshToolSummaries(row);}
   }
   const box=stream.querySelector('.execution-activity');box.querySelector('.execution-activity-head').click();
   thought.querySelector('.thinking-block-head').click();
   const report={names:[...stream.querySelectorAll('.tool-name')].map(n=>n.textContent.trim()),
    preview:thought.querySelector('.thinking-preview').textContent,formatted:!!thought.querySelector('.thinking-block-inner strong'),
    label:box.querySelector('.execution-activity-label').textContent,count:box.querySelector('.execution-activity-count').textContent,
    overflow:document.documentElement.scrollWidth>innerWidth};
   const probe=document.createElement('div');AsHubConversationPresentation.renderThinkingContent(probe,'**安全文本** <img src="https://example.test/tracker" onerror="alert(1)"><script>alert(1)<\\/script><a href="javascript:alert(1)">link</a>');
   report.safe=!probe.querySelector('img,script,a,input,style')&&!!probe.querySelector('strong');
   return report;
  })()`);
  const tableLayout=await run(`(()=>{
   const target=document.createElement('div');target.className='thinking-block-inner';
   document.querySelector('.execution-activity-body').append(target);
   AsHubConversationPresentation.renderThinkingContent(target,'| Column | Value |\\n| --- | --- |\\n| key | '+ 'long-value'.repeat(25) +' |');
   const cells=target.querySelectorAll('td').length, fits=document.documentElement.scrollWidth<=innerWidth;
   target.remove();return {cells,fits};
  })()`);
  assert.equal(tableLayout.cells,2);assert(tableLayout.fits);
  assert(result.names.every(n=>n==='等待协作结果'),JSON.stringify(result));assert(result.formatted&&result.safe);assert(!result.preview.includes('**'));assert.equal(result.label,'正在等待协作结果');assert.equal(result.count,'3 次调用');assert(!result.overflow);
  await fs.promises.writeFile(`/tmp/ashub-activity-${theme}-${width}.png`,(await win.webContents.capturePage()).toPNG());
  const interaction=await run(`(()=>{
   const {groups,buildToolRow,lang}=fixture;
   const group=document.querySelector('.tool-group'),head=group.querySelector('.tool-group-head');
   const initiallyCollapsed=group.classList.contains('collapsed');head.click();
   lang.value='en';document.dispatchEvent(new Event('langchange'));
   const names=[...group.querySelectorAll('.tool-label')].map(n=>n.textContent);
   const thought=document.querySelector('.thinking-block');thought.querySelector('.thinking-block-head').click();
   return {initiallyCollapsed,expanded:!group.classList.contains('collapsed'),names,
    thoughtLabel:thought.querySelector('.thinking-label').textContent,
    overflow:document.documentElement.scrollWidth>innerWidth};
  })()`);
  assert(interaction.initiallyCollapsed&&interaction.expanded&&!interaction.overflow);
  assert(interaction.names.every(n=>n==='Wait for collaborators'));
  assert(!interaction.thoughtLabel.includes('Thinking'));
  const timestamp=await run(`(()=>{
   const {activity}=fixture,session=window.timestampSession;
   activity.beginActivityFrame(session,{ts:Date.UTC(2026,9,30,8,12,34)});
   activity.activityEvent(session,'agent:processing-done');
   const head=session.streamEl.querySelector('.execution-activity-head');head.click();
   const time=head.querySelector('time'),rect=time.getBoundingClientRect();
   return {iso:time.dateTime,visible:!time.hidden,inside:rect.left>=0&&rect.right<=innerWidth,
    overflow:document.documentElement.scrollWidth>innerWidth};
  })()`);
  assert.deepEqual(timestamp,{iso:'2026-10-30T08:12:34.000Z',visible:true,inside:true,overflow:false});
  await fs.promises.writeFile(`/tmp/ashub-activity-time-${theme}-${width}.png`,(await win.webContents.capturePage()).toPNG());
  console.log('PASS activity detail layout',theme,width,result);
 }
}).then(()=>finish(0),e=>{console.error(e);finish(1)});
function finish(code){clearTimeout(watchdog);win?.destroy();server?.close();try{fs.rmSync(profile,{recursive:true,force:true})}catch{}app.exit(code);}

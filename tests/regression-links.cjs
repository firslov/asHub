const test = require('node:test');
const assert = require('node:assert/strict');
const { env } = require('./harness.cjs');
const tick = () => new Promise(r => setImmediate(r));

function setup(response = {ok:true,headers:{get:()=> 'attachment; filename="download"'}}) {
  let click;
  const saved=[], requests=[], notices=[], external=[];
  const origin='http://127.0.0.1:7878';
  const anchor=(href,sid)=>({
    href, getAttribute:key=>key==='href'?href:null,
    closest:selector=>selector==='a'?null:sid?{getAttribute:()=>sid}:null,
  });
  const document={addEventListener:(name,fn)=>{if(name==='click')click=fn;},body:{append(){}},createElement:()=>{
    const a={closest:selector=>selector==='a'?a:null,remove(){},click(){
      let prevented=false; click({target:a,preventDefault(){prevented=true;}});
      assert.equal(prevented,false,'generated download recursively intercepted');
      saved.push({href:a.href,download:a.download,target:a.target});
    }};return a;
  }};
  const e=env({modules:{'./toast.js':{toast:m=>notices.push(m)},'./i18n.js':{t:k=>k}},globals:{
    document,location:{origin,href:origin+'/aaaaaa/'},window:{electronAPI:{openExternal:async href=>external.push(href)}},
    fetch:async(url,opts)=>{requests.push({url,opts});return typeof response==='function'?response():response;},
  }});
  const mod=e.load('web/js/links.js');
  return {mod,saved,requests,notices,external,origin,click(href,sid,prevented=false){
    const a=anchor(href,sid);a.closest=selector=>selector==='a'?a:sid?{getAttribute:()=>sid}:null;
    const event={target:a,defaultPrevented:prevented,preventDefault(){this.defaultPrevented=true;}};click(event);return event;
  }};
}

test('existing Chinese artifact links and relative links resolve to their owning session',async()=>{
  const s=setup();
  const file='论文协作_20261023/integration/v3_author_review/Animals_Author_Review_v3.docx';
  assert.equal(s.click(s.origin+'/566eb2/'+encodeURI(file)).defaultPrevented,true);
  await tick();
  assert.equal(s.requests[0].opts.method,'HEAD');
  const url=new URL(s.saved[0].href);
  assert.equal(url.pathname,'/566eb2/artifacts');assert.equal(url.searchParams.get('path'),file);
  assert.equal(s.saved[0].download,'Animals_Author_Review_v3.docx');assert.equal(s.saved[0].target,'_blank');
  s.click('output/review%20%23%25.md','bbbbbb');await tick();
  assert.equal(new URL(s.saved[1].href).pathname,'/bbbbbb/artifacts');
  assert.equal(new URL(s.saved[1].href).searchParams.get('path'),'output/review #%.md');
});

test('missing, denied, offline and login-redirected files keep the conversation and show an error',async()=>{
  for(const response of [{ok:false,status:404},{ok:false,status:403},{ok:true,headers:{get:()=>null}},()=>{throw Error('offline');}]) {
    const s=setup(response);assert.equal(s.click('missing.docx').defaultPrevented,true);await tick();
    assert.equal(s.saved.length,0);assert.equal(s.notices.length,1);assert.equal(s.external.length,0);
  }
  const s=setup();assert.equal(s.click('bad%xx.docx').defaultPrevented,true);
  assert.equal(s.notices.length,1);assert.equal(s.requests.length,0);
});

test('session navigation, fragments and handled clicks retain their behavior; external URLs stay external',async()=>{
  const s=setup();
  for(const href of ['/bbbbbb/','/bbbbbb/index.html','#section']) assert.equal(s.click(href).defaultPrevented,false);
  s.click('ignored.docx',undefined,true);
  assert.equal(s.requests.length,0);
  assert.equal(s.click('https://example.com/paper.docx').defaultPrevented,true);await tick();
  assert.deepEqual(s.external,['https://example.com/paper.docx']);assert.equal(s.requests.length,0);
});

test('extensionless relative artifacts use the message session without navigating away',async()=>{
  const s=setup();
  assert.equal(s.click('output/LICENSE','bbbbbb').defaultPrevented,true);
  await tick();
  const url=new URL(s.saved[0].href);
  assert.equal(url.pathname,'/bbbbbb/artifacts');
  assert.equal(url.searchParams.get('path'),'output/LICENSE');
  assert.equal(s.saved[0].download,'LICENSE');
});

test('parent-relative artifact paths reach containment checks instead of escaping the session route',async()=>{
  const s=setup({ok:false,status:403});
  for(const href of ['../private.docx','%2e%2e/private.docx','output/../../private.docx']) {
    assert.equal(s.click(href,'bbbbbb').defaultPrevented,true,href);
    await tick();
    const url=new URL(s.requests.at(-1).url);
    assert.equal(url.pathname,'/bbbbbb/artifacts');
    assert.equal(url.searchParams.get('path'),decodeURIComponent(href));
  }
  assert.equal(s.saved.length,0);assert.equal(s.notices.length,3);
  for(const href of ['../aaaaaa/','../aaaaaa/index.html','?view=chat']) assert.equal(s.click(href,'bbbbbb').defaultPrevented,false);
});

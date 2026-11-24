const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict'),{once}=require('node:events'),{pathToFileURL}=require('node:url');
const {env,Bridge,fs,path,root}=require('./harness.cjs');
const modules={},e=env({modules,globals:{setTimeout,clearTimeout,setInterval,clearInterval,Date}});
process.env.AGENT_SH_HOME=e.dir;app.setPath('userData',path.join(e.dir,'browser'));app.on('window-all-closed',()=>{});
const deadline=setTimeout(()=>{console.error('Voice UI timeout');app.exit(1);},90000);
let hub,win;
app.whenReady().then(async()=>{
 const originalFetch=globalThis.fetch,vault=new Map();let conversions=0,submits=0,asrStatus=200;
 try{
  globalThis.fetch=async(url,opts)=>{if(String(url)==='https://fixture.test/audio/transcriptions'){conversions++;assert.equal(opts.headers.Authorization,'Bearer fixture-key');assert.equal(opts.body.get('file').type,'audio/mp4');return new Response(JSON.stringify({text:'这是测试转写'}),{status:asrStatus});}return originalFetch(url,opts);};
  modules['./extensions/installed.js']=await import(pathToFileURL(path.join(root,'dist/extensions/installed.js')).href);
  hub=e.hub().startHub({host:'127.0.0.1',port:0,webRoot:path.join(root,'web'),pluginSecretStore:{read:k=>vault.get(k)||null,write:(k,v)=>v===null?vault.delete(k):vault.set(k,v)},makeBridge:opts=>{const bridge=new Bridge(opts);bridge.submit=async()=>{submits++;return{stopReason:'done'};};setTimeout(()=>bridge.emit('event',{name:'agent:info',payload:{model:'tiny',provider:'mock',modalities:['image']}}),0);return bridge;}});
  await once(hub.server,'listening');const base='http://127.0.0.1:'+hub.server.address().port;
  const call=async(route,body,method=body?'POST':'GET')=>{const r=await originalFetch(base+route,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const raw=await r.text();assert.equal(r.status,200,raw);return JSON.parse(raw);};
  const voice=(await call('/api/plugins')).plugins.find(plugin=>plugin.manifest?.id==='ashub-voice-input');
  assert(voice?.bundled && !voice.enabled);
  await call('/api/plugins',{id:voice.id,enabled:true},'PUT');
  let feature;for(let i=0;i<100;i++){feature=(await call('/api/extensions')).features.find(f=>f.name==='语音输入');if(feature?.state==='active')break;await new Promise(r=>setTimeout(r,20));}assert.equal(feature?.state,'active',JSON.stringify(feature));
  const resource='/api/plugin-resources/'+feature.pluginId+'/settings';
  const prepared=await call(resource,{action:'save',values:{endpoint:'https://fixture.test/audio/transcriptions',model:'fixture',apiKey:'fixture-key'}});assert(prepared.confirmation);assert(!JSON.stringify(prepared).includes('fixture-key'));await call(resource,{confirm:prepared.confirmation.id});assert.equal(vault.size,1);
  const sid=(await call('/sessions',{cwd:e.dir,kind:'agent',title:'语音验收',model:'tiny',provider:'mock'})).instanceId;
  const denied=await originalFetch(base+resource+'?remoteSession='+sid);assert.equal(denied.status,409,'remote cannot read or edit ASR credentials');
  assert.equal((await originalFetch(base+'/'+sid+'/composer-inputs',{headers:{Origin:'https://evil.test'}})).status,403);
  win=new BrowserWindow({show:true,useContentSize:true,width:1200,height:800,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  const errors=[];win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message);});
  await win.loadURL(base+'/'+sid+'/');
  const js=async code=>{try{return await win.webContents.executeJavaScript(code);}catch(error){console.error('Renderer expression:',code,errors);throw error;}};
  const wait=async code=>{for(let i=0;i<180;i++){if(await js(code))return;await new Promise(r=>setTimeout(r,25));}throw Error('Timed out: '+code);};
  const locale=code=>js(`(async()=>{(await import('/js/i18n.js')).setLang(${JSON.stringify(code)});})()`);
  const screenshotDir=process.env.ASHUB_UI_SCREENSHOTS || '/tmp';
  fs.mkdirSync(screenshotDir,{recursive:true});
  const capture=async name=>{
    await js(`(async () => {
      await document.fonts.ready;
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      await Promise.all(document.getAnimations().filter(a=>a.playState==='running' && a.effect?.getComputedTiming().endTime<Infinity)
        .map(a=>a.finished.catch(()=>{})));
    })()`);
    fs.writeFileSync(path.join(screenshotDir,name),(await win.webContents.capturePage()).toPNG());
  };
  const mic="document.querySelector('.composer-media-button')";
  const mediaState="document.querySelector('.composer-media').dataset.state";
  const mediaStatus="document.querySelector('.composer-media-status').textContent";
  const expectStatus=text=>wait(`${mediaStatus}.includes(${JSON.stringify(text)})`);
  await js(fs.readFileSync(path.join(root,'tests/fixtures/media-recorder.js'),'utf8'));
  await wait("!!document.querySelector('.composer-media:not([hidden])') && !document.querySelector('.composer-media-button').disabled");
  await js("query.value='已有草稿：';query.setSelectionRange(query.value.length,query.value.length);query.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.composer-media-button').click()");
  await wait("document.querySelector('.composer-media').dataset.state==='recording'");
  await js("document.querySelector('.composer-media-button').click()");await wait("query.value==='已有草稿：这是测试转写'");assert.equal(submits,0);assert.equal(conversions,1);
  assert(await js("getComputedStyle(document.querySelector('.composer-media-cancel')).display==='none'"));
  assert(await js('mediaFixture.tracks.every(t=>t.stopped)'));
  // Native/system interruption must release capture, not transcribe partial audio.
  await js("document.querySelector('.composer-media-button').click()");await wait("document.querySelector('.composer-media').dataset.state==='recording'");
  await js("mediaFixture.recorders.at(-1).stop()");await wait("document.querySelector('.composer-media').dataset.state==='idle'");
  assert.equal(conversions,1);assert.equal(submits,0);assert.equal(await js('query.value'),'已有草稿：这是测试转写');assert(await js('mediaFixture.tracks.every(t=>t.stopped)'));
  // Closing the optional plugin removes capability, never clears the existing draft.
  await call('/api/extensions/'+feature.id+'/enabled',{enabled:false});await js("(async()=>{await (await import('/js/extensions/feature-state.js')).refreshFeatures()})()");
  await wait("document.querySelector('.composer-media').hidden");assert.equal(await js('query.value'),'已有草稿：这是测试转写');
  await call('/api/extensions/'+feature.id+'/enabled',{enabled:true});await js("(async()=>{await (await import('/js/extensions/feature-state.js')).refreshFeatures()})()");await wait("!document.querySelector('.composer-media').hidden");
  // Isolated capture exercises real renderer events and the bundled transcription adapter.
  const messages={
    en:{mic:'Voice input',stop:'Stop recording and transcribe',elapsed:'Recording',interrupted:'Recording was interrupted',empty:'No recording data was captured',denied:'Microphone access was denied',cancel:'Cancel',cancelled:'Cancelled. Your draft is unchanged.',auth:'Transcription authentication failed'},
    zh:{mic:'语音输入',stop:'结束录音并转写',elapsed:'录音 ',interrupted:'录音中断',empty:'未取得录音数据',denied:'麦克风未获授权',cancel:'取消',cancelled:'已取消 · 草稿保留',auth:'转写服务认证失败'},
  };
  const savedDraft=await js('query.value');
  for(const [code,message] of Object.entries(messages)){
    const before=conversions;
    await locale(code);
    await wait(`${mic}.ariaLabel===${JSON.stringify(message.mic)}`);
    await js(`${mic}.click()`);await wait(`${mediaState}==='recording'`);
    await expectStatus(message.elapsed);
    assert.equal(await js(`${mic}.ariaLabel`),message.stop);
    await js('mediaFixture.recorders.at(-1).stop()');await expectStatus(message.interrupted);
    if(process.env.ASHUB_UI_SCREENSHOTS){
      await js("Promise.all(document.getAnimations().filter(a=>a.effect?.getComputedTiming().endTime<Infinity).map(a=>a.finished.catch(()=>{}))).then(()=>true)");
      await capture('ashub-voice-interrupted-'+code+'.png');
    }
    // Repaint a completed status when the application language changes, without making another request.
    const other=code==='en'?'zh':'en';await locale(other);await expectStatus(messages[other].interrupted);await locale(code);
    await js(`mediaFixture.emptyRecording=true;${mic}.click()`);await wait(`${mediaState}==='recording'`);
    await js(`${mic}.click()`);await expectStatus(message.empty);
    await js(`mediaFixture.emptyRecording=false;mediaFixture.permission='deny';${mic}.click()`);await expectStatus(message.denied);
    await js(`mediaFixture.permission='allow';${mic}.click()`);await wait(`${mediaState}==='recording'`);
    assert.equal(await js("document.querySelector('.composer-media-cancel').textContent"),message.cancel);
    await js("document.querySelector('.composer-media-cancel').click()");await expectStatus(message.cancelled);
    assert.equal(conversions,before);assert.equal(submits,0);assert.equal(await js('query.value'),savedDraft);
    asrStatus=401;
    await js(`${mic}.click()`);await wait(`${mediaState}==='recording'`);
    await js(`${mic}.click()`);await expectStatus(message.auth);
    assert.equal(conversions,before+1);assert.equal(submits,0);assert.equal(await js('query.value'),savedDraft);
    assert(await js('mediaFixture.tracks.every(t=>t.stopped)'));
    asrStatus=200;
  }
  // Render the plugin's declarative panel on one page without displaying the key.
  await locale('zh');
  await wait(`!!document.querySelector('.extension-menu[aria-label="语音输入"]')`);
  await js("Array.from(document.querySelectorAll('.extension-menu')).find(b=>b.title.includes('语音输入')).click()");
  await wait("Array.from(document.querySelectorAll('.extension-resource-form')).some(f=>f.textContent.includes('API Key'))");
  assert(!await js("document.body.innerText.includes('fixture-key')"));
  await wait("Array.from(document.querySelectorAll('.extension-panel:not([hidden])')).some(f=>f.textContent.includes('API Key'))");
  await js(`(() => {
    const form=document.querySelector('.extension-panel:not([hidden]) .extension-resource-form');
    const mode=form.querySelector('select'), key=form.querySelector('input[type=password]');
    if (mode.value!=='custom' || key.closest('label').hidden) throw Error('Existing custom configuration not shown');
    mode.value='default';mode.dispatchEvent(new Event('change',{bubbles:true}));
    if (!key.closest('label').hidden || !key.disabled) throw Error('Free mode still shows the API key field');
    mode.value='custom';mode.dispatchEvent(new Event('change',{bubbles:true}));
    if (key.closest('label').hidden || key.disabled) throw Error('Could not switch back to the custom fields');
  })()`);
  await js("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
  await new Promise(r=>setTimeout(r,250));
  const layout=await js("(()=>{const q=query.getBoundingClientRect(),b=document.querySelector('.composer-media-button').getBoundingClientRect(),p=document.querySelector('.extension-panel:not([hidden])').getBoundingClientRect();return {q:q.toJSON(),b:b.toJSON(),p:p.toJSON(),h:innerHeight,w:innerWidth}})()");
  assert(layout.b.bottom<=layout.h && layout.q.bottom<=layout.h && layout.b.width>0 && layout.p.right<=layout.w+1,JSON.stringify(layout));
  await capture('ashub-voice-desktop.png');
  await js(`(() => {
    window.voicePanel=()=>document.querySelector('.extension-panel:not([hidden])');
    window.voiceFields=()=>Array.from(voicePanel().querySelectorAll('form .extension-field'));
    window.setVoiceMode=value=>{
      const [service]=voiceFields();
      service.value=value;
      service.dispatchEvent(new Event('change',{bubbles:true}));
    };
  })()`);
  const originalTheme=await js("document.documentElement.dataset.theme");
  const originalSidebar=await js("document.querySelector('.app').classList.contains('sidebar-collapsed')");
  const setTheme=theme=>js(`if(document.documentElement.dataset.theme!==${JSON.stringify(theme)}) document.getElementById('theme-toggle').click()`);
  const resize=async width=>{
    win.setContentSize(width,800);
    await wait(`innerWidth===${width}`);
    await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  };
  for(const width of [1200,390,320]){
    await resize(width);
    if(width<700){
      // Open the drawer at the narrow width through its normal toolbar action.
      await js(`(() => {
        const panel=voicePanel(), trigger=document.getElementById(panel.id.replace(/-panel$/, '-toggle'));
        panel.querySelector('.p-head button').click();
        trigger.click();
      })()`);
      await wait("voicePanel()?.querySelector('form') && getComputedStyle(document.getElementById('sidebar')).visibility==='hidden'");
    }
    for(const [code,labels] of Object.entries({
      en:{title:'Voice input',free:'shared quota',custom:'Your provider may charge',setup:'Tencent Hunyuan setup'},
      zh:{title:'语音输入',free:'共享额度',custom:'服务商可能收费',setup:'腾讯混元接入说明'},
    })){
      await locale(code);
      await wait(`voicePanel().querySelector('h2').textContent===${JSON.stringify(labels.title)}`);
      for(const theme of ['light','dark']){
        await setTheme(theme);
        for(const mode of ['default','custom']){
          const state=await js(`(() => {
            setVoiceMode(${JSON.stringify(mode)});
            const panel=voicePanel(), body=panel.querySelector('.p-body'), text=body.innerText;
            const [service,endpoint,model,key]=voiceFields();
            const save=body.querySelector('button[type=submit]'), reset=body.querySelector('.extension-resource-actions button');
            const guide=body.querySelector('.extension-resource-guidance');
            body.scrollTop=0;
            const bodyBounds=body.getBoundingClientRect(), modeBounds=service.getBoundingClientRect();
            const visible=el=>!el.closest('[hidden]') && el.getClientRects().length>0;
            const hittable=el=>{
              const r=el.getBoundingClientRect();
              return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));
            };
            const customFields=[endpoint,model,key].map(field=>visible(field)&&!field.disabled);
            return {
              text, titleHeight:panel.querySelector('.p-head').offsetHeight,
              selectorOffset:modeBounds.top-bodyBounds.top, saveVisible:save.getBoundingClientRect().bottom<=bodyBounds.bottom,
              resetBelow:reset.getBoundingClientRect().top>save.getBoundingClientRect().bottom,
              inside:panel.getBoundingClientRect().left>=-1 && panel.getBoundingClientRect().right<=innerWidth+1 && body.scrollWidth<=body.clientWidth+1,
              hittable:hittable(service)&&hittable(save),
              customFields, guideVisible:visible(guide), guideClosed:!guide.open,
            };
          })()`);
          const context=JSON.stringify({width,code,theme,mode,state});
          assert(state.titleHeight<=64 && state.selectorOffset<=54 && state.selectorOffset>=0 && state.saveVisible && state.resetBelow && state.inside && state.hittable,context);
          assert.equal(state.text.includes(labels.free),mode==='default',context);
          assert.equal(state.text.includes(labels.custom),mode==='custom',context);
          assert(state.customFields.every(visible=>visible===(mode==='custom')),context);
          assert(state.guideClosed && state.guideVisible===(mode==='custom'),context);
          assert.equal(state.text.includes(labels.setup),mode==='custom',context);
          if(process.env.ASHUB_UI_SCREENSHOTS && ((width===1200 && code==='en' && theme==='light') || (width===390 && ((code==='zh' && theme==='dark') || (code==='en' && theme==='light')))))
            await capture(`ashub-voice-layout-${width}-${code}-${theme}-${mode}.png`);
        }
      }
    }
  }
  await js(`(() => {
    const body=voicePanel().querySelector('.p-body');
    body.querySelector('.extension-resource-guidance summary').click();
  })()`);
  const help=await js(`(() => {
    const body=voicePanel().querySelector('.p-body');
    const guide=body.querySelector('.extension-resource-guidance');
    return {open:guide.open,text:guide.innerText,inside:body.scrollWidth<=body.clientWidth+1};
  })()`);
  assert(help.open && help.inside && help.text.includes('tokenhub.tencentmaas.com') && help.text.includes('hy-asr-3.0-preview') && help.text.includes('TokenHub API Key'),JSON.stringify(help));
  if(process.env.ASHUB_UI_SCREENSHOTS){
    await js("voicePanel().querySelector('.extension-resource-guidance').scrollIntoView({block:'end'})");
    await capture('ashub-voice-layout-320-zh-dark-hunyuan.png');
  }
  await js("voicePanel().querySelector('.extension-resource-guidance summary').click();voicePanel().querySelector('.p-body').scrollTop=0");
  await resize(1200);
  await setTheme(originalTheme);
  await js(`if(document.querySelector('.app').classList.contains('sidebar-collapsed')!==${originalSidebar}) document.getElementById('sidebar-toggle').click()`);
  await js(`(() => {
    const [,endpoint,model,key]=voiceFields();
    endpoint.value='https://draft.example.test/voice';model.value='draft-model';key.value='unsaved-fixture-key';
    setVoiceMode('default');
    setVoiceMode('custom');
    const original=window.fetch;
    window.fetch=async (url, options) => {
      const result=await original(url,options);
      if (String(url).endsWith('/settings') && options?.method === 'GET' && options?.headers?.['X-Ashub-Locale'] === 'en') {
        window.fetch=original;
        await new Promise(resolve=>window.releaseVoiceTranslation=resolve);
      }
      return result;
    };
  })()`);
  await locale('en');
  await wait("typeof window.releaseVoiceTranslation==='function'");
  await js(`(() => {
    const [,endpoint,model]=voiceFields();model.value='late-draft-model';
    endpoint.focus();endpoint.setSelectionRange(8,13);
  })()`);
  await js('releaseVoiceTranslation()');
  await wait("voicePanel().querySelector('h2').textContent==='Voice input'");
  const draft = await js(`(() => {
    const [mode,endpoint,model,key]=voiceFields();
    return {mode:mode.value,endpoint:endpoint.value,model:model.value,key:key.value,focused:document.activeElement===endpoint,start:endpoint.selectionStart,end:endpoint.selectionEnd};
  })()`);
  assert.deepEqual(draft,{mode:'custom',endpoint:'https://draft.example.test/voice',model:'late-draft-model',key:'unsaved-fixture-key',focused:true,start:8,end:13});
  await js(`(() => {
    const original=window.fetch;window.fetch=async (url,options)=>{
      const result=await original(url,options);
      if(String(url).endsWith('/settings') && options?.method === 'GET' && options?.headers?.['X-Ashub-Locale']==='zh') {
        window.fetch=original;await new Promise(resolve=>window.releaseOldVoiceTranslation=resolve);
        requestAnimationFrame(()=>requestAnimationFrame(()=>window.oldVoiceTranslationSettled=true));
      }
      return result;
    };
  })()`);
  await locale('zh');await wait("typeof releaseOldVoiceTranslation === 'function'");
  await locale('en');await js('releaseOldVoiceTranslation()');await wait('window.oldVoiceTranslationSettled===true');
  assert.equal(await js("voicePanel().querySelector('h2').textContent"),'Voice input');
  assert.equal(await js('voiceFields()[3].value'),'unsaved-fixture-key');
  const rendered = await js('voicePanel().innerText');
  for (const value of ['Transcription service','Transcription endpoint (HTTPS)','Transcription model','API key (leave blank to keep)','Clear custom settings','Custom transcription','Save','Your provider may charge','Mobile access']) assert(rendered.includes(value),value);
  assert(!/\p{Script=Han}/u.test(rendered),rendered);
  assert(await js("!!document.querySelector('.extension-menu[aria-label=\"Voice input\"]')"));
  await js(`(() => {
    const [,endpoint,model,key]=voiceFields();endpoint.value='http://fixture.test/audio/transcriptions';model.value='fixture';key.value='';
    voicePanel().querySelector('form').requestSubmit();
  })()`);
  await wait("voicePanel().querySelector('.plugins-message').innerText.includes('Use HTTPS')");
  await js("voicePanel().querySelector('.p-body').scrollTop=voicePanel().querySelector('.p-body').scrollHeight");
  await capture('ashub-voice-settings-en-validation.png');
  await js("voicePanel().querySelector('.p-body').scrollTop=0");
  await js("voiceFields()[1].value='https://fixture.test/audio/transcriptions';voiceFields()[1].dispatchEvent(new Event('input',{bubbles:true}));");
  await capture('ashub-voice-settings-en.png');
  await js("voicePanel().querySelector('form').requestSubmit()");
  await wait("voicePanel().querySelector('h3')?.textContent==='Configure voice input'");
  assert(await js("Array.from(voicePanel().querySelectorAll('button'),b=>b.textContent).includes('Confirm')"));
  assert(!await js("voicePanel().innerText.includes('fixture-key')"));
  await capture('ashub-voice-confirm-en.png');
  await js("Array.from(voicePanel().querySelectorAll('button')).find(b=>b.textContent==='Cancel').click()");
  await locale('zh');await wait("voicePanel().querySelector('h2').textContent==='语音输入'");
  assert(await js("voicePanel().innerText.includes('转写服务') && voicePanel().innerText.includes('清除自定义配置')"));
  assert.equal(await js('voiceFields()[2].value'),'fixture');
  assert.equal(await js('voiceFields()[3].value'),'');
  await capture('ashub-voice-settings-zh.png');
  await js(`(() => {
    const original=window.fetch;window.voiceSaveCalls=0;
    window.fetch=async(url,options)=>{
      const tracked=String(url).endsWith('/settings') && options?.method==='POST';
      if(tracked)window.voiceSaveCalls++;
      const response=await original(url,options);
      if(tracked)await new Promise(resolve=>window.releaseVoiceSave=resolve);
      return response;
    };
    voiceFields()[1].value='http://invalid.test';voiceFields()[2].value='another-draft';
    voicePanel().querySelector('form').requestSubmit();
  })()`);
  await wait("typeof window.releaseVoiceSave==='function'");
  await locale('en');
  assert(await js("voicePanel().querySelector('button[type=submit]').disabled"));
  await js("voicePanel().querySelector('form').requestSubmit()");
  assert.equal(await js('voiceSaveCalls'),1);
  await js('releaseVoiceSave()');
  await wait("voicePanel().querySelector('h2').textContent==='Voice input'");
  assert.equal(await js('voiceFields()[1].value'),'http://invalid.test');
  assert.equal(await js('voiceFields()[2].value'),'another-draft');
  // The native picker can return after the active conversation changes.
  // Keep the real button, file change and image decoder, delaying only the dialog result.
  const second=(await call('/sessions',{cwd:e.dir,kind:'agent',title:'另一会话',model:'tiny',provider:'mock'})).instanceId;
  await wait("!document.getElementById('vision-indicator').hidden");
  await js(`(() => {
    const click=HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click=function() {
      if (this.type==='file') window.pendingPicker=this;
      else click.call(this);
    };
    document.getElementById('vision-indicator').click();
    HTMLInputElement.prototype.click=click;
    if (!window.pendingPicker) throw Error('File picker did not open');
    window.__ash.switchTo(${JSON.stringify(second)});
  })()`);
  await wait("query.value===''");
  await js(`(async () => {
    query.value='另一会话的草稿';query.dispatchEvent(new Event('input',{bubbles:true}));
    const canvas=document.createElement('canvas');canvas.width=1;canvas.height=1;
    const png=await new Promise(resolve=>canvas.toBlob(resolve));
    const data=new DataTransfer();data.items.add(new File([png],'fixture.png',{type:'image/png'}));
    window.pendingPicker.files=data.files;
    window.pendingPicker.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  await js(`window.__ash.switchTo(${JSON.stringify(sid)})`);
  await wait("!!document.querySelector('#image-previews img')");
  assert.equal(await js('query.value'),'已有草稿：这是测试转写');
  await js(`window.__ash.switchTo(${JSON.stringify(second)})`);
  assert.equal(await js('query.value'),'另一会话的草稿');
  assert.equal(await js("document.querySelector('#image-previews img')"),null,'the image belongs to the session that opened the picker');
  assert.equal(submits,0);
  assert(!errors.some(e=>/ReferenceError|TypeError/.test(e)),JSON.stringify(errors));
  console.log('PASS bundled voice plugin: mode-specific settings at 320/390/1200px in each language and theme, localized errors, retained form edits and focus, stale locale rejection, bundled opt-in, encrypted configuration, explicit confirmation, desktop draft-only conversion, image picker session ownership, enable/disable restore, forbidden remote config and cross-origin');
  win.destroy();await hub.shutdown();clearTimeout(deadline);app.exit(0);
 }catch(error){console.error(error);win?.destroy();try{await hub?.shutdown();}catch{}clearTimeout(deadline);app.exit(1);}finally{globalThis.fetch=originalFetch;}
});

/* Host-owned capture and draft lifecycle. Conversion/providers are registered by plugins. */
(() => {
  const microphone = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/></svg>';
  const types = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  const appleMobile = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const pcmAvailable = () => !!((globalThis.AudioContext || globalThis.webkitAudioContext) && globalThis.AudioWorkletNode);
  const canRetryStatus = error => error instanceof TypeError || error?.name === 'TimeoutError' ||
    [502, 503, 504].includes(error?.status);
  function mount({ container, input, form, owner, request, enabled = () => !input.disabled }) {
    if (!container || !input || !form) return {refresh:async()=>{},cancel(){},dispose(){}};
    const root = document.createElement('span'); root.className = 'composer-media'; root.hidden = true;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'composer-media-button'; button.innerHTML = microphone;
    const cancelButton = document.createElement('button'); cancelButton.type = 'button'; cancelButton.className = 'composer-media-cancel'; cancelButton.textContent = '取消'; cancelButton.hidden = true;
    const status = document.createElement('span'); status.className = 'composer-media-status'; status.setAttribute('role','status'); status.setAttribute('aria-live','polite');
    root.append(button,cancelButton); container.prepend(root); form.append(status);
    let descriptor, ticket = null, phase = 'idle', renderKey = '', revision = 0, composing = false, disposed = false, catalog = 0, knownOwner = owner();
    const supports = () => !!((descriptor?.audioFormat === 'pcm-wav' ? pcmAvailable() : globalThis.MediaRecorder || pcmAvailable()) && navigator.mediaDevices?.getUserMedia && globalThis.isSecureContext);
    const current = t => !!t && ticket === t && !disposed && t.owner === owner() && !t.controller.signal.aborted;
    const label = message => { if (status.textContent !== message) status.textContent = message; };
    function render() {
      const nextKey=JSON.stringify([descriptor?.id,descriptor?.label,descriptor?.description,phase,supports(),enabled()]);
      if(nextKey===renderKey)return;renderKey=nextKey;
      root.hidden = !descriptor;
      // A temporary history resync blocks new recordings, not finishing the current one.
      button.disabled = !supports() || (phase === 'recording' ? !current(ticket) : phase !== 'idle' || !enabled());
      button.title = button.disabled && !supports() ? '此环境不支持录音，请使用 HTTPS 页面或桌面客户端' : phase === 'recording' ? '结束录音并转写' : descriptor?.description || '语音输入';
      button.setAttribute('aria-label', phase === 'recording' ? '结束录音并转写' : descriptor?.label || '语音输入');
      button.setAttribute('aria-pressed', String(phase === 'recording'));
      root.dataset.state = phase; status.setAttribute('aria-live',phase === 'recording' ? 'off' : 'polite'); cancelButton.hidden = phase === 'idle';
      button.innerHTML = phase === 'recording' ? '<span class="composer-media-stop" aria-hidden="true"></span>' : microphone;
    }
    function stopTracks(t) { if (!t) return; t.ending = true; clearInterval(t.clock); clearTimeout(t.stopTimer); t.stream?.getTracks().forEach(track => track.stop()); if(t.audioContext && t.audioContext.state!=='closed')void t.audioContext.close().catch(()=>{}); }
    function cancel(message = '') {
      const t = ticket; ticket = null;
      if (t) {
        t.controller.abort(); stopTracks(t);
        if (t.recorder?.state !== 'inactive') { try { t.recorder?.stop(); } catch {} }
        if (t.started) void request(t.owner, 'cancel', { input:t.input.id, requestId:t.id }).catch(()=>{});
        t.chunks.length = 0;
      }
      phase = 'idle'; label(message); render();
    }
    async function refresh() {
      const o = owner(), version = ++catalog;
      if (o !== knownOwner) {
        // A fresh recording can already belong to this owner before the poll
        // observes the switch. Only invalidate a ticket from the old owner;
        // the catalog below still checks the new owner's input revision.
        if (!ticket || ticket.owner !== o) { cancel(); descriptor = undefined; }
        knownOwner = o;
      }
      if (!o || disposed || !enabled()) { render(); return; }
      try {
        const list = await request(o,'list',{});
        if (version !== catalog || disposed || o !== owner()) return;
        const next = Array.isArray(list) && list.find(d => d.kind === 'audio' && /^[a-f0-9]{32}$/.test(d.id) && typeof d.revision === 'string' && d.maxBytes > 0 && d.maxBytes <= 4194304 && d.maxDuration > 0 && d.maxDuration <= 60);
        if (ticket && (!next || next.id !== ticket.input.id || next.revision !== ticket.input.revision)) cancel('语音输入配置已变更，请重新录音');
        descriptor = next || undefined; render();
      } catch { if (o === owner() && version === catalog && !ticket) { descriptor = undefined; render(); } }
    }
    function insert(t,text) {
      if (!current(t)) return;
      if (composing) { t.result = text; phase = 'inserting'; label('等待输入完成…'); return; }
      if (!text.trim()) { cancel('未识别到语音，草稿未修改'); return; }
      const unchanged = revision === t.revision && input.value === t.text;
      const before = unchanged ? t.text.slice(0,t.start) : input.value;
      const after = unchanged ? t.text.slice(t.end) : '';
      const prefix = !unchanged && before && !/\s$/.test(before) ? '\n' : '';
      const value = before + prefix + text + after;
      if (value.length > (input.maxLength > 0 ? input.maxLength : 200000)) { cancel('草稿已达到长度限制，未插入转写结果'); return; }
      input.value = value; input.setSelectionRange((before+prefix+text).length,(before+prefix+text).length);
      input.dispatchEvent(new Event('input',{bubbles:true}));
      ticket = null; t.controller.abort(); phase = 'idle'; label('已加入草稿 · 请确认后发送'); render();
      // No focus(): iPhone must not pop its keyboard or move the viewport after a late response.
    }
    async function convert(t) {
      if (!current(t)) return;
      stopTracks(t); phase = 'transcribing'; label('正在转写…'); render();
      try {
        const blob = new Blob(t.chunks,{type:t.recorder.mimeType || t.mime}); t.chunks.length = 0;
        if (!blob.size) throw Error(t.pcm?'未收到麦克风音频，请在 Safari 中打开页面检查麦克风权限':'未取得录音数据，请重新录音；若仍失败，请重新打开页面');
        if (blob.size > t.input.maxBytes) throw Error('录音超过大小限制，请缩短后重试');
        const data = await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result).split(',')[1]);r.onerror=()=>reject(Error('无法读取录音'));r.readAsDataURL(blob);});
        if (!current(t)) return;
        t.started = true;
        const receipt = {input:t.input.id, requestId:t.id};
        let result = {state:'pending'}, startError;
        try {
          result = await request(t.owner, 'start', {...receipt, revision:t.input.revision, data, mimeType:blob.type}, t.controller.signal);
        } catch (error) {
          if (!current(t) || !canRetryStatus(error)) throw error;
          // If the acknowledgement was lost, look up this ID without resending audio.
          startError = error;
        }
        const deadline = Date.now()+95000;
        while(current(t) && result.state === 'pending') {
          if(Date.now()>deadline) throw Error('转写超时，请稍后重试');
          await new Promise(resolve=>{const done=()=>{clearTimeout(timer);t.controller.signal.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,700);t.controller.signal.addEventListener('abort',done,{once:true});});
          if(!current(t)) return;
          try {
            result = await request(t.owner, 'status', receipt, t.controller.signal);
            startError = undefined;
          } catch (error) {
            if (!current(t)) return;
            if (startError && error?.status === 404) throw startError;
            if (!canRetryStatus(error)) throw error;
          }
        }
        if(!current(t)) return;
        if(result.state !== 'done' || typeof result.text !== 'string') throw Error(result.error || '转写已取消，请重新录音');
        insert(t,result.text);
      } catch(e) { if(current(t)) cancel(String(e?.message || '转写失败，草稿未修改')); }
    }
    async function start() {
      if(!descriptor || !supports() || !owner() || !enabled() || disposed) return;
      const t = { owner:owner(), input:{...descriptor}, controller:new AbortController(), id:crypto.randomUUID(), text:input.value, revision, start:input.selectionStart,end:input.selectionEnd,chunks:[],size:0,ending:false,finishRequested:false,started:false };
      ticket=t; phase='permission'; label('等待麦克风授权…'); render();
      try {
        // Create/resume synchronously in the tap handler, before awaiting permission.
        t.pcm=pcmAvailable() && (t.input.audioFormat === 'pcm-wav' || appleMobile() || !globalThis.MediaRecorder);
        if(t.pcm){t.audioContext=new (globalThis.AudioContext || globalThis.webkitAudioContext)();t.audioReady=t.audioContext.resume();t.audioReady.catch(()=>{});}
        const stream = await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true},video:false});
        t.stream=stream;
        if(!current(t)) {stopTracks(t);return;}
        if(t.pcm){
          label('正在启动麦克风…');render();
          const {createPcmRecorder}=await import('./composer-pcm.js');
          if(!current(t)){stopTracks(t);return;}
          t.recorder=await createPcmRecorder(t.audioContext,stream,{signal:t.controller.signal,maxBytes:t.input.maxBytes,maxDuration:t.input.maxDuration});
          if(!current(t)){stopTracks(t);return;}
          t.mime='audio/wav';t.recorder.onlimit=()=>{if(current(t)&&phase==='recording')finish();};
        }else{
          t.mime=types.find(type=>MediaRecorder.isTypeSupported(type));
          if(!t.mime) throw Error('此浏览器暂不支持可用的录音格式');
          t.recorder=new MediaRecorder(stream,{mimeType:t.mime,audioBitsPerSecond:96000});
        }
        t.recorder.ondataavailable = event => { if(!current(t) || !event.data.size) return; t.size+=event.data.size;if(t.size>t.input.maxBytes)cancel('录音过大，已取消；草稿未修改');else t.chunks.push(event.data); };
        t.recorder.onerror = ()=>{if(current(t))cancel('录音中断，请重新录音');};
        t.recorder.onpause = ()=>{if(current(t))cancel('录音已暂停，请重新录音');};
        // Stream/system stops are not user consent to upload a partial recording.
        t.recorder.onstop = ()=>{if(current(t)){if(t.finishRequested)void convert(t);else cancel('录音中断，草稿未修改，请重新录音');}};
        stream.getTracks().forEach(track=>{track.onended=()=>{if(current(t)&&!t.ending)cancel('麦克风已中断，请重新录音');};track.onmute=()=>{if(current(t)&&!t.ending)cancel('麦克风已暂停，请重新录音');};});
        // Short bounded recordings need one complete file, not live fragments.
        // Older iOS MP4 recorders can emit empty sub-second slices.
        t.recorder.start(); t.time=Date.now(); phase='recording';
        const tick=()=>{if(!current(t))return;const elapsed=Math.floor((Date.now()-t.time)/1000);if(t.pcm&&elapsed>=3&&!t.recorder.samples){cancel('未收到麦克风音频，请在 Safari 中打开页面检查麦克风权限');return;}label('录音 '+String(Math.min(elapsed,t.input.maxDuration)).padStart(2,'0')+' / '+t.input.maxDuration+' 秒');if(elapsed>=t.input.maxDuration)finish();};
        t.clock=setInterval(tick,250);tick();render();
      } catch(e) { if(current(t)) cancel(e?.name==='NotAllowedError'?'麦克风未获授权，请在系统或浏览器设置中允许':String(e?.message || '无法开始录音'));else stopTracks(t); }
    }
    function finish() {
      const t=ticket;if(!current(t)||phase!=='recording')return;
      t.finishRequested=true;t.ending=true;clearInterval(t.clock);phase='transcribing';label('正在整理录音…');render();
      // stop() finishes asynchronously. Keep the source alive until the final
      // dataavailable + stop events; cancel/background still release it immediately.
      t.stopTimer=setTimeout(()=>{if(current(t))cancel('录音结束超时，请重新录音');},10000);
      try{t.recorder.stop();}catch{cancel('录音中断，请重试');}
    }
    button.onclick=()=>{if(phase==='recording')finish();else if(phase==='idle')void start();};
    cancelButton.onclick=()=>cancel('已取消 · 草稿保留');
    const edit=()=>{revision++;}; const compositionStart=()=>{composing=true;};const compositionEnd=()=>{composing=false;if(ticket?.result!==undefined)insert(ticket,ticket.result);};
    const submit=()=>cancel();const key=e=>{if(e.key==='Escape'&&ticket){e.preventDefault();cancel('已取消 · 草稿保留');}};
    const hide=()=>{if(document.hidden)cancel(ticket?'录音或转写已取消 · 草稿保留':'');};const leave=()=>cancel();const focus=()=>void refresh();
    input.addEventListener('input',edit);input.addEventListener('compositionstart',compositionStart);input.addEventListener('compositionend',compositionEnd);
    form.addEventListener('submit',submit,true);root.addEventListener('keydown',key);document.addEventListener('visibilitychange',hide);window.addEventListener('pagehide',leave);window.addEventListener('focus',focus);
    let ticks=0, wasEnabled=!!enabled();const clock=setInterval(()=>{const available=!!enabled(), becameEnabled=available&&!wasEnabled;wasEnabled=available;if(owner()!==knownOwner){void refresh();}else if(becameEnabled || (++ticks%60===0&&!document.hidden))void refresh();render();},250);
    void refresh();
    return {refresh,cancel,dispose(){cancel();disposed=true;clearInterval(clock);root.remove();status.remove();input.removeEventListener('input',edit);input.removeEventListener('compositionstart',compositionStart);input.removeEventListener('compositionend',compositionEnd);form.removeEventListener('submit',submit,true);root.removeEventListener('keydown',key);document.removeEventListener('visibilitychange',hide);window.removeEventListener('pagehide',leave);window.removeEventListener('focus',focus);}};
  }
  globalThis.AsHubComposerMedia = { mount };
})();

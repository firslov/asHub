/* Host-owned capture and draft lifecycle. Conversion/providers are registered by plugins. */
(() => {
  const microphone = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/></svg>';
  const types = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  const appleMobile = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const pcmAvailable = () => !!((globalThis.AudioContext || globalThis.webkitAudioContext) && globalThis.AudioWorkletNode);
  const canRetryStatus = error => error instanceof TypeError || error?.name === 'TimeoutError' ||
    [502, 503, 504].includes(error?.status);
  const copy = {
    voiceInput: ['语音输入', 'Voice input'],
    voiceDescription: ['录音转写后加入草稿', 'Record audio and add the transcript to your draft'],
    unsupported: ['此环境不支持录音，请使用 HTTPS 页面或桌面客户端', 'Recording requires an HTTPS page or the desktop app.'],
    stop: ['结束录音并转写', 'Stop recording and transcribe'],
    cancel: ['取消', 'Cancel'],
    settingsChanged: ['语音输入配置已变更，请重新录音', 'Voice input settings changed. Record again.'],
    waitingForInput: ['等待输入完成…', 'Waiting for you to finish typing…'],
    noSpeech: ['未识别到语音，草稿未修改', 'No speech was recognized. Your draft is unchanged.'],
    draftLimit: ['草稿已达到长度限制，未插入转写结果', 'The draft is at its length limit. The transcript was not added.'],
    added: ['已加入草稿 · 请确认后发送', 'Added to your draft. Review it before sending.'],
    transcribing: ['正在转写…', 'Transcribing…'],
    noAudio: ['未收到麦克风音频，请检查输入设备和麦克风权限', 'No microphone audio was received. Check the input device and microphone permission.'],
    noAudioSafari: ['未收到麦克风音频，请在 Safari 中打开页面检查麦克风权限', 'No microphone audio was received. Open the page in Safari and check microphone permission.'],
    emptyRecording: ['未取得录音数据，请重新录音；若仍失败，请重新打开页面', 'No recording data was captured. Record again. If it still fails, reopen the page.'],
    recordingTooLarge: ['录音超过大小限制，已取消，草稿未修改。请缩短录音后重试', 'The recording was too large and was cancelled. Your draft is unchanged. Try a shorter recording.'],
    readFailed: ['无法读取录音，请重新录音', 'The recording could not be read. Record again.'],
    transcriptionTimeout: ['转写超时，请稍后重试', 'Transcription timed out. Try again shortly.'],
    transcriptionCancelled: ['转写已取消，请重新录音', 'Transcription was cancelled. Record again.'],
    transcriptionFailed: ['转写失败，草稿未修改', 'Transcription failed. Your draft is unchanged.'],
    waitingForPermission: ['等待麦克风授权…', 'Waiting for microphone permission…'],
    startingMicrophone: ['正在启动麦克风…', 'Starting the microphone…'],
    formatUnsupported: ['此环境暂不支持所需的录音格式', 'The required recording format is unavailable.'],
    interrupted: ['录音中断，草稿未修改，请重新录音', 'Recording was interrupted. Your draft is unchanged. Record again.'],
    paused: ['录音已暂停，请重新录音', 'Recording paused. Record again.'],
    microphoneInterrupted: ['麦克风已中断，请重新录音', 'The microphone was disconnected. Record again.'],
    microphoneMuted: ['麦克风已暂停，请重新录音', 'The microphone was muted. Record again.'],
    recording: ['录音 {elapsed} / {limit} 秒', 'Recording {elapsed} / {limit} s'],
    permissionDenied: ['麦克风未获授权，请在系统或浏览器设置中允许', 'Microphone access was denied. Allow it in your system or browser settings.'],
    microphoneMissing: ['未找到麦克风，请检查输入设备', 'No microphone was found. Check your input device.'],
    microphoneUnavailable: ['无法使用麦克风，请检查输入设备或退出其他录音应用', 'The microphone is unavailable. Check the input device or close other recording apps.'],
    startFailed: ['无法开始录音，请重新录音', 'Recording could not start. Record again.'],
    assembling: ['正在整理录音…', 'Preparing the recording…'],
    stopTimeout: ['录音结束超时，请重新录音', 'The recording did not finish in time. Record again.'],
    cancelled: ['已取消 · 草稿保留', 'Cancelled. Your draft is unchanged.'],
    backgroundCancelled: ['录音或转写已取消 · 草稿保留', 'Recording or transcription was cancelled. Your draft is unchanged.'],
    microphoneClosed: ['录音已关闭，请重新录音', 'Recording was closed. Record again.'],
    microphoneTimeout: ['麦克风启动超时，请稍后重试', 'The microphone took too long to start. Try again shortly.'],
    recorderLoadFailed: ['无法加载录音组件，请刷新页面重试', 'The recorder could not load. Refresh the page and try again.'],
    recordingLimit: ['录音大小限制不足，请检查语音设置', 'The recording size limit is too low. Check your voice settings.'],
    loginExpired: ['登录已失效，请重新登录', 'Your login has expired. Sign in again.'],
    sharingUnavailable: ['共享权限已失效或语音输入未获授权，草稿未修改', 'Sharing permission expired or voice input is not authorized. Your draft is unchanged.'],
    recordingExpired: ['录音结果已过期，请重新录音', 'The recording result expired. Record again.'],
    transcriptionBusy: ['请等待当前转写完成后重试', 'Wait for the current transcription to finish, then try again.'],
    hunyuanAuth: ['腾讯混元认证失败，请检查 TokenHub API Key 及服务权限（不是 SecretId / SecretKey）', 'Tencent Hunyuan authentication failed. Check your TokenHub API key and access permissions.'],
    providerAuth: ['转写服务认证失败，请在电脑端检查 API Key', 'Transcription authentication failed. Check the API key on the host computer.'],
    providerFailure: ['转写服务请求失败，请稍后重新录音', 'The transcription service request failed. Try recording again shortly.'],
    providerEmpty: ['转写服务返回空结果', 'The transcription service returned an empty result.'],
    providerTooLarge: ['转写结果过大', 'The transcription result was too large.'],
    providerInvalid: ['转写服务返回的结果无效', 'The transcription service returned an invalid result.'],
    hunyuanIncomplete: ['腾讯混元未返回已完成的转写结果，请稍后重新录音', 'Tencent Hunyuan did not complete the transcription. Try recording again shortly.'],
    freeWav: ['免费转写需要 WAV 录音，请更新 asHub 或刷新远控网页', 'Free transcription requires WAV audio. Update asHub or refresh the remote page.'],
    freeNetwork: ['asHub 免费转写连接失败，请稍后重试', 'Could not connect to free asHub transcription. Try again shortly.'],
    freeQuota: ['asHub 免费转写已达使用限额，请稍后重试或切换到自定义转写', 'The free asHub transcription limit was reached. Try again later or switch to custom transcription.'],
    freeUnavailable: ['asHub 免费转写暂不可用，请稍后重试或切换到自定义转写', 'Free asHub transcription is unavailable. Try again later or switch to custom transcription.'],
  };
  const httpErrors = {401:'loginExpired',403:'sharingUnavailable',404:'recordingExpired',408:'transcriptionTimeout',409:'settingsChanged',413:'recordingTooLarge',429:'transcriptionBusy'};
  const knownError = key => typeof key === 'string' && Object.hasOwn(copy, key);
  const voiceError = code => Object.assign(Error(code), { code });
  const noAudio = () => appleMobile() ? 'noAudioSafari' : 'noAudio';
  const failure = (error, fallback) => knownError(error?.code) ? error.code : httpErrors[error?.status] || fallback;
  const microphoneFailure = error => ({
    NotAllowedError:'permissionDenied', PermissionDeniedError:'permissionDenied', SecurityError:'permissionDenied',
    NotFoundError:'microphoneMissing', DevicesNotFoundError:'microphoneMissing',
    NotReadableError:'microphoneUnavailable', TrackStartError:'microphoneUnavailable',
  })[error?.name] || failure(error, 'startFailed');
  function mount({ container, input, form, owner, request, enabled = () => !input.disabled }) {
    if (!container || !input || !form) return {refresh:async()=>{},cancel(){},dispose(){}};
    const root = document.createElement('span'); root.className = 'composer-media'; root.hidden = true;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'composer-media-button'; button.innerHTML = microphone;
    const cancelButton = document.createElement('button'); cancelButton.type = 'button'; cancelButton.className = 'composer-media-cancel'; cancelButton.hidden = true;
    const status = document.createElement('span'); status.className = 'composer-media-status'; status.setAttribute('role','status'); status.setAttribute('aria-live','polite');
    root.append(button,cancelButton); container.prepend(root); form.append(status);
    let descriptor, ticket = null, phase = 'idle', renderKey = '', revision = 0, composing = false, disposed = false, catalog = 0, knownOwner = owner();
    let statusKey = '', statusValues = {};
    const supports = () => !!((descriptor?.audioFormat === 'pcm-wav' ? pcmAvailable() : globalThis.MediaRecorder || pcmAvailable()) && navigator.mediaDevices?.getUserMedia && globalThis.isSecureContext);
    const current = t => !!t && ticket === t && !disposed && t.owner === owner() && !t.controller.signal.aborted;
    const english = () => /^en(?:-|$)/i.test(document.documentElement.lang);
    const local = (key, values = {}) => (copy[key]?.[english() ? 1 : 0] ?? '').replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
    const paintStatus = () => { const message = local(statusKey, statusValues); if (status.textContent !== message) status.textContent = message; };
    const label = (key, values = {}) => { statusKey = key; statusValues = values; paintStatus(); };
    function render() {
      const name = (english() ? descriptor?.labelEn : descriptor?.label) || local('voiceInput');
      const description = (english() ? descriptor?.descriptionEn : descriptor?.description) || local('voiceDescription');
      const supported = supports(), available = enabled();
      const nextKey=JSON.stringify([descriptor?.id,name,description,phase,supported,available,english()]);
      if(nextKey===renderKey)return;renderKey=nextKey;
      root.hidden = !descriptor;
      // A temporary history resync blocks new recordings, not finishing the current one.
      button.disabled = !supported || (phase === 'recording' ? !current(ticket) : phase !== 'idle' || !available);
      button.title = !supported ? local('unsupported') : phase === 'recording' ? local('stop') : description;
      button.setAttribute('aria-label', phase === 'recording' ? local('stop') : name);
      button.setAttribute('aria-pressed', String(phase === 'recording'));
      root.dataset.state = phase; status.setAttribute('aria-live',phase === 'recording' ? 'off' : 'polite'); cancelButton.hidden = phase === 'idle';
      cancelButton.textContent = local('cancel');
      paintStatus();
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
        if (ticket && (!next || next.id !== ticket.input.id || next.revision !== ticket.input.revision)) cancel('settingsChanged');
        descriptor = next || undefined; render();
      } catch { if (o === owner() && version === catalog && !ticket) { descriptor = undefined; render(); } }
    }
    function insert(t,text) {
      if (!current(t)) return;
      if (composing) { t.result = text; phase = 'inserting'; label('waitingForInput'); return; }
      if (!text.trim()) { cancel('noSpeech'); return; }
      const unchanged = revision === t.revision && input.value === t.text;
      const before = unchanged ? t.text.slice(0,t.start) : input.value;
      const after = unchanged ? t.text.slice(t.end) : '';
      const prefix = !unchanged && before && !/\s$/.test(before) ? '\n' : '';
      const value = before + prefix + text + after;
      if (value.length > (input.maxLength > 0 ? input.maxLength : 200000)) { cancel('draftLimit'); return; }
      input.value = value; input.setSelectionRange((before+prefix+text).length,(before+prefix+text).length);
      input.dispatchEvent(new Event('input',{bubbles:true}));
      ticket = null; t.controller.abort(); phase = 'idle'; label('added'); render();
      // No focus(): iPhone must not pop its keyboard or move the viewport after a late response.
    }
    async function convert(t) {
      if (!current(t)) return;
      stopTracks(t); phase = 'transcribing'; label('transcribing'); render();
      try {
        const blob = new Blob(t.chunks,{type:t.recorder.mimeType || t.mime}); t.chunks.length = 0;
        if (!blob.size) throw voiceError(t.pcm ? noAudio() : 'emptyRecording');
        if (blob.size > t.input.maxBytes) throw voiceError('recordingTooLarge');
        const data = await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result).split(',')[1]);r.onerror=()=>reject(voiceError('readFailed'));r.readAsDataURL(blob);});
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
          if(Date.now()>deadline) throw voiceError('transcriptionTimeout');
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
        if(result.state !== 'done' || typeof result.text !== 'string') {
          cancel(knownError(result.errorCode) ? result.errorCode : result.state === 'cancelled' ? 'transcriptionCancelled' : 'transcriptionFailed');
          return;
        }
        insert(t,result.text);
      } catch(e) { if(current(t)) cancel(failure(e, 'transcriptionFailed')); }
    }
    async function start() {
      if(!descriptor || !supports() || !owner() || !enabled() || disposed) return;
      const t = { owner:owner(), input:{...descriptor}, controller:new AbortController(), id:crypto.randomUUID(), text:input.value, revision, start:input.selectionStart,end:input.selectionEnd,chunks:[],size:0,ending:false,finishRequested:false,started:false };
      ticket=t; phase='permission'; label('waitingForPermission'); render();
      try {
        // Create/resume synchronously in the tap handler, before awaiting permission.
        t.pcm=pcmAvailable() && (t.input.audioFormat === 'pcm-wav' || appleMobile() || !globalThis.MediaRecorder);
        if(t.pcm){t.audioContext=new (globalThis.AudioContext || globalThis.webkitAudioContext)();t.audioReady=t.audioContext.resume();t.audioReady.catch(()=>{});}
        const stream = await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true},video:false});
        t.stream=stream;
        if(!current(t)) {stopTracks(t);return;}
        if(t.pcm){
          label('startingMicrophone');render();
          const {createPcmRecorder}=await import('./composer-pcm.js');
          if(!current(t)){stopTracks(t);return;}
          t.recorder=await createPcmRecorder(t.audioContext,stream,{signal:t.controller.signal,maxBytes:t.input.maxBytes,maxDuration:t.input.maxDuration});
          if(!current(t)){stopTracks(t);return;}
          t.mime='audio/wav';t.recorder.onlimit=()=>{if(current(t)&&phase==='recording')finish();};
        }else{
          t.mime=types.find(type=>MediaRecorder.isTypeSupported(type));
          if(!t.mime) throw voiceError('formatUnsupported');
          t.recorder=new MediaRecorder(stream,{mimeType:t.mime,audioBitsPerSecond:96000});
        }
        t.recorder.ondataavailable = event => { if(!current(t) || !event.data.size) return; t.size+=event.data.size;if(t.size>t.input.maxBytes)cancel('recordingTooLarge');else t.chunks.push(event.data); };
        t.recorder.onerror = ()=>{if(current(t))cancel('interrupted');};
        t.recorder.onpause = ()=>{if(current(t))cancel('paused');};
        // Stream/system stops are not user consent to upload a partial recording.
        t.recorder.onstop = ()=>{if(current(t)){if(t.finishRequested)void convert(t);else cancel('interrupted');}};
        stream.getTracks().forEach(track=>{track.onended=()=>{if(current(t)&&!t.ending)cancel('microphoneInterrupted');};track.onmute=()=>{if(current(t)&&!t.ending)cancel('microphoneMuted');};});
        // Short bounded recordings need one complete file, not live fragments.
        // Older iOS MP4 recorders can emit empty sub-second slices.
        t.recorder.start(); t.time=Date.now(); phase='recording';
        const tick=()=>{if(!current(t))return;const elapsed=Math.floor((Date.now()-t.time)/1000);if(t.pcm&&elapsed>=3&&!t.recorder.samples){cancel(noAudio());return;}label('recording',{elapsed:String(Math.min(elapsed,t.input.maxDuration)).padStart(2,'0'),limit:t.input.maxDuration});if(elapsed>=t.input.maxDuration)finish();};
        t.clock=setInterval(tick,250);tick();render();
      } catch(e) { if(current(t)) cancel(microphoneFailure(e));else stopTracks(t); }
    }
    function finish() {
      const t=ticket;if(!current(t)||phase!=='recording')return;
      t.finishRequested=true;t.ending=true;clearInterval(t.clock);phase='transcribing';label('assembling');render();
      // stop() finishes asynchronously. Keep the source alive until the final
      // dataavailable + stop events; cancel/background still release it immediately.
      t.stopTimer=setTimeout(()=>{if(current(t))cancel('stopTimeout');},10000);
      try{t.recorder.stop();}catch{cancel('interrupted');}
    }
    button.onclick=()=>{if(phase==='recording')finish();else if(phase==='idle')void start();};
    cancelButton.onclick=()=>cancel('cancelled');
    const edit=()=>{revision++;}; const compositionStart=()=>{composing=true;};const compositionEnd=()=>{composing=false;if(ticket?.result!==undefined)insert(ticket,ticket.result);};
    const submit=()=>cancel();const key=e=>{if(e.key==='Escape'&&ticket){e.preventDefault();cancel('cancelled');}};
    const hide=()=>{if(document.hidden)cancel(ticket?'backgroundCancelled':'');};const leave=()=>cancel();const focus=()=>void refresh();
    input.addEventListener('input',edit);input.addEventListener('compositionstart',compositionStart);input.addEventListener('compositionend',compositionEnd);
    form.addEventListener('submit',submit,true);root.addEventListener('keydown',key);document.addEventListener('visibilitychange',hide);document.addEventListener('langchange',render);window.addEventListener('pagehide',leave);window.addEventListener('focus',focus);
    let ticks=0, wasEnabled=!!enabled();const clock=setInterval(()=>{const available=!!enabled(), becameEnabled=available&&!wasEnabled;wasEnabled=available;if(owner()!==knownOwner){void refresh();}else if(becameEnabled || (++ticks%60===0&&!document.hidden))void refresh();render();},250);
    void refresh();
    return {refresh,cancel,dispose(){cancel();disposed=true;clearInterval(clock);root.remove();status.remove();input.removeEventListener('input',edit);input.removeEventListener('compositionstart',compositionStart);input.removeEventListener('compositionend',compositionEnd);form.removeEventListener('submit',submit,true);root.removeEventListener('keydown',key);document.removeEventListener('visibilitychange',hide);document.removeEventListener('langchange',render);window.removeEventListener('pagehide',leave);window.removeEventListener('focus',focus);}};
  }
  globalThis.AsHubComposerMedia = { mount };
})();

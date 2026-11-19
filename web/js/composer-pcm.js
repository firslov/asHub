// Generic short-recording adapter; providers continue receiving ordinary audio bytes.
export function wavBlob(chunks, samples) {
  if(!samples)return new Blob([],{type:'audio/wav'});
  const header=new ArrayBuffer(44),view=new DataView(header);
  const ascii=(offset,text)=>{for(let i=0;i<text.length;i++)view.setUint8(offset+i,text.charCodeAt(i));};
  ascii(0,'RIFF');view.setUint32(4,36+samples*2,true);ascii(8,'WAVE');ascii(12,'fmt ');
  view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);
  view.setUint32(24,16000,true);view.setUint32(28,32000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);
  ascii(36,'data');view.setUint32(40,samples*2,true);
  return new Blob([header,...chunks],{type:'audio/wav'});
}
function waitFor(promise,signal,timeout,message) {
  return new Promise((resolve,reject)=>{
    let timer;const done=(error)=>{clearTimeout(timer);signal.removeEventListener('abort',abort);error?reject(error):resolve();};
    const abort=()=>done(signal.reason || new DOMException('Aborted','AbortError'));
    timer=setTimeout(()=>done(Error(message)),timeout);signal.addEventListener('abort',abort,{once:true});
    if(signal.aborted)abort();Promise.resolve(promise).then(()=>done(),done);
  });
}
export function waitForAudioRunning(context,signal) {
  return new Promise((resolve,reject)=>{
    let settled=false;
    const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);context.removeEventListener('statechange',check);signal.removeEventListener('abort',abort);error?reject(error):resolve();};
    const check=()=>{if(context.state==='running')finish();else if(context.state==='closed')finish(Error('录音已关闭'));};
    const abort=()=>finish(signal.reason || new DOMException('Aborted','AbortError'));
    const timer=setTimeout(()=>finish(Error('麦克风启动超时，请稍后重试')),10000);
    context.addEventListener('statechange',check);signal.addEventListener('abort',abort,{once:true});
    if(signal.aborted){abort();return;}
    check();if(settled)return;
    // Permission can change iOS's audio route. Observe actual readiness rather
    // than failing at 3s or relying solely on a delayed resume promise.
    try{Promise.resolve(context.resume()).then(check,error=>{if(context.state==='running')finish();else finish(error);});}catch(error){finish(error);}
  });
}
export async function createPcmRecorder(context,stream,{signal,maxBytes,maxDuration}) {
  const maxSamples=Math.min(Math.floor((maxBytes-44)/2),Math.floor(maxDuration*16000));
  if(maxSamples<=0)throw Error('录音大小限制不足');
  signal.throwIfAborted();
  await waitFor(context.audioWorklet.addModule(new URL('./composer-pcm-worklet.js',import.meta.url)),signal,5000,'无法加载录音组件，请刷新页面重试');
  signal.throwIfAborted();
  let source,node,chunks=[],samples=0,closed=false;
  const recorder={state:'inactive',mimeType:'audio/wav',get samples(){return samples;},
    start(){signal.throwIfAborted();if(closed)throw Error('录音已关闭');this.state='recording';node.port.postMessage('start');},
    stop(){if(closed||this.state==='inactive')return;this.state='inactive';node.port.postMessage('stop');},
  };
  function dispose(){
    if(closed)return;closed=true;chunks=[];recorder.state='inactive';
    if(node){node.port.onmessage=null;node.onprocessorerror=null;node.port.close();node.disconnect();}
    source?.disconnect();signal.removeEventListener('abort',dispose);
  }
  try {
    node=new AudioWorkletNode(context,'ashub-composer-pcm',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1],processorOptions:{maxSamples}});
    source=context.createMediaStreamSource(stream);
    node.onprocessorerror=()=>{if(!closed){dispose();recorder.onerror?.();}};
    node.port.onmessage=event=>{
      if(closed||signal.aborted)return;
      const data=event.data;
      if(data.type==='data'){
        if(!(data.buffer instanceof ArrayBuffer)||data.buffer.byteLength%2||samples+data.buffer.byteLength/2>maxSamples){dispose();recorder.onerror?.();return;}
        samples+=data.buffer.byteLength/2;chunks.push(data.buffer);
      }else if(data.type==='limit'){
        recorder.onlimit?.();
      }else if(data.type==='stop'){
        const blob=wavBlob(chunks,samples);dispose();
        recorder.ondataavailable?.({data:blob});recorder.onstop?.();
      }
    };
    signal.addEventListener('abort',dispose,{once:true});
    source.connect(node);node.connect(context.destination);
    await waitForAudioRunning(context,signal);
    signal.throwIfAborted();
    return recorder;
  }catch(error){dispose();throw error;}
}

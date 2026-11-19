(() => {
  globalThis.mediaFixture = {NativeRecorder:globalThis.MediaRecorder,tracks:[],recorders:[],permission:'allow',mime:'audio/mp4',requireLiveTrackAtFlush:false,emptySlices:false,emptyRecording:false,holdFlush:false};
  const f=mediaFixture;
  Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async constraints=>{
    if(constraints.video!==false)throw Error('Video requested');
    if(f.permission==='hold')await new Promise(r=>f.grant=r);
    if(f.permission==='deny')throw new DOMException('Denied','NotAllowedError');
    const track={stopped:false,stop(){this.stopped=true;}};f.tracks.push(track);return {getTracks:()=>[track]};
  }}});
  globalThis.MediaRecorder=class {
    static isTypeSupported(type){return type===f.mime;}
    constructor(stream,options){this.state='inactive';this.mimeType=options.mimeType;this.stream=stream;f.recorders.push(this);}
    start(timeslice){this.timeslice=timeslice;this.state='recording';}
    stop(){if(this.state==='inactive')return;this.state='inactive';const flush=()=>{const empty=f.emptyRecording||(f.emptySlices&&this.timeslice!==undefined)||(f.requireLiveTrackAtFlush&&this.stream.getTracks().some(t=>t.stopped));this.ondataavailable?.({data:new Blob(empty?[]:['fixture-audio'],{type:this.mimeType})});this.onstop?.();};if(f.holdFlush)this.flush=flush;else queueMicrotask(flush);}
  };
})();

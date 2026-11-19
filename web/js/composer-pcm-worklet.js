// Local microphone samples only. No network, playback or persistent storage.
class ComposerPcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const limit=options.processorOptions?.maxSamples;
    this.limit=Number.isInteger(limit)&&limit>0?Math.min(limit,960000):960000;
    this.ratio=sampleRate/16000;this.filled=0;this.sum=0;this.count=0;this.used=0;this.active=false;
    this.buffer=new Int16Array(2048);
    this.port.onmessage=event=>{
      if(event.data==='start')this.active=true;
      if(event.data==='stop'){this.active=false;this.flush();this.port.postMessage({type:'stop'});}
    };
  }
  flush() {
    if(!this.used)return;
    const data=this.buffer.slice(0,this.used);this.used=0;
    this.port.postMessage({type:'data',buffer:data.buffer},[data.buffer]);
  }
  process(inputs) {
    if(!this.active)return true;
    const channels=inputs[0];if(!channels?.length||!channels[0]?.length)return true;
    for(let i=0;i<channels[0].length;i++){
      let value=0;for(const channel of channels)value+=channel[i]||0;value/=channels.length;
      let remaining=1;
      while(remaining>1e-8){
        const weight=Math.min(remaining,this.ratio-this.filled);this.sum+=value*weight;this.filled+=weight;remaining-=weight;
        if(this.filled+1e-8>=this.ratio){
          const sample=Math.max(-1,Math.min(1,this.sum/this.ratio));this.sum=0;this.filled=0;
          this.buffer[this.used++]=Math.round(sample*(sample<0?32768:32767));this.count++;
          if(this.used===this.buffer.length)this.flush();
          if(this.count>=this.limit){this.active=false;this.flush();this.port.postMessage({type:'limit'});return true;}
        }
      }
    }
    // Outputs stay zero, so the microphone is never played through the speaker.
    return true;
  }
}
registerProcessor('ashub-composer-pcm',ComposerPcmCapture);

import { DevicePublisher } from './publisher.mjs';
export class DeviceSharing {
  constructor(ctx) {
    this.service=ctx.services.sharedConversations;
    const secrets=ctx.services.backends.secrets;
    this.publisher=new DevicePublisher({dataDir:ctx.services.dataDirectory,
      store:secrets.available?{read:()=>secrets.read('device'),write:v=>secrets.write('device',v)}:undefined,
      access:id=>this.service.open(id)});
    // Scoped host channel owns localhost addressing; plugins never receive its token.
    this.publisher.start();
    this.service.registerStatus(()=>this.publisher.status());
    ctx.signal.addEventListener('abort',()=>this.publisher.close(),{once:true});
  }
  status(){return this.publisher.status();}
  async configure(values,grantId){
    const result=await this.publisher.configure(values,grantId);
    // The new identity is already committed. Failure to prune an unused old
    // grant must not roll back the active grant or disconnect existing clients.
    if(result.oldGrant && result.oldGrant!==grantId)try{this.service.revoke(result.oldGrant);}catch{}
    if(result.recovery)this.recovery=result.recovery;
  }
  disable(){this.publisher.disable();}
  async close(){this.publisher.close();await this.publisher.drain();this.publisher.access?.close();}
  busy(){return this.publisher.isBusy();}
}

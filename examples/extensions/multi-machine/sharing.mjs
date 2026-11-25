import fs from 'node:fs';
import path from 'node:path';
import { DevicePublisher } from './publisher.mjs';
export class DeviceSharing {
  constructor(ctx, resource) {
    this.service=ctx.services.sharedConversations;
    const secrets=ctx.services.backends.secrets;
    this.publisher=new DevicePublisher({dataDir:ctx.services.dataDirectory,
      store:secrets.available?{read:()=>secrets.read('device'),write:v=>secrets.write('device',v)}:undefined,
      access:id=>this.service.open(id)});
    // Scoped host channel owns localhost addressing; plugins never receive its token.
    this.publisher.start();
    this.service.registerStatus(()=>this.publisher.status(),resource);
    ctx.signal.addEventListener('abort',()=>this.publisher.close(),{once:true});
  }
  status(){return this.publisher.status();}
  async configure(values,grantId){
    const previousUser=this.status().username;
    const result=await this.publisher.configure(values,grantId);
    // The new identity is already committed. Failure to prune an unused old
    // grant must not roll back the active grant or disconnect existing clients.
    if(result.oldGrant && result.oldGrant!==grantId)try{this.service.revoke(result.oldGrant);}catch{}
    if(result.recovery || previousUser!==this.status().username)this.recovery=result.recovery || '';
  }
  directoryChange(values){
    if(!Array.isArray(values) || !values.length || values.length>20)throw Error('请选择 1–20 个共享目录');
    const canonical=value=>{if(typeof value!=='string' || !path.isAbsolute(value))throw Error('共享目录必须使用绝对路径');const real=fs.realpathSync(value);if(!fs.statSync(real).isDirectory())throw Error('共享目录不可用');return real;};
    // Preview exactly the canonical paths submitted to the host. The host still
    // validates them independently at prepare and confirmation time.
    const roots=[...new Set(values.map(canonical))];
    const previous=[...new Set(this.status().roots.map(value=>{try{return canonical(value);}catch{return value;}}))];
    return {roots,added:roots.filter(p=>!previous.includes(p)),removed:previous.filter(p=>!roots.includes(p))};
  }
  revision(){return this.publisher.config;}
  async updateRoots(grantId,expected){
    const result=this.publisher.updateRoots(grantId,expected);
    if(result.oldGrant && result.oldGrant!==grantId)try{this.service.revoke(result.oldGrant);}catch{}
  }
  disable(){this.publisher.disable();}
  async close(){this.publisher.close();await this.publisher.drain();this.publisher.access?.close();}
  busy(){return this.publisher.isBusy();}
}

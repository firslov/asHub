/** One-time compatibility bridge. New accounts, enrollment and networking live
 * in the optional plugin; this module only moves existing local authorization. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { RemoteSecretStore } from './connector.js';
import type { PluginSecretStore } from '../extensions/backends.js';
import type { SharedConversations } from '../extensions/shared-conversations.js';
import { pluginCatalog, readPluginSettings, BUNDLED_ENABLED } from '../plugins.js';
import { pluginDataDirectory } from '../extensions/data-directory.js';
import { updateSettingsFile } from '../settings-store.js';
export function migrateDeviceInterconnect(opts: {settingsFile:string;sessionsDir:string;legacy?:RemoteSecretStore;secrets?:PluginSecretStore;sharing:SharedConversations}) {
  const marker=path.join(opts.sessionsDir,'device-interconnect-migrated.json');
  if(fs.existsSync(marker)||!opts.legacy)return;
  const saved=opts.legacy.read();if(!saved)return;
  if(!opts.secrets)throw Error('Cannot migrate device identity without encrypted plugin storage');
  const legacy=JSON.parse(saved);
  if(!legacy || typeof legacy.deviceId!=='string' || typeof legacy.deviceToken!=='string' || typeof legacy.username!=='string' || !Array.isArray(legacy.roots) || !legacy.roots.length)throw Error('Invalid existing device identity');
  const entry=pluginCatalog(opts.settingsFile).find(p=>p.manifest?.id==='ashub-multi-machine' && p.manifest.requires.capabilities.includes('shared-conversations'));
  if(!entry)throw Error('Update the device interconnect plugin before migrating mobile access');
  const key=createHash('sha256').update(entry.id+'\0device').digest('hex');
  const current=opts.secrets.read(key);
  const prior=current?JSON.parse(current):null;
  const settings=readPluginSettings(opts.settingsFile);
  const enabled=legacy.enabled!==false && !(settings['ashub.features.disabled']||[]).includes('mobile-access');
  const targetDir=pluginDataDirectory(opts.settingsFile,entry.id);
  fs.mkdirSync(targetDir,{recursive:true,mode:0o700});
  // Preserve exactly-once receipts before publishing the migrated identity.
  const source=path.join(opts.sessionsDir,'remote','remote-requests.json'), target=path.join(targetDir,'remote-requests.json');
  if(fs.existsSync(source)) {
    const readReceipts=(file:string)=>{
      const value=JSON.parse(fs.readFileSync(file,'utf8'));
      if(!value || typeof value!=='object' || Array.isArray(value) || Object.values(value).some((r:any)=>!r || typeof r.digest!=='string' || !['pending','unknown','done'].includes(r.state)))throw Error('Invalid device receipts');
      return value as Record<string,{digest:string;state:string}>;
    };
    const incoming=readReceipts(source), merged=fs.existsSync(target)?readReceipts(target):{};
    const rank:Record<string,number>={pending:0,unknown:1,done:2};
    for(const [id,receipt] of Object.entries(incoming)){
      const old=merged[id];
      if(!receipt || typeof receipt.digest!=='string' || !(receipt.state in rank))throw Error('Invalid legacy receipt');
      if(old && old.digest!==receipt.digest)throw Error('Conflicting device receipt');
      if(!old || rank[receipt.state]!>rank[old.state]!)merged[id]=receipt;
    }
    // A previous failed migration may have run the compatibility publisher.
    // Merge its new receipts on retry, even if credentials were already copied.
    fs.writeFileSync(target+'.migrate',JSON.stringify(merged),{mode:0o600,flush:true});fs.renameSync(target+'.migrate',target);
  }
  // Until the completion marker is durable, only the compatibility publisher
  // is admitted. Its latest identity/switch/scope is authoritative on retry.
  // Mark copied credentials so a separately configured new plugin is not reset.
  if(!prior || prior.legacyMigrationPending===true) {
    const service=opts.sharing.bind(entry.id,new AbortController().signal);
    const oldGrant=typeof prior?.grantId==='string'?prior.grantId:undefined;
    const reusable=oldGrant && JSON.stringify(service.scope(oldGrant))===JSON.stringify(legacy.roots);
    const grantId=reusable?oldGrant:opts.sharing.importGrant(entry.id,legacy.roots);
    try {opts.secrets.write(key,JSON.stringify({...legacy,enabled,grantId,legacyMigrationPending:true}));}
    catch(e){if(grantId!==oldGrant)opts.sharing.revoke(entry.id,grantId);throw e;}
    if(oldGrant && oldGrant!==grantId)opts.sharing.revoke(entry.id,oldGrant);
  }
  // Never enable a previously disabled plugin. The legacy mobile switch only
  // initializes the new bundled plugin, not an explicitly disabled installation.
  if(enabled && entry.bundled && (!prior || prior.legacyMigrationPending===true)) updateSettingsFile(opts.settingsFile, settings=>{
    settings[BUNDLED_ENABLED]=[...new Set([...(settings[BUNDLED_ENABLED]||[]),entry.id])];return settings;
  });
  fs.mkdirSync(opts.sessionsDir,{recursive:true});
  fs.writeFileSync(marker+'.tmp',JSON.stringify({version:1,pluginId:entry.id}),{mode:0o600,flush:true});fs.renameSync(marker+'.tmp',marker);
}

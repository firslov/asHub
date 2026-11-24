import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const args=process.argv.slice(2);
if(args.length&&(args.length!==2||args[0]!=='--home'))throw Error('Usage: node scripts/uninstall.mjs [--home <agent-sh home>]');
const home=path.resolve(args[1]||process.env.AGENT_SH_HOME||path.join(os.homedir(),'.agent-sh'));
const target=path.join(home,'extensions','ashub-desktop-control');
if(fs.existsSync(target)){
 if(!fs.existsSync(path.join(target,'.ashub-desktop-control')))throw Error('Directory is not owned by this installer; nothing was changed.');
 fs.rmSync(target,{recursive:true});
}
console.log('Plugin removed. Restart asHub to unload active conversations. Settings and downloaded runtime were preserved.');

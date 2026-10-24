// Include Windows ripgrep binaries when packaging on any host, without Bash.
const fs=require('node:fs'), path=require('node:path'), os=require('node:os');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'ashub-win-pack-'));
try {
 for(const name of ['@vscode/ripgrep-win32-x64','@vscode/ripgrep-win32-arm64']) {
  const dest=path.join(root,'node_modules',name);
  if(fs.existsSync(path.join(dest,'bin','rg.exe')))continue;
  const spec=name+'@'+pkg.optionalDependencies[name];
  const npm=process.env.npm_execpath;
  const args=['pack',spec,'--json','--ignore-scripts'];
  const output=npm?execFileSync(process.execPath,[npm,...args],{cwd:temp,encoding:'utf8'}):execFileSync(process.platform==='win32'?'npm.cmd':'npm',args,{cwd:temp,encoding:'utf8',shell:process.platform==='win32'});
  const archive=JSON.parse(output)[0].filename;
  if(archive!==path.basename(archive))throw Error('Invalid npm archive name');
  const extract=fs.mkdtempSync(path.join(temp,'extract-'));
  execFileSync('tar',['-xzf',path.join(temp,archive),'-C',extract]);
  if(!fs.existsSync(path.join(extract,'package','bin','rg.exe')))throw Error('Missing Windows ripgrep binary');
  fs.mkdirSync(dest,{recursive:true});fs.cpSync(path.join(extract,'package'),dest,{recursive:true});
  console.log('[pre-dist-win] '+spec+' ready');
 }
} finally {fs.rmSync(temp,{recursive:true,force:true});}

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const root=fileURLToPath(new URL('..',import.meta.url)),native=path.join(root,'native');
if(process.platform!=='darwin')throw Error('Build the macOS capture helper on macOS; release archives already contain it.');
const outputs=[];
try {
 for(const arch of ['arm64','x86_64']){
  const output=path.join(native,'capture-'+arch);outputs.push(output);
  execFileSync('/usr/bin/xcrun',['swiftc','-parse-as-library','-O','-target',arch+'-apple-macosx14.0','-module-cache-path',path.join(os.tmpdir(),'ashub-capture-swift-cache'),path.join(native,'capture.swift'),'-o',output],{stdio:'inherit'});
 }
 execFileSync('/usr/bin/lipo',['-create',...outputs,'-output',path.join(native,'capture')],{stdio:'inherit'});
 execFileSync('/usr/bin/codesign',['--force','--sign','-',path.join(native,'capture')],{stdio:'inherit'});
 fs.chmodSync(path.join(native,'capture'),0o755);
} finally {for(const file of outputs)fs.rmSync(file,{force:true});}

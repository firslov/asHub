import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ImageResources, inspectImage, IMAGE_LIMIT } from '../dist/image-resources.js';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ZkAAAAASUVORK5CYII=','base64');
async function fixture(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ashub-image-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const cwd=path.join(dir,'project');await fs.mkdir(cwd);await fs.writeFile(path.join(cwd,'图片.png'),png);const store=new ImageResources(path.join(dir,'store'));return{dir,cwd,store};}
test('snapshots survive source edits and restart; references remain scoped to their conversation',async t=>{
 const {dir,cwd,store}=await fixture(t);const published=await store.bind('abcdef',()=>cwd).publish('图片.png');
 assert.match(published.ref,/^ashub-image:[a-f0-9]{64}\/1x1$/);assert.equal(published.name,'image.png');
 assert.deepEqual(await store.bind('abcdef',()=>cwd).publish('图片.png'),published);
 await fs.unlink(path.join(cwd,'图片.png'));const restarted=new ImageResources(path.join(dir,'store'));
 assert.deepEqual(Buffer.from((await restarted.read('abcdef',published.id)).data,'base64'),png);
 await assert.rejects(restarted.read('bbbbbb',published.id));
 await assert.rejects(restarted.read('abcdef','../secret'));
 await assert.rejects(restarted.read('abcdef',published.id,-1));
 await store.remove('abcdef');await assert.rejects(restarted.metadata('abcdef',published.id));
});
test('publishing rejects path escape, symlinks outside workspace, active formats, oversized and cancelled reads',async t=>{
 const {dir,cwd,store}=await fixture(t),service=store.bind('abcdef',()=>cwd);
 await fs.writeFile(path.join(dir,'secret.png'),png);
 for(const file of ['../secret.png',path.join(dir,'secret.png')])await assert.rejects(service.publish(file),{status:403});
 if(process.platform!=='win32'){await fs.symlink(path.join(dir,'secret.png'),path.join(cwd,'link.png'));await assert.rejects(service.publish('link.png'),{status:403});}
 await fs.writeFile(path.join(cwd,'unsafe.svg'),'<svg onload="alert(1)"/>');await assert.rejects(service.publish('unsafe.svg'),{status:415});
 await fs.writeFile(path.join(cwd,'large.png'),Buffer.alloc(IMAGE_LIMIT+1));await assert.rejects(service.publish('large.png'),{status:413});
 await assert.rejects(service.publish('图片.png',AbortSignal.abort()));
 let count=0;await assert.rejects(store.bind('aaaaaa',()=>++count<3?cwd:dir).publish('图片.png'),{status:409});
});
test('format validation rejects animation, oversized dimensions and truncated containers',()=>{
 assert.deepEqual(inspectImage(png),{mimeType:'image/png',width:1,height:1});
 const huge=Buffer.from(png);huge.writeUInt32BE(20000,16);assert.throws(()=>inspectImage(huge));
 const animated=Buffer.from(png);animated.write('acTL',37);assert.throws(()=>inspectImage(animated),/Animated/);
 for(const bytes of [Buffer.from('<html/>'),png.subarray(0,-1),Buffer.alloc(0)])assert.throws(()=>inspectImage(bytes));
});
test('concurrent publishing deduplicates and deletion serializes after in-flight publication',async t=>{
 const {cwd,store}=await fixture(t);const service=store.bind('abcdef',()=>cwd);
 const [a,b]=await Promise.all([service.publish('图片.png'),service.publish('图片.png')]);assert.equal(a.id,b.id);
 const pending=service.publish('图片.png');const deleted=store.remove('abcdef');await pending;await deleted;await assert.rejects(store.metadata('abcdef',a.id));
});

test('small lossless WebP accepts valid container and rejects trailing or animated chunks',()=>{
 const b=Buffer.alloc(26);b.write('RIFF');b.writeUInt32LE(18,4);b.write('WEBPVP8L',8);b.writeUInt32LE(5,16);b[20]=0x2f;
 assert.deepEqual(inspectImage(b),{mimeType:'image/webp',width:1,height:1});
 const trailing=Buffer.concat([b,Buffer.alloc(2)]);trailing.writeUInt32LE(trailing.length-8,4);assert.throws(()=>inspectImage(trailing));
 const animated=Buffer.concat([b,Buffer.alloc(8)]);animated.write('ANIM',26);animated.writeUInt32LE(animated.length-8,4);assert.throws(()=>inspectImage(animated),/Animated/);
});

test('quota rejection does not commit a partial snapshot and deduplication observes late cancellation',async t=>{
 const {dir,cwd,store}=await fixture(t);const service=store.bind('abcdef',()=>cwd);const published=await service.publish('图片.png');
 const controller=new AbortController(),original=store.metadata.bind(store);store.metadata=async(...args)=>{const result=await original(...args);controller.abort();return result;};
 await assert.rejects(service.publish('图片.png',controller.signal));store.metadata=original;
 const full=path.join(dir,'store','bbbbbb');await fs.mkdir(full,{recursive:true});await Promise.all(Array.from({length:200},(_,i)=>fs.writeFile(path.join(full,i.toString(16).padStart(64,'0')),'')));
 await assert.rejects(store.bind('bbbbbb',()=>cwd).publish('图片.png'),{status:413});await assert.rejects(store.metadata('bbbbbb',published.id));
});

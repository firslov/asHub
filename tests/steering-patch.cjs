const test=require('node:test'), assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {apply}=require('../scripts/patch-steering.cjs'),patch=require('../scripts/patches/steering-ids.json');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'steering-patch-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));for(const f of patch.files){const file=path.join(root,f.path);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,f.hunks.map(h=>h.before).join('\n// gap\n'));}return root;}
test('steering patch updates runtime, source and event types idempotently',t=>{const root=fixture(t);assert.equal(apply(root),4);assert.equal(apply(root),0);for(const f of patch.files)for(const h of f.hunks)assert(fs.readFileSync(path.join(root,f.path),'utf8').includes(h.after));});
test('unknown upstream steering fails validation before modifying any file',t=>{const root=fixture(t),first=path.join(root,patch.files[0].path),original=fs.readFileSync(first,'utf8');fs.writeFileSync(path.join(root,patch.files.at(-1).path),'unknown');assert.throws(()=>apply(root),/review the kernel update/);assert.equal(fs.readFileSync(first,'utf8'),original);});

test('steering patch upgrades the previous identity patch without losing idempotency',t=>{
 const root=fixture(t);
 for(const f of patch.files){const file=path.join(root,f.path);fs.writeFileSync(file,f.hunks.map(h=>h.previous||h.after).join('\n// gap\n'));}
 assert.equal(apply(root),2);assert.equal(apply(root),0);
});

const crc32 = data => { let crc = -1; for (const byte of data) { crc ^= byte; for (let i=0;i<8;i++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ -1) >>> 0; };
function zip(files) {
 const locals=[],centrals=[];let offset=0;
 for(const [name,raw] of Object.entries(files)) {
  const value=typeof raw==='string'?{data:raw}:raw,data=Buffer.from(value.data||''),n=Buffer.from(name),crc=crc32(data);
  const h=Buffer.alloc(30);h.writeUInt32LE(0x04034b50);h.writeUInt16LE(20,4);h.writeUInt16LE(0x800,6);h.writeUInt32LE(crc,14);h.writeUInt32LE(data.length,18);h.writeUInt32LE(value.size??data.length,22);h.writeUInt16LE(n.length,26);
  const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(0x314,4);c.writeUInt16LE(20,6);c.writeUInt16LE(0x800,8);c.writeUInt32LE(crc,16);c.writeUInt32LE(data.length,20);c.writeUInt32LE(value.size??data.length,24);c.writeUInt16LE(n.length,28);c.writeUInt32LE(((value.mode??0o100644)<<16)>>>0,38);c.writeUInt32LE(offset,42);
  locals.push(h,n,data);centrals.push(c,n);offset+=h.length+n.length+data.length;
 }
 const cd=Buffer.concat(centrals),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(Object.keys(files).length,8);end.writeUInt16LE(Object.keys(files).length,10);end.writeUInt32LE(cd.length,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...locals,cd,end]);
}
function plugin(extra={},manifest={schemaVersion:1,id:'sample-plugin',name:'Sample'}) {
 return {'release/package.json':JSON.stringify({name:'sample-plugin',version:'1.0.0',type:'module',main:'index.mjs'}),'release/index.mjs':'export default function activate() {}',...(manifest?{'release/ashub-plugin.json':JSON.stringify(manifest)}:{}),...extra};
}
module.exports={zip,plugin};

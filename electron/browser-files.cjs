const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const MAX_TEXT = 256 * 1024;
const MAX_FILE = 32 * 1024 * 1024;
const MAX_DOWNLOAD = 64 * 1024 * 1024;
const hash = (data) => createHash('sha256').update(data).digest('hex');
function workspace(cwd) {
  if (!cwd || !path.isAbsolute(cwd)) throw Error('This conversation has no local working directory.');
  return fs.realpathSync(cwd);
}
function readSource(cwd, name, text = false) {
  if (typeof name !== 'string' || !name || name.length > 4096) throw Error('Invalid source file path.');
  const root = workspace(cwd);
  const file = fs.realpathSync(path.resolve(root, name));
  const rel = path.relative(root, file);
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel))
    throw Error('Source file must be inside this conversation’s working directory.');
  // Opening a FIFO read-only can block the Electron main process before fstat.
  if (!fs.lstatSync(file).isFile()) throw Error('Source must be a regular file.');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  let bytes;
  try {
    const stat = fs.fstatSync(fd), max = text ? MAX_TEXT : MAX_FILE;
    if (!stat.isFile() || stat.size > max) throw Error(`Source must be a regular file of at most ${max} bytes.`);
    // Bound the read even if a writer grows the file after fstat.
    const buffer = Buffer.alloc(max + 1);
    let size = 0, count;
    do { count = fs.readSync(fd, buffer, size, buffer.length - size, null); size += count; }
    while (count && size < buffer.length);
    if (size > max) throw Error('Source file exceeds the size limit.');
    bytes = buffer.subarray(0, size);
  } finally { fs.closeSync(fd); }
  const result = { file, bytes, sha256: hash(bytes) };
  if (text) {
    result.text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (result.text.includes('\0')) throw Error('Expected a UTF-8 text file.');
  }
  return result;
}
function stageUpload(source) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-browser-upload-'));
  const file = path.join(directory, path.basename(source.file));
  try { fs.writeFileSync(file, source.bytes, { mode: 0o600, flag: 'wx' }); }
  catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
  return { file, dispose: () => fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}
// A click grants bounded receipt only. The actual file needs separate manual consent:
// generic page JavaScript does not expose a reliable click-to-download association.
function downloadGrant({ page, cwd, signal, confirmReceived = async () => false, timeoutMs = 120000 }) {
  if (page.downloadNeedsReset) throw Error('The previous download may still produce additional files. Reopen this browser page before downloading again.');
  const root = workspace(cwd), rootIdentity = fs.statSync(root);
  let item, directory, file, publishDirectory, publishedFile, timer, settled = false, receiving = false, resolve;
  const confirmation = new AbortController();
  const confirmationSignal = AbortSignal.any([signal, confirmation.signal]);
  const promise = new Promise(r => { resolve = r; });
  const remove = dir => dir ? fs.promises.rm(dir, {recursive:true,force:true,maxRetries:5,retryDelay:100}) : Promise.resolve();
  const detach = () => {
    clearTimeout(timer); signal.removeEventListener('abort', abort);
    if (page.download === grant) page.download = null;
  };
  const fail = (message, uncertain = true) => {
    if (settled) return;
    settled = true;
    if (uncertain || item) page.downloadNeedsReset = true;
    detach(); confirmation.abort();
    if (item) { try { item.cancel(); } catch {} }
    const cleanup = [{ directory, file }, { directory: publishDirectory, file: publishedFile }];
    void Promise.allSettled(cleanup.map(entry => remove(entry.directory))).then(results => {
      const remaining = cleanup.filter((_entry, index) => results[index].status === 'rejected').map(entry => entry.file || entry.directory);
      resolve({status:'unverified',
        message:remaining.length ? message+' Partial file cleanup failed; remove the reported files manually.' : message,
        ...(remaining.length ? {partialPath:remaining[0],partialPaths:remaining} : {}),
        reopenRequired:page.downloadNeedsReset === true});
    });
  };
  const finish = async () => {
    if (settled || receiving) return;
    receiving = true;
    page.downloadNeedsReset = true;
    clearTimeout(timer);
    timer = setTimeout(() => fail('Actual file confirmation timed out; no file was approved.'), timeoutMs);
    try {
      // Retain the reviewed bytes, not a pathname that could change during consent.
      // Refuse links and avoid blocking if a local process replaces the receipt
      // with a FIFO between inspection and open. Bound growth after fstat too.
      const before = fs.lstatSync(file);
      if (!before.isFile()) throw Error('Download is not a regular file.');
      const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
      let bytes;
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev || stat.size > MAX_DOWNLOAD)
          throw Error('Download changed, exceeded 64 MiB or is not a regular file.');
        fs.fchmodSync(fd, 0o600);
        const chunks = []; let size = 0;
        while (size <= MAX_DOWNLOAD) {
          const buffer = Buffer.alloc(Math.min(64 * 1024, MAX_DOWNLOAD + 1 - size));
          const count = fs.readSync(fd, buffer, 0, buffer.length, null);
          if (!count) break;
          size += count; chunks.push(buffer.subarray(0, count));
        }
        if (size > MAX_DOWNLOAD) throw Error('Download exceeded 64 MiB.');
        bytes = Buffer.concat(chunks, size);
      } finally { fs.closeSync(fd); }
      const sha256 = hash(bytes);
      const preview = bytes.subarray(0,2048).includes(0) ? '[Binary file]' :
        bytes.subarray(0,2048).toString('utf8').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'�');
      const metadata = {name:path.basename(file),bytes:bytes.length,sha256,preview,origin:page.origin,triggerVerified:false};
      const decision = await confirmReceived(metadata, confirmationSignal);
      if (settled) return;
      confirmationSignal.throwIfAborted();
      if (decision !== true) throw Error('Actual received file was not manually approved; no project file was saved.');
      const currentRoot = fs.statSync(root);
      if (workspace(cwd) !== root || !currentRoot.isDirectory() || currentRoot.ino !== rootIdentity.ino || currentRoot.dev !== rootIdentity.dev)
        throw Error('Working directory changed during file approval. No file was saved.');
      publishDirectory = fs.mkdtempSync(path.join(root,'browser-download-'));
      publishedFile = path.join(publishDirectory,metadata.name);
      fs.writeFileSync(publishedFile,bytes,{flag:'wx',mode:0o600});
      await remove(directory);
      if (settled) return;
      confirmationSignal.throwIfAborted();
      settled = true; detach();
      resolve({status:'completed',path:publishedFile,bytes:bytes.length,sha256,reopenRequired:true,
        triggerVerified:false,attribution:'user-confirmed-file'});
    } catch (error) { fail(error.message || String(error)); }
  };
  const abort = () => fail('Download cancelled; inspect the page before retrying.');
  const grant = {
    promise,
    cancel:abort,
    discard:()=>fail('Page changed before download dispatch.',false),
    accept(event,incoming,contents) {
      if (settled || item || contents !== page.contents || signal.aborted) {event.preventDefault();return;}
      try {
        if (new URL(incoming.getURL()).origin !== page.origin) throw Error('Download must belong to the authorized site.');
        if (incoming.getTotalBytes() > MAX_DOWNLOAD) throw Error('Download exceeded 64 MiB.');
        const raw = incoming.getFilename().split(/[\\/]/).pop();
        const clean = (raw || 'download').replace(/[<>:"|?*\x00-\x1f]/g,'_').replace(/[. ]+$/g,'');
        let name='';
        for (const char of clean) {if (Buffer.byteLength(name+char,'utf8')>180) break;name+=char;}
        name=name.replace(/[. ]+$/g,'') || 'download';
        directory=fs.mkdtempSync(path.join(os.tmpdir(),'ashub-browser-receipt-'));
        file=path.join(directory,'result-'+name);
        incoming.setSavePath(file);item=incoming;
        incoming.on('updated',(_event,state)=>{
          if (incoming.getReceivedBytes()>MAX_DOWNLOAD || state==='interrupted') fail('Download interrupted or exceeded 64 MiB; no automatic retry.');
        });
        incoming.once('done',(_event,state)=>{
          if (settled) {void remove(directory).catch(()=>{});return;}
          if (state==='completed') void finish();
          else fail(`Download ${state}; no automatic retry.`);
        });
      } catch(error) {event.preventDefault();fail(error.message || String(error));}
    },
  };
  signal.addEventListener('abort',abort,{once:true});
  timer=setTimeout(()=>fail('Download timed out; inspect the page before retrying.'),timeoutMs);
  page.download=grant;
  if (signal.aborted) abort();
  return grant;
}
module.exports = { readSource, stageUpload, downloadGrant, MAX_TEXT, hash };

const path = require('node:path');
// Only data documents may be opened through their OS association. Executable
// and unknown types can still be revealed in the file manager.
const documents = new Set('pdf txt md markdown csv tsv json yaml yml xml log png jpg jpeg gif webp bmp avif heic tif tiff doc docx odt rtf xls xlsx ods ppt pptx odp mp3 wav m4a mp4 mov webm zip 7z gz tar'.split(' '));
async function performFileAction({ trusted, resolve, shell }, event, request) {
  if (!trusted(event)) throw Error('Untrusted desktop sender');
  if (!request || !['open', 'reveal'].includes(request.action)
      || !/^[0-9a-f]{4,32}$/.test(request.session || '')
      || typeof request.path !== 'string' || !request.path || request.path.length > 8192) throw Error('Invalid file request');
  const file = await resolve(request.session, request.path);
  if (!trusted(event)) throw Error('Desktop window changed');
  if (request.action === 'reveal') { shell.showItemInFolder(file); return; }
  if (!documents.has(path.extname(file).slice(1).toLowerCase())) throw Error('This file type cannot be opened directly. Reveal it in the file manager instead.');
  const error = await shell.openPath(file);
  if (error) throw Error(error);
}
module.exports = { performFileAction };

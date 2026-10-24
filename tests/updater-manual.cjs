const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const path = require('node:path');

test('ad-hoc update finishes without asking Squirrel to verify or install the ZIP', async () => {
  const file = require.resolve('electron-updater/out/MacUpdater.js');
  const native = new EventEmitter(); let checks = 0, installed = 0;
  native.setFeedURL = () => {}; native.checkForUpdates = () => { checks++; throw Error('signature mismatch'); };
  native.quitAndInstall = () => installed++;
  class Base extends EventEmitter {
    constructor() { super(); this._logger = {info(){},debug(){},warn(){}}; }
    dispatchUpdateDownloaded(event) { this.emit('update-downloaded', event); }
  }
  const exports = {}, localRequire = createRequire(file);
  vm.runInNewContext(fs.readFileSync(file,'utf8'), { exports, Buffer, require: id => id === 'electron' ? {autoUpdater:native} : id === './AppUpdater' ? {AppUpdater:Base} : localRequire(id) });
  const updater = new exports.MacUpdater(); const sent = [];
  const source = fs.readFileSync(path.join(__dirname,'../electron/main.cjs'),'utf8');
  const setup = source.slice(source.indexOf('function setupAutoUpdater()'), source.indexOf('function setupIPC()'));
  const context = { autoUpdater:updater, isAdhocSigned:true, console:{log(){},error(){}}, mainWindow:{isDestroyed:()=>false,setProgressBar(){},webContents:{send:(...args)=>sent.push(args)}},cachedUpdateFile:null,updaterReady:true };
  vm.runInNewContext(setup+'; setupAutoUpdater();',context);
  assert.equal(updater.autoInstallOnAppQuit,false); assert.equal(updater.autoDownload,false);
  updater.downloadedUpdateHelper={file:'/fixture/asHub-update.zip'};
  try {
    await updater.updateDownloaded({info:{size:1},url:new URL('https://example.invalid/update.zip')},{version:'0.20.7',downloadedFile:updater.downloadedUpdateHelper.file});
    assert.equal(checks,0);assert.equal(installed,0);
    assert.equal(context.cachedUpdateFile,updater.downloadedUpdateHelper.file);
    assert.deepEqual(sent,[['update-downloaded','0.20.7']]);
  } finally { updater.closeServerIfExists(); }
  context.isAdhocSigned=false;
  vm.runInNewContext('setupAutoUpdater()',context);
  assert.equal(updater.autoInstallOnAppQuit,true,'signed/Windows builds keep their supported install path');
});

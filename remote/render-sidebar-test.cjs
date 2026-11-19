const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const check=require('./sidebar-scroll-scenarios.cjs');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'ashub-sidebar-test-'));
app.setPath('userData',profile);let win;
const timer=setTimeout(()=>finish(1),30000);
function finish(code){clearTimeout(timer);win?.destroy();try{fs.rmSync(profile,{recursive:true,force:true})}catch{}app.exit(code)}
app.whenReady().then(async()=>{
 win=new BrowserWindow({show:false,width:390,height:844,webPreferences:{backgroundThrottling:false,nodeIntegration:false,contextIsolation:true}});
 await win.loadFile(path.join(__dirname,'public/index.html'));
 await check(code=>win.webContents.executeJavaScript(code),(w,h)=>win.setContentSize(w,h));
}).then(()=>finish(0),e=>{console.error(e);finish(1)});

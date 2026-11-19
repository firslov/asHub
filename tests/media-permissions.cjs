const test=require('node:test'),assert=require('node:assert/strict');
const {installMediaPermissions}=require('../electron/media-permissions.cjs');
test('microphone restricted to trusted composer main frame; no camera or embedded page grants',async()=>{
 let request,check,asked=0;const origin='http://127.0.0.1:7878',content={isDestroyed:()=>false,getURL:()=>origin+'/abcd/'};
 const session={setPermissionRequestHandler:fn=>request=fn,setPermissionCheckHandler:fn=>check=fn};
 installMediaPermissions(session,{origin,BrowserWindow:{fromWebContents:wc=>wc===content?{}:null},systemPreferences:{getMediaAccessStatus:()=> 'not-determined',askForMediaAccess:async()=>{asked++;return true;}},platform:'darwin'});
 const allow=(permission,details={},wc=content)=>new Promise(resolve=>request(wc,permission,resolve,{requestingUrl:content.getURL(),isMainFrame:true,...details}));
 assert.equal(await allow('media',{mediaTypes:['audio']}),true);assert.equal(asked,1);
 assert.equal(check(content,'media',origin,{isMainFrame:true}),false);
 for(const details of [{mediaTypes:['video']},{mediaTypes:['audio','video']},{mediaTypes:[]},{mediaTypes:['audio'],isMainFrame:false},{mediaTypes:['audio'],requestingUrl:'https://evil.test/'},{mediaTypes:['audio'],requestingUrl:origin+'/api/uploads/file'}])assert.equal(await allow('media',details),false);
 assert.equal(await allow('display-capture',{mediaTypes:['audio']}),false);assert.equal(await allow('clipboard-read'),true);
 assert.equal(await allow('media',{mediaTypes:['audio']},{...content}),false);assert.equal(asked,1);
});

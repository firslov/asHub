// Only the application composer may request microphone access. Web pages retain
// their separate browser partition's deny policy; camera/screen are not enabled.
function trusted(contents, url, origin, BrowserWindow) {
  try {
    if (!contents || contents.isDestroyed() || !BrowserWindow.fromWebContents(contents)) return false;
    const top = new URL(contents.getURL()), requesting = new URL(url);
    return top.origin === origin && requesting.origin === origin && top.pathname === requesting.pathname
      && /^\/(?:[a-f0-9]{4,32}\/?|index\.html|backend\.html)?$/.test(top.pathname);
  } catch { return false; }
}
function installMediaPermissions(session, {origin,BrowserWindow,systemPreferences,platform=process.platform}) {
  const existing = new Set(['clipboard-read','clipboard-sanitized-write','notifications','fullscreen']);
  session.setPermissionCheckHandler((contents,permission,requestingOrigin,details={}) => {
    // Returning false for media ensures every grant passes the request handler.
    return permission !== 'media' && existing.has(permission) && trusted(contents,details.requestingUrl || requestingOrigin,origin,BrowserWindow) && details.isMainFrame !== false;
  });
  session.setPermissionRequestHandler((contents,permission,callback,details={}) => {
    const allowed = () => trusted(contents,details.requestingUrl,origin,BrowserWindow) && details.isMainFrame !== false;
    if(!allowed()) {callback(false);return;}
    if(permission!=='media') {callback(existing.has(permission));return;}
    if(!Array.isArray(details.mediaTypes)||details.mediaTypes.length!==1||details.mediaTypes[0]!=='audio') {callback(false);return;}
    void (async()=>{
      let granted=true;
      if(platform==='darwin') {
        const status=systemPreferences.getMediaAccessStatus('microphone');
        granted=status==='granted'||(status==='not-determined'&&await systemPreferences.askForMediaAccess('microphone'));
      }
      callback(granted&&allowed());
    })().catch(()=>callback(false));
  });
}
module.exports={installMediaPermissions};

// Exercise the same host-confirmed plugin resource as the desktop UI.
module.exports=async function(base,headers,wait){
 const call=async(route,body)=>{const r=await fetch(base+route,{headers,method:body===undefined?'GET':'POST',body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw Error(JSON.stringify(data));return data;};
 let snapshot;const feature=await wait(async()=>{const list=(await call('/api/extensions')).features;snapshot=list;return list.find(f=>f.capabilities?.includes('shared-conversations')&&f.state==='active');}).catch(e=>{throw Error(e.message+' '+JSON.stringify(snapshot));});
 const route='/api/plugin-resources/'+feature.pluginId+'/connections';
 return async(action,values={})=>{let result=await call(route,{action,values});if(result.confirmation)result=await call(route,{confirm:result.confirmation.id});return result;};
};

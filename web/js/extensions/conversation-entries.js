import { activeSessionId, openTab } from '../session-manager.js';
import { effect } from '../../vendor/signals-core.js';
import { conversationEntries } from './entry-state.js';
import { features } from './feature-state.js';
import { lang } from '../i18n.js';
import { mountResource } from './resource-view.js';
import { closeOtherPanels } from '../panel-manager.js';
const host=document.createElement('nav');host.className='conversation-entries';host.hidden=true;
host.setAttribute('aria-label','Plugin conversations');
document.querySelector('.sidebar-head')?.after(host);
let entries=[],epoch=0,signature='',welcome=null,memoryDialog=null;
let controls=[];
const text=(zh,en)=>lang.value==='zh'?zh:en;
function closeWelcome(restoreFocus=false){
  if(!welcome)return;
  const old=welcome;welcome=null;old.dispose?.();old.element.remove();
  if(old.underlay)old.underlay.inert=old.wasInert;
  if(restoreFocus&&old.focus?.isConnected)old.focus.focus();
}
function openWelcome(entry){
  closeWelcome();closeOtherPanels();
  const main=document.querySelector('.main');if(!main)return;
  const element=document.createElement('section');element.className='conversation-welcome';
  element.setAttribute('aria-label',entry.label);
  const close=document.createElement('button');close.type='button';close.className='p-icon-btn conversation-welcome-close';close.textContent='×';close.setAttribute('aria-label',text('返回对话','Back to conversation'));close.onclick=()=>closeWelcome(true);
  const card=document.createElement('div');card.className='conversation-welcome-card';
  const heading=document.createElement('h1');heading.textContent=entry.label;
  const subtitle=document.createElement('p');subtitle.className='conversation-welcome-subtitle';subtitle.textContent=entry.description||text('一个专属的对话空间','Your dedicated conversation');
  const content=document.createElement('div');content.className='extension-resource-host';
  card.append(heading,subtitle,content);element.append(close,card);
  const underlay=main.querySelector('.terminal-wrap');
  const state={entry,element,underlay,wasInert:underlay?.inert,focus:document.activeElement,active:activeSessionId.peek(),dispose:null};
  welcome=state;if(underlay)underlay.inert=true;main.append(element);close.focus();
  const navigate=async id=>{
    await refresh();
    if(welcome!==state)return;
    const current=entries.find(e=>e.pluginId===entry.pluginId&&e.key===entry.key);
    if(!current||current.sessionId!==id)throw Error(text('对话已变化，请重新打开入口','Conversation changed; reopen the entry'));
    closeWelcome();openTab(id);
  };
  state.dispose=mountResource(content,{pluginId:entry.pluginId},entry.setupResource||entry.resource,{openConversation:navigate,onComplete:navigate});
}
function openPanel(entry){
  closeWelcome();closeOtherPanels();memoryDialog?.close();
  const dialog=document.createElement('dialog');dialog.className='conversation-memory-dialog';dialog.setAttribute('aria-label',entry.label);
  // Keep modal keys away from chat shortcuts; retain native Escape and focus traversal.
  dialog.addEventListener('keydown',event=>event.stopPropagation());
  const close=document.createElement('button');close.type='button';close.className='p-icon-btn';close.textContent='×';close.setAttribute('aria-label',text('关闭','Close'));
  const title=document.createElement('h2');title.className='p-title';title.textContent=entry.label;
  const header=document.createElement('header');header.className='p-head';header.append(title,close);
  const content=document.createElement('div');content.className='p-body extension-resource-host';dialog.append(header,content);document.body.append(dialog);
  let dispose;const cleanup=()=>{dispose?.();dialog.remove();if(memoryDialog===dialog)memoryDialog=null;};close.onclick=()=>dialog.close();dialog.addEventListener('close',cleanup,{once:true});
  dispose=mountResource(content,{pluginId:entry.pluginId},entry.resource);memoryDialog=dialog;dialog.dataset.pluginId=entry.pluginId;dialog.showModal();close.focus();
}

function render(){
  for(const row of host.children){const active=!!row.dataset.sessionId&&row.dataset.sessionId===activeSessionId.value;row.dataset.active=String(active);const b=row.querySelector('.conversation-entry-open');if(active)b?.setAttribute('aria-current','page');else b?.removeAttribute('aria-current');}
  const key=JSON.stringify([entries,lang.value]);if(key===signature)return;signature=key;
  for(const dispose of controls)dispose();controls=[];
  host.replaceChildren();host.hidden=!entries.length;
  for(const e of entries){
    const row=document.createElement('div');row.className='conversation-entry';row.dataset.active=String(!!e.sessionId&&e.sessionId===activeSessionId.value);row.dataset.sessionId=e.sessionId||'';
    const button=document.createElement('button');button.type='button';button.className='conversation-entry-open';button.textContent=e.label;button.title=e.sessionId?text('打开专属对话','Open conversation'):text('设置专属对话','Set up conversation');
    if(row.dataset.active==='true')button.setAttribute('aria-current','page');
    button.onclick=()=>{if(e.sessionId){closeWelcome();openTab(e.sessionId);}else openWelcome(e);};
    const control=document.createElement('div');control.className='conversation-entry-control';
    row.append(button,control);host.append(row);
    controls.push(mountResource(control,{pluginId:e.pluginId},e.resource,{inlineToggle:true,onManage:()=>e.sessionId?openPanel(e):openWelcome(e)}));
  }
}
async function refresh(){const token=++epoch;try{const response=await fetch('/api/plugin-conversations',{cache:'no-store'});if(!response.ok)throw Error('Entries unavailable');const data=await response.json();if(token!==epoch)return;if(!Array.isArray(data))return;entries=data;if(memoryDialog&&!entries.some(e=>e.pluginId===memoryDialog.dataset.pluginId))memoryDialog.close();if(welcome&&!entries.some(e=>e.pluginId===welcome.entry.pluginId&&e.key===welcome.entry.key))closeWelcome();if(JSON.stringify(conversationEntries.peek())!==JSON.stringify(data))conversationEntries.value=data;render();}catch{/* Keep the last successful catalog on transient network failure. */}}
effect(()=>{const active=activeSessionId.value;lang.value;if(welcome&&active!==welcome.active)closeWelcome();render();});
document.addEventListener('ash:panel-opening',()=>closeWelcome());
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&welcome){event.preventDefault();event.stopImmediatePropagation();closeWelcome(true);}},{capture:true});
document.addEventListener('ash:host-state-changed',()=>void refresh());
window.addEventListener('focus',()=>void refresh());
features.subscribe(()=>void refresh());
void refresh();

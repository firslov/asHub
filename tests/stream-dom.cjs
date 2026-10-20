// Tree DOM for disclosure/state tests; real layout is verified in the browser.
class Node {
 constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.style={};this.events={};this.attrs={};this.hidden=false;this.scrollHeight=200;this.offsetHeight=0;this._text='';this.classes=new Set();this.classList={contains:x=>this.classes.has(x),add:(...xs)=>xs.forEach(x=>this.classes.add(x)),remove:(...xs)=>xs.forEach(x=>this.classes.delete(x)),toggle:(x,on)=>{on=on??!this.classes.has(x);on?this.classes.add(x):this.classes.delete(x);return on;}};}
 set className(v){this.classes=new Set(v.split(/\s+/).filter(Boolean));}
 get className(){return [...this.classes].join(' ');}
 set textContent(v){this.children.forEach(c=>c.parentElement=null);this.children=[];this._text=String(v);}
 get textContent(){return this._text+this.children.map(c=>c.textContent).join('');}
 set innerHTML(v){this.textContent='';for(const m of v.matchAll(/<span class="([^"]+)">([^<]*)<\/span>/g)){const n=new Node('span');n.className=m[1];n.textContent=m[2];this.appendChild(n);}}
 get lastElementChild(){return this.children.at(-1)??null;}
 get previousElementSibling(){const a=this.parentElement?.children;return a?.[a.indexOf(this)-1]??null;}
 get nextSibling(){const a=this.parentElement?.children;return a?.[a.indexOf(this)+1]??null;}
 get parentNode(){return this.parentElement;}
 appendChild(n){n.remove();this.children.push(n);n.parentElement=this;return n;}
 append(...ns){ns.forEach(n=>this.appendChild(n));}
 insertBefore(n,b){n.remove();this.children.splice(this.children.indexOf(b),0,n);n.parentElement=this;return n;}
 remove(){if(this.parentElement){const a=this.parentElement.children;a.splice(a.indexOf(this),1);this.parentElement=null;}}
 contains(n){return n===this||this.children.some(c=>c.contains(n));}
 matches(s){return s.startsWith('.')&&s.slice(1).split('.').every(c=>this.classes.has(c));}
 closest(s){for(let n=this;n;n=n.parentElement)if(n.matches(s))return n;return null;}
 querySelectorAll(s){return this.children.flatMap(c=>[...(c.matches(s)?[c]:[]),...c.querySelectorAll(s)]);}
 querySelector(s){return this.querySelectorAll(s)[0]??null;}
 setAttribute(k,v){this.attrs[k]=String(v);}
 addEventListener(k,f){(this.events[k]??=[]).push(f);}
 removeEventListener(k,f){this.events[k]=(this.events[k]??[]).filter(x=>x!==f);}
 dispatchEvent(e){for(const f of this.events[e.type]??[])f(e);}
 click(){this.dispatchEvent({type:'click'});}
}

module.exports={Node};

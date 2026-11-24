import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { MemoryStore } from '../../examples/extensions/personal-assistant/store.mjs';
import { retrieve } from '../../examples/extensions/personal-assistant/retrieval.mjs';
import { exactNumberMatch, rankHistory } from '../../examples/extensions/personal-assistant/history-retrieval.mjs';
import { selectRecall, recallBudget, stableNumberMatch } from '../../examples/extensions/personal-assistant/context.mjs';

const history = [
  ['drill','a','井口巡检时，扭矩设置为 23 牛米。'],
  ['fog','b','机柜内防潮使用硅胶干燥剂，包装变色就替换。'],
  ['safety','c','我对花生过敏，聚餐需要避免花生油。'],
  ['safety-copy','c','我对花生过敏，聚餐需要避免花生油。'],
  ['laptop','d','出差时电脑的充电器放在前台右侧的蓝抽屉。'],
  ['check','e','采购单 PX-1842 对应储能柜接线端子，已经到货。'],
  ['check-near','f','采购单 PX-1843 对应剩余电流检测模块，尚未到货。'],
  ['reader','g','负责压力容器校验的人是隋凯。'],
  ['drizzle','h','园圃育苗沿用滴灌，天亮前补水十分钟。'],
  ['bills','i','每月初核对报销凭证，把遗失的票据单独列清单。'],
  ['renew','j','下次牙科预约安排在周四下午。'],
  ['printer','k','展览海报采用哑光涂布纸，以免照明下反射。'],
  ['rail','l','乘高铁习惯坐靠窗，便于路上阅读。'],
  ['soup','m','煮汤时用昆布提鲜，避免额外加盐。'],
  ['version','r','版本 0.21.7 的下载附件已经校验。'],
  ['version-near','s','版本 0.21.8 的下载附件已经校验。'],
  ['future','d','电脑充电器改放入二楼工具间。',200],
].filter(doc=>(doc[3]??0)<=100).map(([id,evidence,text],i)=>({id,evidence,text,at:i+1,sourceId:'h-'+id}));
const stable = [
  ['safety-memory','c','花生过敏','用户对花生过敏，聚餐需避开花生油。','h-safety'],
  ['minutes','n','会议纪要','会议纪要整理成 Markdown，要先列决策和负责人。'],
  ['surge','o','失电处理','工程样机跳闸后应先断开负载，再检查接地。'],
  ['check-memory','f','采购单 PX-1843','采购单 PX-1843 对应剩余电流检测模块。','h-check-near'],
  ['birds','p','观察记录','鸟类观察用纸质笔记，物种名附拉丁学名。'],
  ['writing','q','写作格式','合同摘要不采用表格，逐段列条款。'],
];
const cases = [
  ['两字词','扭矩',['a']],['两字词','防潮',['b']],['两字词','隋凯',['g']],['两字词','滴灌',['h']],
  ['改写','饭局里千万别给我端什么吃的？',['c']],['改写','旅行时给笔记本补电的适配器收哪儿了？',['d']],
  ['改写','我哪天去口腔诊所？',['j']],['改写','项目原型保护断电后怎么排查？',['o']],
  ['改写','如何防止灯光在展板上晃眼？',['k']],['改写','坐动车时偏爱什么位置？',['l']],
  ['精确编号','采购单 PX-1842 到了没？',['e']],['精确编号','PX-1843',['f']],['精确编号','采购单 PX-1844',[]],['精确编号','0.21.7',['r']],
  ['直接','会议纪要有哪些格式要求？',['n']],['直接','报销凭证怎么核对？',['i']],['直接','聚餐又有花生油怎么办？',['c']],
  ['无关','解释二叉树的前序遍历',[]],['无关','求解一元二次方程',[]],['无关','彩虹是怎么形成的？',[]],
  ['无关','英文单词 drizzle 是什么意思？',[]],['无关','在手机上生成一张蓝底壁纸',[]],
];
const payload={passages:[...history.map(h=>[h.id,h.text]),...stable.map(s=>[s[0],s[2]+' '+s[3]])],queries:cases.map(c=>c[1])};
if(process.argv[2]==='--corpus'){console.log(JSON.stringify(payload));process.exit();}
const semantic=process.argv[2]?JSON.parse(fs.readFileSync(process.argv[2],'utf8')):null;
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-zh-eval-')),store=new MemoryStore(temp);
const session={};
const a={store,learning:{validator:()=>()=>true},snapshot:()=>({projects:[]})};
try {
  const labels=new Map(history.map(h=>[h.sourceId,h.evidence]));
  const stableIds=new Map();
  for(const [key,label,title,content,sourceId] of stable){
    const row=store.add({title,content,scope:'personal',kind:'fact'},{type:'user',at:0,refs:sourceId?[{id:sourceId}]:[]},'active');
    labels.set(row.id,label);stableIds.set(key,row);
  }
  const thresholds=[null,null,0.60,0.55,0.50,0.48,0.45,0.40];
  const run=(i,mode)=>{
    const query=cases[i][1];
    let memory=retrieve(a,session,query,mode===0?5:12,true,mode>0), originals=[];
    if(mode>0){
      memory=memory.filter(row=>stableNumberMatch(query,row));
      originals=rankHistory(history,query);
    }
    if(mode>=2){
      // Experimental additive dense retrieval. No online dependency and
      // no semantic fallback for a query containing an exact code.
      if(exactNumberMatch(query,'')){
        const hitIds=new Set(originals.map(x=>x.id)), memIds=new Set(memory.map(x=>x.id));
        const scored=payload.passages.map(([id],j)=>({id,score:semantic.scores[i][j]})).sort((a,b)=>b.score-a.score);
        const best=scored[0]?.score??0;
        const eligible=scored.filter(x=>x.score>=thresholds[mode] && x.score>=best-0.04).slice(0,2);
        for(const {id} of eligible){
          const raw=history.find(h=>h.id===id), row=stableIds.get(id);
          if(raw && !hitIds.has(id))originals.push(raw);
          if(row && !memIds.has(row.id))memory.push(row);
        }
      }
    }
    return selectRecall(memory,originals,recallBudget).items.map(item=>labels.get(item.id));
  };
  const modes=semantic?thresholds.length:2, results=[];
  for(let mode=0;mode<modes;mode++){
    for(let i=0;i<cases.length;i++)run(i,mode);
    const times=[], details=[];
    for(let i=0;i<cases.length;i++){
      const [,query,expected]=cases[i], selected=run(i,mode), distinct=new Set(selected);
      for(let r=0;r<12;r++){const start=performance.now();run(i,mode);times.push(performance.now()-start+(mode>=2?semantic.ms[i]:0));}
      const localTop=mode===2 ? payload.passages.map(([id],j)=>[id,+semantic.scores[i][j].toFixed(4)])
        .sort((a,b)=>b[1]-a[1]).slice(0,3) : undefined;
      details.push({query,type:cases[i][0],expected,selected,localTop,recalled:expected.filter(x=>distinct.has(x)).length,
        falseSlots:selected.filter(x=>!expected.includes(x)).length,duplicateSlots:selected.length-distinct.size});
    }
    times.sort((a,b)=>a-b);
    results.push({mode,threshold:thresholds[mode],queries:details.length,evidence:details.reduce((n,d)=>n+d.recalled,0),
      expected:details.reduce((n,d)=>n+d.expected.length,0),
      falseSlots:details.reduce((n,d)=>n+d.falseSlots,0), duplicates:details.reduce((n,d)=>n+d.duplicateSlots,0),
      emptyHits:details.filter(d=>!d.expected.length && d.selected.length).length,
      p50:+times[Math.floor(times.length*.5)].toFixed(2),p95:+times[Math.floor(times.length*.95)].toFixed(2),details});
  }
  console.log(JSON.stringify({budget:recallBudget,cutoff:100,semanticStartup:semantic?.startup,results},null,2));
} finally {store.close();fs.rmSync(temp,{force:true,recursive:true});}

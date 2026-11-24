import { identifiers, tokenPattern } from './precision.mjs';
import { createHmac } from 'node:crypto';

export const generatedHistory = /^\[(?:Cross-conversation message|插件任务|Compacted conversation|Context checkpoint|Personal assistant memory)/;
export const sensitiveHistory = /(?:sk-[A-Za-z0-9_-]{12,}|-----BEGIN .*PRIVATE KEY|(?:password|passwd|api[_ -]?key|密码|密钥|验证码)\s*[:：=]\s*\S+)/i;
export const forgetCommand = /^(?:(?:请(?:你|帮我)?|麻烦(?:你)?|我(?:希望|想让)你)\s*)?(?:忘记|(?:不要|别)(?:再)?(?:记住|记下|记))|^(?:please\s+)?(?:forget|(?:do not|don't|don’t)\s+remember)\b/iu;
export const normalizedClaim = value => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const digest = (key, value) => createHmac('sha256',key).update(value).digest('base64url');
const window = 8;
function anchorKey(seed, chars, start, size) {
  // This prefilter never decides a match; verify every hit with the keyed
  // digest of the complete claim. Avoid a crypto call per character.
  let hash=seed;
  for(let i=start;i<start+size;i++)hash=Math.imul(hash^chars[i].codePointAt(0),16777619);
  return hash;
}
const anchorSeed = key => Buffer.from(digest(key,'anchor-seed'),'base64url').readInt32LE(0);

// Preserve punctuation inside code-like tokens: ZT-1047 is not ZT1047.
const genericShort = /^(?:好的?|是的?|不是|没有|可以|收到|明白|知道|用户|个人|这个|那个|记忆|谢谢|ok|yes|no)$/iu;
function segments(text, identifier, includeHost=false) {
  return text.normalize('NFKC').toLowerCase()
    // The same possessive claim can be restated by the assistant in
    // second person or reported as the user's words.
    .replace(/(?:我|你|您|用户)的(?=\p{Script=Han})/gu,'其')
    .replace(tokenPattern,value=>{
      const exact=identifiers(value,includeHost);
      if(!exact.length)return value;
      exact.forEach(identifier);
      return '\n';
    })
    .split(/[。！!？?；;\n]+/u).map(s=>[...s
      .replace(/(?<=[a-z0-9])[^\p{L}\p{N}]+(?=[a-z0-9])/gu,'|')
      .replace(/[^\p{L}\p{N}|]/gu,'')]);

}
export function claimFingerprints(key, text, add) {
  const seed=anchorSeed(key);
  for (const sentence of text.split(/[。！!？?；;\n]+/u)) {
    let containsId=false;
    const spans=segments(sentence,value=>{containsId=true;add(digest(key,'id:'+value));});
    for(const chars of spans) {
      // Short text surrounding an identifier (for example "编号") is
      // context, not an independently forgotten fact.
      if(chars.length<2 || (containsId && chars.length<window))continue;
      const whole=chars.join('');
      if(genericShort.test(whole))continue;
      const size=Math.min(window,chars.length);
      add(digest(key,'claim:'+whole),chars.length,anchorKey(seed,chars,0,size));
    }
  }
}
export function historyGuard(store, id, readLegacy) {
  const ignored = new Set(store.state('ignored:'+id) ?? []);
  const {assistantId} = store.profile();
  const saved = store.state('raw-forgotten:'+id) ?? {};
  const hashes = new Set(saved.hashes ?? []);
  const anchors = new Map();
  const add = (hash,length,anchor)=>{
    hashes.add(hash);
    if(anchor!==undefined) {
      if(!anchors.has(anchor))anchors.set(anchor,new Set());
      anchors.get(anchor).add(length);
    }
  };
  for(const [anchor,lengths] of saved.anchors ?? [])anchors.set(anchor,new Set(lengths));
  // Older versions left only ignored IDs. Reconstruct fingerprints ephemerally
  // when the current grant permits reading them. Missing evidence fails closed
  // for original text, without changing eligibility of independent memories.
  let complete = true;
  const covered = new Set(saved.covered ?? []);
  for (const ref of ignored) {
    if (covered.has(ref)) continue;
    try {
      const source = readLegacy?.(ref);
      if (!source || source.more || !source.text) { complete=false; break; }
      claimFingerprints(assistantId,source.text,add);
    } catch { complete=false; break; }
  }
  const sizes=[...new Set([...anchors.values()].flatMap(x=>[...x].map(n=>Math.min(window,n))))];
  const seed=anchorSeed(assistantId);
  return {
    complete, ignored, hasRules: hashes.size>0,
    matches(text) {
      if (!hashes.size) return false;
      let blocked=false;
      const spans=segments(text,value=>{if(hashes.has(digest(assistantId,'id:'+value)))blocked=true;},true);
      if(blocked)return true;
      for(const chars of spans) {
        for(const size of sizes) {
          for(let i=0;i+size<=chars.length;i++) {
            const anchor=anchorKey(seed,chars,i,size);
            for(const length of anchors.get(anchor) ?? []) {
              const end=i+length, ascii=char=>char!==undefined && /[a-z0-9]/.test(char);
              if(end>chars.length || (ascii(chars[i-1])&&ascii(chars[i])) || (ascii(chars[end-1])&&ascii(chars[end])))continue;
              if(hashes.has(digest(assistantId,'claim:'+chars.slice(i,end).join(''))))return true;
            }
          }
        }
      }
      return false;
    },
  };
}

import { Buffer } from 'node:buffer';
const DEFAULT_ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';
const MANAGED_ENDPOINT = 'https://ashub.aihao.world/mobile/voice/transcribe';
const HUNYUAN_ENDPOINT = 'https://tokenhub.tencentmaas.com/v1/wand/asrproxy/sync_transcribe';
const HUNYUAN_MODEL = 'hy-asr-3.0-preview';
function isHunyuanEndpoint(endpoint) {
    const url = new URL(endpoint);
    return url.origin === 'https://tokenhub.tencentmaas.com' && url.pathname.replace(/\/$/, '') === '/v1/wand/asrproxy/sync_transcribe';
}
export function validateConfig(value, previous = {}) {
    const endpoint = String(value.endpoint || DEFAULT_ENDPOINT).trim();
    let url; try { url = new URL(endpoint); } catch { throw Error('请填写有效的 HTTPS 转写接口地址'); }
    if (endpoint.length > 2048 || url.hostname.length > 253 || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw Error('转写接口必须使用 HTTPS，不能包含账号、参数或片段');
    const hunyuan = isHunyuanEndpoint(endpoint);
    if (url.hostname === 'tokenhub.tencentmaas.com' && !hunyuan) throw Error('腾讯混元请使用完整同步转写地址：' + HUNYUAN_ENDPOINT);
    const model = String(value.model || (hunyuan ? HUNYUAN_MODEL : 'gpt-transcribe')).trim();
    if (hunyuan && model !== HUNYUAN_MODEL) throw Error('腾讯混元转写模型请填写 ' + HUNYUAN_MODEL);
    if (!/^[a-zA-Z0-9_.:/-]{1,120}$/.test(model)) throw Error('模型名称无效');
    const supplied = String(value.apiKey || '').trim();
    // Never forward an existing credential to a newly configured destination.
    if (!supplied && previous.endpoint && previous.endpoint !== endpoint) throw Error('更换服务地址时请重新填写对应 API Key');
    const apiKey = supplied || previous.apiKey;
    if (!apiKey || apiKey.length > 8192 || /[\r\n]/.test(apiKey)) throw Error('请填写转写服务 API Key');
    return { endpoint, model, apiKey };
}
export async function transcribe(config, input, fetcher = globalThis.fetch) {
    input.signal.throwIfAborted();
    const type = input.mimeType.split(';')[0].toLowerCase();
    const extension = { 'audio/mp4':'mp4', 'audio/x-m4a':'m4a', 'audio/webm':'webm', 'audio/ogg':'ogg', 'audio/wav':'wav', 'audio/mpeg':'mp3' }[type];
    if (!extension) throw Error('此录音格式暂不支持');
    const hunyuan = isHunyuanEndpoint(config.endpoint);
    const headers = {Authorization:'Bearer ' + config.apiKey};
    let body;
    if (hunyuan) {
        headers['Content-Type'] = 'application/json';
        // TokenHub accepts the original container as Base64; no public upload URL,
        // chat history or forced language/codec is needed (encoding defaults to auto).
        body = JSON.stringify({model:config.model, data:Buffer.from(input.data).toString('base64')});
    } else {
        body = new FormData();
        body.set('model', config.model);
        body.set('file', new Blob([input.data], {type: input.mimeType}), 'recording.' + extension);
    }
    // Automatic language detection retains mixed Chinese/English without injecting history.
    const response = await fetcher(config.endpoint, { method:'POST', headers, body, signal:input.signal, redirect:'error' });
    input.signal.throwIfAborted();
    if (!response.ok) { await response.body?.cancel(); throw Error(response.status === 401 || response.status === 403 ? (hunyuan ? '腾讯混元认证失败，请检查 TokenHub API Key 及服务权限（不是 SecretId / SecretKey）' : '转写服务认证失败，请在电脑端检查 API Key') : '转写服务请求失败（' + response.status + '），请稍后重新录音'); }
    return readTranscript(response, input.signal, hunyuan);
}

async function readTranscript(response, signal, hunyuan) {
    const reader = response.body?.getReader(); if (!reader) throw Error('转写服务返回空结果');
    let size = 0; const chunks = [];
    try { while (true) { const {value,done} = await reader.read(); signal.throwIfAborted(); if(done) break; size += value.byteLength; if(size > 128000) throw Error('转写结果过大'); chunks.push(value); } }
    finally { await reader.cancel().catch(()=>{}); }
    let result; try { result = JSON.parse(await new Blob(chunks).text()); } catch { throw Error('转写服务返回的格式无效'); }
    signal.throwIfAborted();
    if (hunyuan && result?.status !== 'completed') throw Error('腾讯混元未返回已完成的转写结果，请稍后重新录音');
    const text = hunyuan ? result?.output?.text : result?.text;
    if (typeof text !== 'string' || text.length > 20000) throw Error('转写服务返回的文本无效');
    return text.trim();
}

export async function transcribeWithDefault(input, fetcher = globalThis.fetch) {
    input.signal.throwIfAborted();
    if (input.mimeType !== 'audio/wav') throw Error('免费转写需要 WAV 录音，请更新 asHub 或刷新远控网页');
    const response = await fetcher(MANAGED_ENDPOINT, {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({mimeType: input.mimeType, data: Buffer.from(input.data).toString('base64')}),
        signal: input.signal, redirect: 'error', credentials: 'omit',
    }).catch(() => {
        input.signal.throwIfAborted();
        throw Error('asHub 免费转写连接失败，请稍后重试');
    });
    input.signal.throwIfAborted();
    if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw Error(response.status === 429 ? 'asHub 免费转写已达使用限额，请稍后重试或切换到自定义转写' : 'asHub 免费转写暂不可用，请稍后重试或切换到自定义转写');
    }
    return readTranscript(response, input.signal, false);
}

export default function activate(ctx) {
    const {secrets, composerInputs, interactions} = ctx.services;
    const freeSupported = composerInputs.supportsPcmWav === true;
    let mode = 'default', config, dispose, revision = 0;
    try {
        const raw = secrets.read('configuration');
        if (raw) {
            mode = 'custom';
            const saved = JSON.parse(raw);
            if (saved.mode === 'default') mode = 'default';
            if (saved.endpoint || mode === 'custom') config = validateConfig(saved);
        }
    } catch { if (!config) mode = 'custom'; }

    const register = () => {
        dispose?.(); dispose = undefined;
        const captured = config;
        const free = mode === 'default';
        if (free ? !freeSupported : !captured) return;
        const destination = free ? 'asHub 网关及腾讯混元' : new URL(captured.endpoint).host;
        dispose = composerInputs.register('dictation', {
            label:'语音输入', description:'录音发送至 ' + destination + ' · 最长 60 秒 · 仅写入草稿',
            kind:'audio', maxBytes:free ? 44 + 60 * 16000 * 2 : 4*1024*1024, maxDuration:60,
            ...(free ? {audioFormat: 'pcm-wav'} : {}),
            transform: free ? transcribeWithDefault : input => transcribe(captured, input),
        });
    };
    const customOnly = {field: 'mode', values: ['custom']};
    const view = () => ({ actions:config?[{id:'clear',label:'清除自定义配置',values:{}}]:[], rows:[],
        note: (freeSupported ? '' : '免费转写需要更新 asHub。当前版本可使用自定义转写。\n')
            + (mode === 'custom' && !config ? '请重新填写自定义转写配置，或切换到 asHub 免费转写。\n' : '')
            + 'asHub 免费转写（默认）无需填写 API Key，录音由 asHub 转发给腾讯混元，受共享额度限制。\n自定义转写直接发送到所填接口，费用由所用服务商决定。腾讯混元请填写 ' + HUNYUAN_ENDPOINT + '，模型为 ' + HUNYUAN_MODEL + '，使用 TokenHub API Key。\n转写结果仅插入草稿。手机沿用执行电脑上的设置。',
        form:{action:'save',submit:'保存',values:{},fields:[
            {id:'mode',type:'select',label:'转写服务',value:mode,options:[{value:'default',label:'asHub 免费转写（默认）'},{value:'custom',label:'自定义转写'}]},
            {id:'endpoint',type:'text',label:'转写接口（HTTPS）',value:config?.endpoint || DEFAULT_ENDPOINT,when:customOnly},
            {id:'model',type:'text',label:'转写模型',value:config?.model || 'gpt-transcribe',when:customOnly},
            {id:'apiKey',type:'password',label:config?'API Key（留空保留）':'API Key',when:customOnly},
        ]},
    });
    interactions.register('settings',{view,prepare:async(action,values)=>{
        const preparedRevision = revision;
        const checkCurrent = () => { ctx.signal.throwIfAborted(); if (preparedRevision !== revision) throw Error('语音配置已变更，请重新打开设置并确认'); };
        if(action==='clear') return {preview:{title:'清除自定义转写配置',fields:[{label:'影响',value:freeSupported?'删除本机保存的转写密钥，改用 asHub 免费转写。已有草稿不受影响。':'删除本机保存的转写密钥并停止语音输入。已有草稿不受影响。'}]},execute:()=>{checkCurrent();secrets.write('configuration',null);revision++;config=undefined;mode='default';register();return view();}};
        if(action!=='save') throw Error('不支持的操作');
        if(values.mode==='default') {
            if (!freeSupported) throw Error('请更新 asHub 后再启用免费转写');
            return {preview:{title:'使用 asHub 免费转写',fields:[{label:'录音发送至',value:'asHub 网关及腾讯混元'},{label:'使用说明',value:'免费使用，受共享额度限制。保留本机已保存的自定义配置。'}]},execute:()=>{
                checkCurrent();
                if (mode !== 'default') {
                    secrets.write('configuration', JSON.stringify({...config,mode:'default'}));
                    revision++;mode='default';register();
                }
                return view();
            }};
        }
        if(values.mode!==undefined && values.mode!=='custom') throw Error('请选择转写服务');
        if(!secrets.available) throw Error('系统加密存储不可用，无法保存语音服务密钥');
        const next=validateConfig(values,config);
        return {preview:{title:'配置语音输入',fields:[{label:'录音发送至',value:next.endpoint},{label:'模型',value:next.model},{label:'用途',value:'点击麦克风并完成录音后转写，可能产生费用；不会自动发送消息。'}]},execute:()=>{checkCurrent();secrets.write('configuration',JSON.stringify(next));revision++;config=next;mode='custom';register();return view();}};
    }});
    register();
    return {stop:()=>dispose?.()};
}

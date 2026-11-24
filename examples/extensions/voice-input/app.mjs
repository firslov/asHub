import { Buffer } from 'node:buffer';
const DEFAULT_ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';
const MANAGED_ENDPOINT = 'https://ashub.aihao.world/mobile/voice/transcribe';
const HUNYUAN_ENDPOINT = 'https://tokenhub.tencentmaas.com/v1/wand/asrproxy/sync_transcribe';
const HUNYUAN_MODEL = 'hy-asr-3.0-preview';
const translator = context => (zh, en) => context?.locale === 'en' ? en : zh;
const transcriptionError = (code, message) => Object.assign(Error(message), { code });
function isHunyuanEndpoint(endpoint) {
    const url = new URL(endpoint);
    return url.origin === 'https://tokenhub.tencentmaas.com' && url.pathname.replace(/\/$/, '') === '/v1/wand/asrproxy/sync_transcribe';
}
export function validateConfig(value, previous = {}, context) {
    const t = translator(context);
    const endpoint = String(value.endpoint || DEFAULT_ENDPOINT).trim();
    let url; try { url = new URL(endpoint); } catch { throw Error(t('请填写有效的 HTTPS 转写接口地址', 'Enter a valid HTTPS transcription endpoint.')); }
    if (endpoint.length > 2048 || url.hostname.length > 253 || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw Error(t('转写接口必须使用 HTTPS，不能包含账号、参数或片段', 'Use HTTPS for the transcription endpoint and omit credentials, query parameters and fragments.'));
    const hunyuan = isHunyuanEndpoint(endpoint);
    if (url.hostname === 'tokenhub.tencentmaas.com' && !hunyuan) throw Error(t('腾讯混元请使用完整同步转写地址：', 'Use the full Tencent Hunyuan transcription endpoint: ') + HUNYUAN_ENDPOINT);
    const model = String(value.model || (hunyuan ? HUNYUAN_MODEL : 'gpt-transcribe')).trim();
    if (hunyuan && model !== HUNYUAN_MODEL) throw Error(t('腾讯混元转写模型请填写 ', 'Use this model for Tencent Hunyuan: ') + HUNYUAN_MODEL);
    if (!/^[a-zA-Z0-9_.:/-]{1,120}$/.test(model)) throw Error(t('模型名称无效', 'Enter a valid model name.'));
    const supplied = String(value.apiKey || '').trim();
    // Never forward an existing credential to a newly configured destination.
    if (!supplied && previous.endpoint && previous.endpoint !== endpoint) throw Error(t('更换服务地址时请重新填写对应 API Key', 'Enter the API key for the new endpoint.'));
    const apiKey = supplied || previous.apiKey;
    if (!apiKey || apiKey.length > 8192 || /[\r\n]/.test(apiKey)) throw Error(t('请填写转写服务 API Key', 'Enter the API key for the transcription service.'));
    return { endpoint, model, apiKey };
}
export async function transcribe(config, input, fetcher = globalThis.fetch) {
    input.signal.throwIfAborted();
    const type = input.mimeType.split(';')[0].toLowerCase();
    const extension = { 'audio/mp4':'mp4', 'audio/x-m4a':'m4a', 'audio/webm':'webm', 'audio/ogg':'ogg', 'audio/wav':'wav', 'audio/mpeg':'mp3' }[type];
    if (!extension) throw transcriptionError('formatUnsupported', '此录音格式暂不支持');
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
    if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403) {
            throw hunyuan
                ? transcriptionError('hunyuanAuth', '腾讯混元认证失败，请检查 TokenHub API Key 及服务权限（不是 SecretId / SecretKey）')
                : transcriptionError('providerAuth', '转写服务认证失败，请在电脑端检查 API Key');
        }
        throw transcriptionError('providerFailure', '转写服务请求失败（' + response.status + '），请稍后重新录音');
    }
    return readTranscript(response, input.signal, hunyuan);
}

async function readTranscript(response, signal, hunyuan) {
    const reader = response.body?.getReader(); if (!reader) throw transcriptionError('providerEmpty', '转写服务返回空结果');
    let size = 0; const chunks = [];
    try { while (true) { const {value,done} = await reader.read(); signal.throwIfAborted(); if(done) break; size += value.byteLength; if(size > 128000) throw transcriptionError('providerTooLarge', '转写结果过大'); chunks.push(value); } }
    finally { await reader.cancel().catch(()=>{}); }
    let result; try { result = JSON.parse(await new Blob(chunks).text()); } catch { throw transcriptionError('providerInvalid', '转写服务返回的格式无效'); }
    signal.throwIfAborted();
    if (hunyuan && result?.status !== 'completed') throw transcriptionError('hunyuanIncomplete', '腾讯混元未返回已完成的转写结果，请稍后重新录音');
    const text = hunyuan ? result?.output?.text : result?.text;
    if (typeof text !== 'string' || text.length > 20000) throw transcriptionError('providerInvalid', '转写服务返回的文本无效');
    return text.trim();
}

export async function transcribeWithDefault(input, fetcher = globalThis.fetch) {
    input.signal.throwIfAborted();
    if (input.mimeType !== 'audio/wav') throw transcriptionError('freeWav', '免费转写需要 WAV 录音，请更新 asHub 或刷新远控网页');
    const response = await fetcher(MANAGED_ENDPOINT, {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({mimeType: input.mimeType, data: Buffer.from(input.data).toString('base64')}),
        signal: input.signal, redirect: 'error', credentials: 'omit',
    }).catch(() => {
        input.signal.throwIfAborted();
        throw transcriptionError('freeNetwork', 'asHub 免费转写连接失败，请稍后重试');
    });
    input.signal.throwIfAborted();
    if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw response.status === 429
            ? transcriptionError('freeQuota', 'asHub 免费转写已达使用限额，请稍后重试或切换到自定义转写')
            : transcriptionError('freeUnavailable', 'asHub 免费转写暂不可用，请稍后重试或切换到自定义转写');
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
        const destination = free ? undefined : new URL(captured.endpoint).host;
        dispose = composerInputs.register('dictation', {
            label:'语音输入', description:'录音发送至 ' + (destination ?? 'asHub 网关及腾讯混元') + ' · 最长 60 秒 · 仅写入草稿',
            labelEn:'Voice input', descriptionEn:'Send audio to ' + (destination ?? 'asHub and Tencent Hunyuan') + ' · 60 s max · draft only',
            kind:'audio', maxBytes:free ? 44 + 60 * 16000 * 2 : 4*1024*1024, maxDuration:60,
            ...(free ? {audioFormat: 'pcm-wav'} : {}),
            transform: free ? transcribeWithDefault : input => transcribe(captured, input),
        });
    };
    const customOnly = {field: 'mode', values: ['custom']};
    const view = context => {
        const t = translator(context);
        const setupNote = !freeSupported
            ? t('免费转写需要更新 asHub。当前版本可使用自定义转写。', 'Update asHub to use free transcription. Custom transcription is available in this version.')
            : mode === 'custom' && !config
                ? t('请重新填写自定义转写配置，或切换到 asHub 免费转写。', 'Re-enter your custom settings or switch to free asHub transcription.')
                : undefined;
        return {
            title:t('语音输入', 'Voice input'), actions:config?[{id:'clear',label:t('清除自定义配置', 'Clear custom settings'),values:{}}]:[], rows:[],
            note: setupNote,
            form:{action:'save',submit:t('保存', 'Save'),values:{},compact:true,fields:[
                {id:'mode',type:'select',label:t('转写服务', 'Transcription service'),value:mode,options:[{value:'default',label:t('asHub 免费转写', 'Free asHub transcription')},{value:'custom',label:t('自定义转写', 'Custom transcription')}]},
                {id:'endpoint',type:'text',label:t('转写接口（HTTPS）', 'Transcription endpoint (HTTPS)'),value:config?.endpoint || DEFAULT_ENDPOINT,when:customOnly},
                {id:'model',type:'text',label:t('转写模型', 'Transcription model'),value:config?.model || 'gpt-transcribe',when:customOnly},
                {id:'apiKey',type:'password',label:config?t('API Key（留空保留）', 'API key (leave blank to keep)'):t('API Key', 'API key'),when:customOnly},
            ],guidance:[
                {after:'mode',when:{field:'mode',values:['default']},detail:t(
                    '录音经 asHub 转发至腾讯混元。使用共享额度，无需密钥。',
                    'asHub forwards recordings to Tencent Hunyuan. Uses a shared quota. No API key needed.',
                )},
                {after:'mode',when:customOnly,detail:t(
                    '录音直接发送到所填接口。服务商可能收费。',
                    'Recordings go directly to your endpoint. Your provider may charge.',
                )},
                {when:customOnly,summary:t('腾讯混元接入说明', 'Tencent Hunyuan setup'),detail:t(
                    `接口 ${HUNYUAN_ENDPOINT}\n模型 ${HUNYUAN_MODEL}\n密钥使用 TokenHub API Key`,
                    `Endpoint ${HUNYUAN_ENDPOINT}\nModel ${HUNYUAN_MODEL}\nUse a TokenHub API key.`,
                )},
                {detail:t(
                    '转写只写入草稿。手机沿用这台电脑的设置。',
                    'Transcripts go into your draft. Mobile access uses this computer’s settings.',
                )},
            ]},
        };
    };
    interactions.register('settings',{view,prepare:async(action,values,context)=>{
        const t = translator(context);
        const preparedRevision = revision;
        const checkCurrent = actionContext => {
            ctx.signal.throwIfAborted();
            if (preparedRevision !== revision) throw Error(translator(actionContext ?? context)('语音配置已变更，请重新打开设置并确认', 'Voice settings changed. Open the settings again and review your changes.'));
        };
        if(action==='clear') return {preview:{title:t('清除自定义转写配置', 'Clear custom transcription settings'),fields:[{
            label:t('影响', 'What changes'), value:freeSupported
                ? t('删除本机保存的转写密钥，改用 asHub 免费转写。已有草稿不受影响。', 'Remove the saved key from this computer and switch to free asHub transcription. Existing drafts are kept.')
                : t('删除本机保存的转写密钥并停止语音输入。已有草稿不受影响。', 'Remove the saved key from this computer and turn off voice input. Existing drafts are kept.'),
        }]},execute:(_,actionContext)=>{checkCurrent(actionContext);secrets.write('configuration',null);revision++;config=undefined;mode='default';register();return view(actionContext ?? context);}};
        if(action!=='save') throw Error(t('不支持的操作', 'This action is unavailable.'));
        if(values.mode==='default') {
            if (!freeSupported) throw Error(t('请更新 asHub 后再启用免费转写', 'Update asHub to enable free transcription.'));
            return {preview:{title:t('使用 asHub 免费转写', 'Use free asHub transcription'),fields:[{label:t('录音发送至', 'Recordings are sent to'),value:t('asHub 网关及腾讯混元', 'asHub and Tencent Hunyuan')},{label:t('使用说明', 'Usage'),value:t('免费使用，受共享额度限制。保留本机已保存的自定义配置。', 'Free to use within a shared quota. Your saved custom settings stay on this computer.')}]},execute:(_,actionContext)=>{
                checkCurrent(actionContext);
                if (mode !== 'default') {
                    secrets.write('configuration', JSON.stringify({...config,mode:'default'}));
                    revision++;mode='default';register();
                }
                return view(actionContext ?? context);
            }};
        }
        if(values.mode!==undefined && values.mode!=='custom') throw Error(t('请选择转写服务', 'Choose a transcription service.'));
        if(!secrets.available) throw Error(t('系统加密存储不可用，无法保存语音服务密钥', 'Secure system storage is unavailable. The API key could not be saved.'));
        const next=validateConfig(values,config,context);
        return {preview:{title:t('配置语音输入', 'Configure voice input'),fields:[{label:t('录音发送至', 'Recordings are sent to'),value:next.endpoint},{label:t('模型', 'Model'),value:next.model},{label:t('用途', 'Usage'),value:t('点击麦克风并完成录音后转写，可能产生费用；不会自动发送消息。', 'Recordings may incur a charge. Transcripts go into your draft for you to send.')}]},execute:(_,actionContext)=>{checkCurrent(actionContext);secrets.write('configuration',JSON.stringify(next));revision++;config=next;mode='custom';register();return view(actionContext ?? context);}};
    }});
    register();
    return {stop:()=>dispose?.()};
}

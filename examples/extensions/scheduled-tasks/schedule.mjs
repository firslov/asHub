const formatters = new Map();
export function localParts(at, zone) {
    let f = formatters.get(zone);
    if (!f) {
        f = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
        formatters.set(zone, f);
    }
    return Object.fromEntries(f.formatToParts(new Date(at)).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
}
const stamp = p => Date.UTC(p.year, p.month - 1, p.day, p.hour ?? 0, p.minute ?? 0, p.second ?? 0);
export function localInstant(value, zone) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(value);
    if (!m)
        throw Error('时间格式应为 YYYY-MM-DD HH:mm');
    const [year, month, day, hour, minute] = m.slice(1).map(Number), desired = { year, month, day, hour, minute, second: 0 }, naive = stamp(desired);
    const n = new Date(naive);
    if (n.getUTCFullYear() !== year || n.getUTCMonth() + 1 !== month || n.getUTCDate() !== day || hour > 23 || minute > 59)
        throw Error('日期或时间无效');
    const offsets = new Set();
    for (const h of [-36, -12, 0, 12, 36]) {
        const t = naive + h * 3600000;
        offsets.add(stamp(localParts(t, zone)) - t);
    }
    const matches = [...offsets].map(offset => naive - offset).filter(t => stamp(localParts(t, zone)) === naive).sort((a, b) => a - b);
    if (!matches.length)
        throw Error('该本地时间不存在（可能处于夏令时跳转）');
    return matches[0]; // Fall-back overlap runs only at the first occurrence.
}
export function dateText(at, zone) { const p = localParts(at, zone), pad = n => String(n).padStart(2, '0'); return `${p.year}-${pad(p.month)}-${pad(p.day)}`; }
export function timeText(at, zone) { const p = localParts(at, zone), pad = n => String(n).padStart(2, '0'); return `${dateText(at, zone)} ${pad(p.hour)}:${pad(p.minute)}`; }
export function normalize(input, now = Date.now()) {
    const zone = String(input.timezone || '').trim();
    localParts(now, zone);
    const text = (v, max, label) => { if (typeof v !== 'string' || !v.trim() || v.length > max || v.includes('\0'))
        throw Error(`${label}不能为空且不能超出长度限制`); return v.trim(); };
    const s = { title: text(input.title, 120, '名称'), targetId: text(input.targetId, 100, '目标对话'), message: text(input.message, 8000, '任务内容'), timezone: zone, cadence: input.cadence, missed: input.missed ?? 'skip', graceMinutes: Number(input.graceMinutes ?? 30) };
    if (!['once', 'daily', 'weekdays', 'weekly', 'interval'].includes(s.cadence) || !['skip', 'catchup'].includes(s.missed) || !Number.isInteger(s.graceMinutes) || s.graceMinutes < 1 || s.graceMinutes > 1440)
        throw Error('无效的执行规则或延迟期限');
    const variables = [...s.message.matchAll(/\{\{(.*?)\}\}/g)].map(m => m[1]);
    if (variables.some(k => !['scheduled_date', 'scheduled_time', 'triggered_time'].includes(k)))
        throw Error('仅支持 scheduled_date、scheduled_time、triggered_time 时间变量');
    if (s.cadence === 'once') {
        s.onceAt = localInstant(String(input.onceAt ?? ''), zone);
        if (s.onceAt <= now)
            throw Error('单次任务时间必须在将来');
    }
    else if (s.cadence === 'interval') {
        s.intervalMinutes = Number(input.intervalMinutes);
        if (!Number.isInteger(s.intervalMinutes) || s.intervalMinutes < 5 || s.intervalMinutes > 10080)
            throw Error('间隔应为 5–10080 分钟');
        s.anchor = now + s.intervalMinutes * 60000;
    }
    else {
        s.time = String(input.time ?? '');
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time))
            throw Error('时间格式应为 HH:mm');
        if (s.cadence === 'weekly') {
            s.weekday = Number(input.weekday);
            if (!Number.isInteger(s.weekday) || s.weekday < 0 || s.weekday > 6)
                throw Error('请选择星期');
        }
    }
    if (input.until) {
        s.until = localInstant(String(input.until), zone);
        if (s.until <= now)
            throw Error('授权截止时间必须在将来');
    }
    const next = nextTime(s, now);
    if (next === null)
        throw Error('授权期限内没有执行时间');
    return s;
}
export function nextTime(s, after) {
    let result = null;
    if (s.cadence === 'once')
        result = s.onceAt > after ? s.onceAt : null;
    else if (s.cadence === 'interval') {
        const step = s.intervalMinutes * 60000;
        result = s.anchor + Math.max(0, Math.floor((after - s.anchor) / step) + 1) * step;
    }
    else {
        const p = localParts(after, s.timezone), day = Date.UTC(p.year, p.month - 1, p.day);
        for (let i = 0; i < 16; i++) {
            const d = new Date(day + i * 86400000), weekday = d.getUTCDay();
            if (s.cadence === 'weekdays' && (weekday === 0 || weekday === 6) || s.cadence === 'weekly' && weekday !== s.weekday)
                continue;
            const value = `${d.toISOString().slice(0, 10)} ${s.time}`;
            try {
                const at = localInstant(value, s.timezone);
                if (at > after) {
                    result = at;
                    break;
                }
            }
            catch (e) {
                if (!String(e).includes('本地时间不存在'))
                    throw e;
            }
        }
    }
    return result !== null && s.until !== undefined && result >= s.until ? null : result;
}
export function scheduleLabel(s) { return ({ once: '单次', daily: '每天', weekdays: '工作日', weekly: `每周${['日', '一', '二', '三', '四', '五', '六'][s.weekday]}`, interval: `每 ${s.intervalMinutes} 分钟` })[s.cadence] + (s.time ? ' ' + s.time : s.onceAt ? ' ' + timeText(s.onceAt, s.timezone) : '') + ' · ' + s.timezone; }

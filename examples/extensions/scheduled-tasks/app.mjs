import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalize, nextTime, timeText, dateText, scheduleLabel } from './schedule.mjs';
const ACTIVE = new Set(['submitting', 'queued', 'running']);
const labels = { submitting: '正在提交', queued: '等待对话空闲', running: '执行中', completed: '本轮已结束（请查看结果）', failed: '执行失败', cancelled: '已取消', expired: '已过期', interrupted: '已中断，未自动重发', missed: '已错过', skipped: '上一轮尚未结束，已跳过', throttled: '距上次提交不足一分钟，已跳过' };
const presets = { checkin: '打开指定网站，先检查今日是否已经打卡；已完成则跳过，否则打卡一次并核验成功提示。登录失效、出现验证码或结果不确定时停止并说明，不重复提交。', report: '整理截至 {{scheduled_date}} 的项目进展，列出已完成事项、未解决问题和下一步建议。', review: '检查当前项目的近期修改，只报告已确认的问题及其证据，不自动修改文件。' };
const action = (id, label, values = {}) => ({ id, label, values });
/** Reuse the recurrence generator so catch-up has the same DST/anchor rules.
 * Only search the allowed delay window: at most 289 slots at the minimum interval. */
function latestDue(s, earliest, now) {
    let latest = null;
    let candidate = nextTime(s, Math.max(earliest - 1, now - s.graceMinutes * 60000 - 1));
    while (candidate !== null && candidate <= now) {
        latest = candidate;
        candidate = nextTime(s, candidate);
    }
    return latest;
}
export class Scheduler {
    constructor(services, { file, now = Date.now, interval = 1000 } = {}) {
        this.host = services.host;
        this.messages = services.messages;
        this.file = file ?? path.join(services.dataDirectory, 'tasks.json');
        this.now = now;
        this.interval = interval;
        this.fault = null;
        this.stopped = false;
        this.busy = false;
        this.state = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { version: 1, jobs: [] };
        if (this.state.version !== 1 || !Array.isArray(this.state.jobs) || this.state.jobs.length > 100)
            throw Error('定时任务数据格式不正确');
    }
    save() { if (this.fault)
        throw this.fault; const tmp = this.file + '.' + randomUUID() + '.tmp'; try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
        fs.writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600, flush: true });
        fs.renameSync(tmp, this.file);
    }
    catch (e) {
        this.fault = e;
        throw e;
    }
    finally {
        try {
            fs.unlinkSync(tmp);
        }
        catch { }
    } }
    sessions() { return this.host.snapshot().sessions.filter(s => s.kind === 'agent' && !s.readOnlyContext).map(s => ({ ...s, id: s.instanceId })); }
    target(id) { return this.sessions().find(s => s.id === id); }
    job(id, revision) { const job = this.state.jobs.find(j => j.id === id); if (!job || job.revision !== revision)
        throw Error('任务已变化，请刷新后重试'); return job; }
    grant(config, manual = false) { return { targetId: config.targetId, label: config.title, template: config.message, variables: ['scheduled_date', 'scheduled_time', 'triggered_time'], minIntervalMs: manual ? 0 : 60000, ...(manual || config.cadence === 'once' ? { maxRuns: 1 } : {}), ...(config.until ? { expiresAt: config.until } : {}) }; }
    sync() {
        let changed = false;
        for (const job of this.state.jobs)
            for (const run of job.runs) {
                if (!ACTIVE.has(run.state))
                    continue;
                const receipt = run.receiptId ? this.messages.status(run.receiptId) : this.messages.lookup(run.key);
                if (receipt) {
                    if (run.state !== receipt.state || !run.receiptId) {
                        run.receiptId = receipt.id;
                        run.state = receipt.state;
                        run.error = receipt.error;
                        changed = true;
                    }
                }
                else if (run.state === 'submitting') {
                    run.state = 'interrupted';
                    changed = true;
                }
            }
        if (changed)
            this.save();
    }
    addRun(job, run) { job.runs.unshift(run); job.runs = job.runs.filter((r, i) => i < 50 || ACTIVE.has(r.state)); }
    submit(job, at, grantId, key) {
        const now = this.now(), run = { key, at, targetId: job.config.targetId, grantId, submittedAt: now, state: 'submitting' };
        const values = { scheduled_date: dateText(at, job.config.timezone), scheduled_time: timeText(at, job.config.timezone), triggered_time: timeText(now, job.config.timezone) };
        this.addRun(job, run);
        this.save();
        try {
            const result = this.messages.submit({ grantId, key, values, expiresAt: Math.min(at + job.config.graceMinutes * 60000, job.config.until ?? Infinity) });
            run.receiptId = result.id;
            run.state = result.state;
        }
        catch (e) {
            run.state = 'failed';
            run.error = String(e);
            job.enabled = false;
        }
        this.save();
    }
    tick(recovering = false) {
        if (this.busy || this.stopped || this.fault)
            return;
        this.busy = true;
        try {
            this.sync();
            const now = this.now();
            for (const j of this.state.jobs) {
                if (!j.enabled || j.nextAt === null || j.nextAt > now)
                    continue;
                const at = j.config.missed === 'catchup' ? (latestDue(j.config, j.nextAt, now) ?? j.nextAt) : j.nextAt;
                j.nextAt = nextTime(j.config, now);
                if (j.nextAt === null)
                    j.enabled = false;
                if (!this.target(j.config.targetId)) {
                    j.enabled = false;
                    j.error = '目标对话不可用，任务已暂停';
                    this.save();
                    continue;
                }
                if (j.runs.some(r => ACTIVE.has(r.state))) {
                    this.addRun(j, { at, state: 'skipped', targetId: j.config.targetId });
                    this.save();
                    continue;
                }
                if (now - at > j.config.graceMinutes * 60000 || (j.config.missed === 'skip' && (recovering || now - at > 15000))) {
                    this.addRun(j, { at, state: 'missed', targetId: j.config.targetId });
                    this.save();
                    continue;
                }
                if (j.runs.some(r => r.grantId === j.grantId && r.submittedAt !== undefined && now - r.submittedAt < 60000)) {
                    this.addRun(j, { at, state: 'throttled', targetId: j.config.targetId });
                    this.save();
                    continue;
                }
                this.submit(j, at, j.grantId, j.id + ':' + j.revision + ':' + at);
            }
        }
        catch (e) {
            this.fault = e;
        }
        finally {
            this.busy = false;
        }
    }
    start() { this.tick(true); this.timer = setInterval(() => this.tick(), this.interval); this.timer.unref?.(); }
    stop() { this.stopped = true; clearInterval(this.timer); }
    revoke(job) { const ids = new Set([job.grantId, ...job.runs.filter(r => ACTIVE.has(r.state)).map(r => r.grantId)]); for (const id of ids)
        if (id)
            this.messages.revoke(id); }
    view() { this.sync(); return { actions: [action('new', '新建任务'), action('templates', '使用模板')], note: this.fault ? '存储或服务异常，调度已停止：' + String(this.fault) : '任务在电脑上运行 · 需保持电脑唤醒和 asHub 后台在线', rows: this.state.jobs.map(j => ({ title: j.config.title, detail: `${this.target(j.config.targetId) ? (this.target(j.config.targetId).title || '未命名对话') : '对话不可用'} · ${scheduleLabel(j.config)}\n${j.enabled && j.nextAt ? `下次 ${timeText(j.nextAt, j.config.timezone)}` : '已暂停或计划已结束'}`, status: j.error ?? (j.runs[0] ? labels[j.runs[0].state] ?? j.runs[0].state : '尚未执行'), actions: [action('edit', '编辑', { id: j.id, revision: j.revision }), action(j.enabled ? 'pause' : 'resume', j.enabled ? '暂停' : '恢复', { id: j.id, revision: j.revision }), action('run', '立即执行一次', { id: j.id, revision: j.revision }), action('history', '运行记录', { id: j.id, revision: j.revision }), action('delete', '删除', { id: j.id, revision: j.revision })] })) }; }
    editor(job, template) {
        const c = job?.config ?? { title: '', targetId: '', message: presets[template] ?? '', cadence: 'daily', time: '09:00', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, missed: 'skip', graceMinutes: 30, weekday: 1, intervalMinutes: 60 };
        const field = (id, label, type, value, extra = {}) => ({ id, label, type, value, ...extra });
        const sessions = this.sessions().map(s => ({ value: s.id, label: s.title || s.id }));
        if (c.targetId && !sessions.some(s => s.value === c.targetId))
            sessions.push({ value: c.targetId, label: '原对话不可用' });
        return { actions: [action('list', '返回任务列表')], rows: [], note: '保存后核对具体规则和消息内容，再确认授权。任务执行中的工具权限保持不变。', form: { action: 'save', submit: '预览并确认', values: job ? { id: job.id, revision: job.revision } : {}, fields: [
                    field('title', '任务名称', 'text', c.title), field('targetId', '目标对话', 'select', c.targetId, { options: [{ value: '', label: '请选择对话' }, ...sessions] }), field('message', '执行内容', 'textarea', c.message),
                    field('cadence', '重复规则', 'select', c.cadence, { options: [['once', '单次'], ['daily', '每天'], ['weekdays', '工作日'], ['weekly', '每周'], ['interval', '固定间隔']].map(([value, label]) => ({ value, label })) }),
                    field('time', '执行时间', 'time', c.time ?? '09:00', { when: { field: 'cadence', values: ['daily', 'weekdays', 'weekly'] } }),
                    field('onceAt', '执行日期与时间', 'datetime-local', c.onceAt ? timeText(c.onceAt, c.timezone).replace(' ', 'T') : '', { when: { field: 'cadence', values: ['once'] } }),
                    field('weekday', '星期', 'select', String(c.weekday ?? 1), { when: { field: 'cadence', values: ['weekly'] }, options: ['日', '一', '二', '三', '四', '五', '六'].map((d, i) => ({ value: String(i), label: '星期' + d })) }),
                    field('intervalMinutes', '间隔（分钟，最少 5 分钟）', 'number', c.intervalMinutes ?? 60, { when: { field: 'cadence', values: ['interval'] } }),
                    field('timezone', '时区', 'text', c.timezone, { advanced: true }), field('missed', '错过执行时间', 'select', c.missed, { advanced: true, options: [{ value: 'skip', label: '跳过本次' }, { value: 'catchup', label: '期限内补执行一次' }] }),
                    field('graceMinutes', '允许延迟（分钟，含等待对话空闲）', 'number', c.graceMinutes, { advanced: true }), field('until', '授权截止（可选）', 'datetime-local', c.until ? timeText(c.until, c.timezone).replace(' ', 'T') : '', { advanced: true }),
                ] } };
    }
    prepare(actionId, input) {
        if (this.fault)
            throw Error('调度已停止，请先解决存储或服务错误');
        const simple = view => ({ execute: () => view });
        if (actionId === 'list')
            return simple(this.view());
        if (actionId === 'new')
            return simple(this.editor(undefined, input.template));
        if (actionId === 'templates')
            return simple({ refresh: false, actions: [action('list', '返回')], note: '选择模板后补充具体网站、范围和核验要求', rows: [['checkin', '每日打卡'], ['report', '项目日报'], ['review', '代码检查']].map(([template, title]) => ({ title, actions: [action('new', '使用', { template })] })) });
        const job = input.id ? this.job(input.id, input.revision) : undefined;
        if (actionId === 'edit' && job)
            return simple(this.editor(job));
        if (actionId === 'history' && job) {
            this.sync();
            return simple({ refresh: false, actions: [action('list', '返回')], note: '“本轮已结束”不代表业务结果已核验；请进入目标对话查看。', rows: job.runs.map(r => ({ title: timeText(r.at, job.config.timezone), status: labels[r.state] ?? r.state, detail: r.error ?? '', conversationId: r.targetId, actions: [] })) });
        }
        if (actionId === 'save') {
            if (!job && this.state.jobs.length >= 100)
                throw Error('最多保存 100 个任务');
            const config = normalize(input, this.now()), nextAt = nextTime(config, this.now());
            if (!this.target(config.targetId))
                throw Error('目标对话不可用');
            return { authorization: this.grant(config), preview: { title: job ? '确认修改定时任务' : '确认新建定时任务', fields: [{ label: '名称', value: config.title }, { label: '时间规则', value: scheduleLabel(config) }, { label: '下一次执行', value: timeText(nextAt, config.timezone) }, { label: '错过与排队', value: `${config.missed === 'skip' ? '错过则跳过' : '期限内最多补执行一次'}；延迟上限 ${config.graceMinutes} 分钟；同任务不重叠执行` }] }, execute: grantId => {
                    if (nextAt <= this.now())
                        throw Error('计划时间已过去，请重新确认');
                    if (job) {
                        this.job(job.id, input.revision);
                        this.revoke(job);
                    }
                    else if (this.state.jobs.length >= 100)
                        throw Error('任务数量已达到上限');
                    const next = { id: job?.id ?? randomUUID(), revision: randomUUID(), config, grantId, nextAt, enabled: true, runs: job?.runs ?? [] };
                    if (job)
                        this.state.jobs[this.state.jobs.indexOf(job)] = next;
                    else
                        this.state.jobs.push(next);
                    this.save();
                    return this.view();
                } };
        }
        if (!job)
            throw Error('任务不存在');
        const check = () => this.job(job.id, input.revision);
        if (actionId === 'pause' || actionId === 'delete')
            return { preview: { title: actionId === 'pause' ? '暂停任务' : '删除任务', fields: [{ label: '任务', value: job.config.title }, { label: '影响', value: '取消尚未开始的投递；已经开始的对话任务继续执行' }] }, execute: () => { check(); this.revoke(job); if (actionId === 'delete')
                    this.state.jobs = this.state.jobs.filter(j => j !== job);
                else {
                    job.enabled = false;
                    job.revision = randomUUID();
                } this.save(); return this.view(); } };
        if (actionId === 'resume') {
            const at = nextTime(job.config, this.now());
            if (at === null)
                throw Error('计划已结束，请编辑新的执行时间');
            return { authorization: this.grant(job.config), preview: { title: '恢复任务', fields: [{ label: '下次执行', value: timeText(at, job.config.timezone) }] }, execute: grantId => { check(); if (at <= this.now())
                    throw Error('计划时间已过去，请重试'); this.revoke(job); job.grantId = grantId; job.nextAt = at; job.enabled = true; job.error = undefined; job.revision = randomUUID(); this.save(); return this.view(); } };
        }
        if (actionId === 'run') {
            this.sync();
            if (job.runs.some(r => ACTIVE.has(r.state)))
                throw Error('该任务已有一轮等待或执行中');
            const key = 'manual:' + randomUUID();
            return { authorization: this.grant(job.config, true), preview: { title: '立即执行一次', fields: [{ label: '任务', value: job.config.title }, { label: '时间', value: '不改变原定时计划；对话忙碌时等待空闲' }] }, execute: grantId => { check(); this.sync(); if (job.runs.some(r => ACTIVE.has(r.state)))
                    throw Error('该任务已有一轮等待或执行中'); this.submit(job, this.now(), grantId, key); return this.view(); } };
        }
        throw Error('不支持的任务操作');
    }
}
export default function activate(ctx) {
    const scheduler = new Scheduler(ctx.services);
    ctx.onDispose(() => scheduler.stop());
    const dispose = ctx.services.interactions.register('tasks', { view: () => scheduler.view(), prepare: (action, values) => scheduler.prepare(action, values) });
    ctx.onDispose(dispose);
    scheduler.start();
    return { stop: () => scheduler.stop() };
}

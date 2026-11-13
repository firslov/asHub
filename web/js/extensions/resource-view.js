const node = (tag, cls = '', text) => { const e = document.createElement(tag); e.className = cls; if (text !== undefined)
    e.textContent = text; return e; };
import { lang } from '../i18n.js';
const local = (zh, en) => lang.value === 'zh' ? zh : en;
const fieldId = v => typeof v === 'string' && /^[a-z][a-zA-Z0-9-]{0,79}$/.test(v);
let noticeSequence = 0;
const id = v => typeof v === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(v);
const text = (v, max = 8000) => typeof v === 'string' && v.length <= max;
export function validateResourceView(v) {
    if (!v || JSON.stringify(v).length > 262144 || !Array.isArray(v.rows) || v.rows.length > 100 || !Array.isArray(v.actions) || v.actions.length > 8)
        throw Error('Invalid plugin view');
    const action = a => { if (!a || !id(a.id) || !text(a.label, 120) || !a.values || typeof a.values !== 'object' || Array.isArray(a.values))
        throw Error('Invalid plugin action'); };
    if (v.openConversation !== undefined && (!text(v.openConversation,100) || !/^[-a-zA-Z0-9]+$/.test(v.openConversation)))
        throw Error('Invalid conversation reference');
    v.actions.forEach(action);
    if (v.toggle !== undefined && (!v.toggle || !text(v.toggle.label,120) || typeof v.toggle.checked !== 'boolean' || !id(v.toggle.action) || (v.toggle.status !== undefined && !text(v.toggle.status,160))))
        throw Error('Invalid resource toggle');
    for (const r of v.rows) {
        if (r.conversationId !== undefined && (!text(r.conversationId, 100) || !/^[-a-zA-Z0-9]+$/.test(r.conversationId)))
            throw Error('Invalid conversation reference');
        if (!text(r.title, 200) || !text(r.detail ?? '') || !text(r.status ?? '', 300) || !Array.isArray(r.actions) || r.actions.length > 8)
            throw Error('Invalid plugin row');
        r.actions.forEach(action);
        if (r.primaryAction !== undefined && !id(r.primaryAction))
            throw Error('Invalid primary resource action');
    }
    if (v.form) {
        if (!id(v.form.action) || !Array.isArray(v.form.fields) || v.form.fields.length > 20 || !text(v.form.submit, 100) || !v.form.values || typeof v.form.values !== 'object')
            throw Error('Invalid plugin form');
        const ids = new Set();
        for (const f of v.form.fields) {
            if (!fieldId(f.id) || ids.has(f.id) || !text(f.label, 200) || !['text', 'password', 'textarea', 'number', 'select', 'checkbox', 'time', 'datetime-local'].includes(f.type) || !['string', 'number', 'boolean', 'undefined'].includes(typeof f.value))
                throw Error('Invalid plugin field');
            ids.add(f.id);
            if (f.when && (!fieldId(f.when.field) || !Array.isArray(f.when.values) || !f.when.values.every(v => text(v, 100))))
                throw Error('Invalid field condition');
            // The enclosing view size bounds option lists, including large live conversation catalogs.
            if (f.type === 'select' && (!Array.isArray(f.options) || !f.options.every(o => text(o.value, 200) && text(o.label, 200))))
                throw Error('Invalid plugin options');
        }
    }
    if (v.refresh !== undefined && typeof v.refresh !== 'boolean')
        throw Error('Invalid refresh policy');
    if (v.note !== undefined && !text(v.note))
        throw Error('Invalid plugin note');
    return v;
}
/** Generic bounded records/forms/actions; all content is text, never plugin HTML. */
export function mountResource(container, feature, resourceId, options = {}) {
    const base = `/api/plugin-resources/${encodeURIComponent(feature.pluginId)}/${encodeURIComponent(resourceId)}`;
    let disposed = false, busy = false, refreshing = true, view, editing = false, epoch = 0;
    let reviewDialog = null;
    const noticeId = 'resource-toggle-status-' + (++noticeSequence);
    const restoreToggleFocus = () => queueMicrotask(() => {
        // Replacing a switch or removing its dialog loses focus. Restore only
        // while focus is unclaimed; a late response must not steal it elsewhere.
        if (options.inlineToggle && !disposed && !reviewDialog && document.activeElement === document.body)
            content.querySelector('button:not(:disabled)')?.focus();
    });
    const closeReview = () => { const d=reviewDialog, focused=d?.contains(document.activeElement); reviewDialog=null; if(d?.contains(feedback))container.append(feedback); d?.remove(); if(focused)restoreToggleFocus(); };
    const abort = new AbortController();
    const feedback = node('p', 'plugins-message');
    feedback.setAttribute('role', 'status');
    feedback.setAttribute('aria-live', 'polite');
    const content = node('div', 'extension-resource');
    container.append(content, feedback);
    if(options.inlineToggle)container.classList.add('resource-toggle-host');
    const request = async (body) => {
        // Only reads get a deadline: an uncertain mutation must never be retried as a read.
        const deadline = body ? null : new AbortController();
        const timer = deadline ? setTimeout(() => deadline.abort(new Error(local('读取超时，稍后自动重试', 'Read timed out; retrying shortly'))), 15000) : undefined;
        try {
            const signal = deadline ? AbortSignal.any([abort.signal, deadline.signal]) : abort.signal;
            if(options.request) return await options.request(body,signal);
            const response = await fetch(base, { signal, method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
            const data = await response.json();
            if (!response.ok)
                throw Error(data.error || 'Plugin unavailable');
            return data;
        }
        finally {
            clearTimeout(timer);
        }
    };
    const button = (a) => { const b = node('button', 'p-btn extension-resource-action', a.label); b.type = 'button'; b.addEventListener('click', () => void send({ action: a.id, values: a.values })); return b; };
    const display = data => {
        if (disposed)
            return;
        feedback.textContent = '';
        if (data.confirmation) {
            editing = true;
            let target=content;
            if(options.inlineToggle){
                closeReview();
                const d=node('dialog','resource-toggle-confirm');reviewDialog=d;
                target=node('div','extension-resource');d.append(target,feedback);document.body.append(d);
                d.addEventListener('keydown',event=>event.stopPropagation());
                d.addEventListener('cancel',event=>{event.preventDefault();if(!busy){closeReview();editing=false;render(view);}});
                d.showModal();
            } else content.replaceChildren();
            const p = data.confirmation.preview;
            const title = node('h3', 'extension-resource-title', p.title);
            title.id = noticeId + '-title';
            target.append(title);
            reviewDialog?.setAttribute('aria-labelledby', title.id);
            const review = fields => {
                const dl = node('dl', 'extension-resource-review');
                for (const f of fields) dl.append(node('dt', '', f.label), node('dd', '', f.value));
                return dl;
            };
            target.append(review(p.fields));
            if (Array.isArray(p.details) && p.details.length) {
                const details = node('details', 'extension-authorization-details');
                details.append(node('summary', '', local('授权详情', 'Authorization details')), review(p.details));
                target.append(details);
            }
            const actions = node('div', 'extension-resource-actions extension-resource-confirm');
            const yes = node('button', 'p-btn-primary', local('确认', 'Confirm')), no = node('button', 'p-btn', local('取消', 'Cancel'));
            yes.type = no.type = 'button';
            yes.addEventListener('click', () => void send({ confirm: data.confirmation.id }));
            no.addEventListener('click', () => { closeReview(); editing = false; render(view); });
            actions.append(no, yes);
            target.append(actions);
            yes.focus();
            return;
        }
        const next = validateResourceView(data.view);
        closeReview();
        if (!editing && view && JSON.stringify(next) === JSON.stringify(view))
            return;
        view = next;
        render(view);
    };
    const send = async (body) => {
        if (busy || disposed)
            return;
        const focused = content.contains(document.activeElement) || reviewDialog?.contains(document.activeElement);
        busy = true;
        ++epoch;
        feedback.textContent = '';
        content.setAttribute('aria-busy', 'true');
        for (const e of [...content.querySelectorAll('button,input,select,textarea'),...(reviewDialog?.querySelectorAll('button,input,select,textarea')??[])])
            e.disabled = true;
        try {
            const data = await request(body);
            busy = false;
            display(data);
            if (!disposed && !data.confirmation && data.view?.openConversation && options.onComplete)
                await options.onComplete(data.view.openConversation);
        }
        catch (e) {
            if (!disposed) {
                feedback.textContent = e.message;

            }
        }
        finally {
            busy = false;
            content.removeAttribute('aria-busy');
            // An unchanged response may reuse the DOM; restore only applicable controls.
            for (const el of [...content.querySelectorAll('button,input,select,textarea'),...(reviewDialog?.querySelectorAll('button,input,select,textarea')??[])])
                el.disabled = el.dataset.unavailable === 'true' || (!!reviewDialog && content.contains(el)) || !!el.closest('label[hidden]');
            if (focused) restoreToggleFocus();
        }
    };
    const render = v => {
        if (!v || disposed)
            return;
        const focused = content.contains(document.activeElement);
        content.replaceChildren();
        editing = !!v.form || v.refresh === false;
        if(options.inlineToggle){
            if(v.toggle){
                const a=v.actions.find(a=>a.id===v.toggle.action),b=node('button','resource-inline-toggle');
                b.type='button';b.setAttribute('role','switch');b.setAttribute('aria-label',v.toggle.label);b.setAttribute('aria-checked',String(v.toggle.checked));
                b.disabled=!a;b.dataset.unavailable=String(!a);
                b.title=v.toggle.label+' · '+local(v.toggle.checked?'已开启':'已关闭',v.toggle.checked?'On':'Off')+(v.toggle.status?' · '+v.toggle.status:'')+(!a?' · '+(v.note||local('当前不可更改','Currently unavailable')):'');
                b.addEventListener('click',()=>{if(a)void send({action:a.id,values:a.values});});
                content.append(b);
                if(v.toggle.status){
                    const status=node('span','resource-inline-status',v.toggle.status);status.id=noticeId;status.setAttribute('role','status');status.setAttribute('aria-live','polite');
                    b.setAttribute('aria-describedby',noticeId);content.append(status);
                }
            }else{
                const b=node('button','resource-inline-setup','···');b.type='button';b.setAttribute('aria-label',local('设置对话','Set up conversation'));b.onclick=()=>options.onManage?.();content.append(b);
            }
            if (focused) restoreToggleFocus();
            return;
        }
        const actions = node('div', 'extension-resource-actions');
        for (const [index, a] of v.actions.entries()) {
            const control = button(a);
            if (index === 0 && v.actions.length > 1) control.classList.replace('p-btn', 'p-btn-primary');
            actions.append(control);
        }
        content.append(actions);
        if (v.note)
            content.append(node('p', 'extension-text extension-resource-note', v.note));
        if (v.form) {
            const form = node('form', 'extension-resource-form'), controls = new Map(), conditions = [];
            const advanced = node('details', 'extension-resource-advanced');
            advanced.append(node('summary', '', local('高级选项', 'Advanced')));
            for (const f of v.form.fields) {
                const label = node('label', 'plugin-config-label', f.label), control = node(f.type === 'textarea' ? 'textarea' : f.type === 'select' ? 'select' : 'input', 'p-input extension-field');
                if (f.type === 'select')
                    for (const o of f.options) {
                        const opt = node('option', '', o.label);
                        opt.value = o.value;
                        control.append(opt);
                    }
                else if (f.type !== 'textarea')
                    control.type = f.type;
                if (f.type === 'checkbox')
                    control.checked = f.value === true;
                else
                    control.value = f.type === 'password' ? '' : String(f.value ?? '');
                if(f.type === 'password') control.autocomplete = 'current-password';
                if (f.type === 'textarea') {
                    control.rows = 4;
                    control.maxLength = 8000;
                }
                label.append(control);
                (f.advanced ? advanced : form).append(label);
                controls.set(f.id, { control, type: f.type });
                if (f.when)
                    conditions.push({ label, when: f.when });
            }
            const visibility = () => {
                for (const { label, when } of conditions) {
                    label.hidden = !when.values.includes(String(controls.get(when.field)?.control.value));
                    // Hidden alternatives must not participate in browser form validation.
                    for (const control of label.querySelectorAll('input,select,textarea'))
                        control.disabled = label.hidden || busy;
                }
            };
            form.addEventListener('change', visibility);
            visibility();
            if (advanced.children.length > 1)
                form.append(advanced);
            const save = node('button', 'p-btn-primary', v.form.submit);
            save.type = 'submit';
            form.append(save);
            form.addEventListener('submit', e => { e.preventDefault(); for (const f of v.form.fields) {
                const { control, type } = controls.get(f.id);
                f.value = type === 'checkbox' ? control.checked : control.value;
            } const values = { ...v.form.values }; for (const [key, { control, type }] of controls)
                values[key] = type === 'checkbox' ? control.checked : type === 'number' ? Number(control.value) : control.value; void send({ action: v.form.action, values }); });
            content.append(form);
        }
        const rows = node('div', 'extension-resource-rows');
        for (const r of v.rows) {
            const row = node('article', 'extension-resource-row');
            row.append(node('h3', 'extension-resource-title', r.title));
            if (r.detail)
                row.append(node('p', 'extension-resource-detail', r.detail));
            if (r.status)
                row.append(node('p', 'extension-resource-status', r.status));
            if (r.conversationId) {
                const link = node('a', 'extension-resource-link', local('查看对话', 'Open conversation'));
                link.href = '/' + encodeURIComponent(r.conversationId);
                if(options.openConversation) link.addEventListener('click',e=>{e.preventDefault();options.openConversation(r.conversationId);});
                row.append(link);
            }
            // Reference an existing action; presentation never adds authority.
            const primary = r.actions.find(a => a.id === r.primaryAction);
            if (primary) row.append(button(primary));
            const secondary = r.actions.filter(a => a !== primary);
            const menu = node('details', 'extension-resource-menu');
            const summary = node('summary', '', local('更多', 'More'));
            menu.append(summary);
            const menuActions = node('div', 'extension-resource-menu-actions');
            for (const a of secondary)
                menuActions.append(button(a));
            menu.append(menuActions);
            if (secondary.length)
                row.append(menu);
            rows.append(row);
        }
        content.append(rows);
    };
    const refresh = async () => {
        if (disposed || busy || refreshing || editing || document.hidden || container.closest('[hidden]'))
            return;
        refreshing = true;
        const token = ++epoch;
        try {
            const data = await request();
            if (token === epoch && !busy && !editing)
                display(data);
        }
        catch (e) {
            // Errors belong to the same request generation as successful snapshots.
            if (!disposed && token === epoch && !busy && !editing)
                feedback.textContent = e.message;
        }
        finally {
            refreshing = false;
        }
    };
    // Initial load even while the drawer is closed; refresh only visible idle views.
    const initial = ++epoch;
    void request().then(data => { if (initial === epoch)
        display(data); }).catch(e => { if (!disposed && initial === epoch)
        feedback.textContent = e.message; }).finally(() => { refreshing = false; });
    const timer = setInterval(() => void refresh(), 5000);
    return () => { disposed = true; ++epoch; abort.abort(); clearInterval(timer); closeReview(); content.remove(); feedback.remove(); };
}

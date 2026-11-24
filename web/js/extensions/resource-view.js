const node = (tag, cls = '', text) => { const e = document.createElement(tag); e.className = cls; if (text !== undefined)
    e.textContent = text; return e; };
import { lang } from '../i18n.js';
const local = (zh, en) => lang.value === 'zh' ? zh : en;
const fieldId = v => typeof v === 'string' && /^[a-z][a-zA-Z0-9-]{0,79}$/.test(v);
let noticeSequence = 0;
const id = v => typeof v === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(v);
const text = (v, max = 8000) => typeof v === 'string' && v.length <= max;
const validQr = qr => {
    const size = qr?.modules?.length;
    return text(qr?.label, 120) && Array.isArray(qr.modules) && size >= 21 && size <= 177 && (size - 21) % 4 === 0 &&
        qr.modules.every(row => typeof row === 'string' && row.length === size && /^[01]+$/.test(row));
};

function renderQr(qr) {
    const figure = node('figure', 'extension-resource-qr');
    const canvas = node('canvas');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', local('二维码', 'QR code'));
    const quiet = 4, size = qr.modules.length + quiet * 2, pixels = Math.max(2, Math.floor(132 / size));
    canvas.width = canvas.height = size * pixels;
    const drawing = canvas.getContext('2d');
    if (!drawing) return figure;
    drawing.fillStyle = '#fff';
    drawing.fillRect(0, 0, canvas.width, canvas.height);
    drawing.fillStyle = '#000';
    qr.modules.forEach((row, y) => {
        for (let x = 0; x < row.length; x++) if (row[x] === '1') drawing.fillRect((x + quiet) * pixels, (y + quiet) * pixels, pixels, pixels);
    });
    figure.append(canvas, node('figcaption', '', qr.label));
    return figure;
}
export function validateResourceView(v) {
    if (!v || JSON.stringify(v).length > 262144 || !Array.isArray(v.rows) || v.rows.length > 100 || !Array.isArray(v.actions) || v.actions.length > 8)
        throw Error('Invalid plugin view');
    const action = a => { if (!a || !id(a.id) || !text(a.label, 120) || !a.values || typeof a.values !== 'object' || Array.isArray(a.values))
        throw Error('Invalid plugin action'); if (a.pendingLabel !== undefined && !text(a.pendingLabel, 200)) throw Error('Invalid pending label'); if (a.copyText !== undefined && !text(a.copyText)) throw Error('Invalid clipboard text'); };
    if (v.openConversation !== undefined && (!text(v.openConversation,100) || !/^[-a-zA-Z0-9]+$/.test(v.openConversation)))
        throw Error('Invalid conversation reference');
    v.actions.forEach(action);
    if (v.manage !== undefined && typeof v.manage !== 'boolean') throw Error('Invalid resource options');
    if (v.toggle !== undefined && (!v.toggle || !text(v.toggle.label,120) || typeof v.toggle.checked !== 'boolean' || !id(v.toggle.action) || (v.toggle.status !== undefined && !text(v.toggle.status,160))))
        throw Error('Invalid resource toggle');
    for (const r of v.rows) {
        if ((r.section !== undefined && !text(r.section, 120)) || (r.inlineActions !== undefined && typeof r.inlineActions !== 'boolean')) throw Error('Invalid row presentation');
        if (r.qr !== undefined && !validQr(r.qr)) throw Error('Invalid QR code');
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
            if (!fieldId(f.id) || ids.has(f.id) || !text(f.label, 200) || !['text', 'password', 'textarea', 'number', 'select', 'checkbox', 'time', 'datetime-local', 'directories'].includes(f.type) || !['string', 'number', 'boolean', 'undefined'].includes(typeof f.value))
                throw Error('Invalid plugin field');
            ids.add(f.id);
            if (f.when && (!fieldId(f.when.field) || !Array.isArray(f.when.values) || !f.when.values.every(v => text(v, 100))))
                throw Error('Invalid field condition');
            // The enclosing view size bounds option lists, including large live conversation catalogs.
            if (f.type === 'select' && (!Array.isArray(f.options) || !f.options.every(o => text(o.value, 200) && text(o.label, 200))))
                throw Error('Invalid plugin options');
        }
        if (v.form.compact !== undefined && typeof v.form.compact !== 'boolean')
            throw Error('Invalid form presentation');
        const guidance = v.form.guidance;
        if (guidance !== undefined) {
            if (!Array.isArray(guidance) || guidance.length > 8)
                throw Error('Invalid form guidance');
            for (const g of guidance) {
                if (!g || !text(g.detail, 2400) || (g.summary !== undefined && !text(g.summary, 120)) || (g.after !== undefined && !ids.has(g.after)))
                    throw Error('Invalid form guidance');
                const when = g.when;
                if (when !== undefined && (!ids.has(when?.field) || !Array.isArray(when?.values) || !when.values.every(v => text(v, 100))))
                    throw Error('Invalid form guidance condition');
            }
        }
    }
    if (v.refresh !== undefined && typeof v.refresh !== 'boolean')
        throw Error('Invalid refresh policy');
    if (v.note !== undefined && !text(v.note))
        throw Error('Invalid plugin note');
    if (v.title !== undefined && (!text(v.title, 120) || !v.title.trim()))
        throw Error('Invalid plugin resource title');
    return v;
}
/** Generic bounded records/forms/actions; all content is text, never plugin HTML. */
export function mountResource(container, feature, resourceId, options = {}) {
    const base = `/api/plugin-resources/${encodeURIComponent(feature.pluginId)}/${encodeURIComponent(resourceId)}`;
    let disposed = false, busy = false, refreshing = true, view, editing = false, epoch = 0;
    let reviewDialog = null, reviewing = false, renderedLocale, readDraft, reviewDraft;
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
    const request = async (body, locale = lang.value) => {
        // Only reads get a deadline: an uncertain mutation must never be retried as a read.
        const deadline = body ? null : new AbortController();
        const timer = deadline ? setTimeout(() => deadline.abort(new Error(local('读取超时，稍后自动重试', 'Read timed out; retrying shortly'))), 15000) : undefined;
        try {
            const signal = deadline ? AbortSignal.any([abort.signal, deadline.signal]) : abort.signal;
            if(options.request) return await options.request(body,signal);
            const headers = { 'X-Ashub-Locale': locale, ...(body ? { 'Content-Type': 'application/json' } : {}) };
            const response = await fetch(base, { signal, method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined });
            const data = await response.json();
            if (!response.ok)
                throw Error(data.error || 'Plugin unavailable');
            return data;
        }
        finally {
            clearTimeout(timer);
        }
    };
    const button = (a) => { const b = node('button', 'p-btn extension-resource-action', a.label); b.type = 'button'; b.addEventListener('click', async () => {
        if (a.copyText === undefined) { void send({ action: a.id, values: a.values }, a.pendingLabel); return; }
        try { await navigator.clipboard.writeText(a.copyText); if (!disposed) feedback.textContent = local('已复制', 'Copied'); }
        catch { if (!disposed) feedback.textContent = local('复制失败，请手动复制显示的地址', 'Copy failed; copy the displayed address manually'); }
    }); return b; };
    const cancelReview = () => {
        const draft = reviewDraft;
        reviewDraft = undefined;
        closeReview(); reviewing = false; editing = false;
        render(view, draft);
        syncLocale();
    };
    const display = (data, locale, draft) => {
        if (disposed)
            return;
        feedback.textContent = '';
        if (data.confirmation) {
            reviewing = true;
            reviewDraft = readDraft?.();
            editing = true;
            let target=content;
            if(options.inlineToggle){
                closeReview();
                const d=node('dialog','resource-toggle-confirm');reviewDialog=d;
                target=node('div','extension-resource resource-toggle-review');
                target.tabIndex=0;
                target.setAttribute('role','region');
                target.setAttribute('aria-label',local('授权说明','Authorization summary'));
                d.addEventListener('keydown',event=>event.stopPropagation());
                d.addEventListener('cancel',event=>{event.preventDefault();if(!busy)cancelReview();});
            } else content.replaceChildren();
            const p = data.confirmation.preview;
            const title = node('h3', 'extension-resource-title', p.title);
            title.id = noticeId + '-title';
            if (!reviewDialog) target.append(title);
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
            no.addEventListener('click', cancelReview);
            actions.append(no, yes);
            if (reviewDialog) {
                const footer = node('div', 'resource-toggle-footer');
                footer.append(feedback, actions);
                reviewDialog.setAttribute('aria-labelledby', title.id);
                reviewDialog.append(title, target, footer);
                document.body.append(reviewDialog);
                reviewDialog.showModal();
            } else target.append(actions);
            yes.focus({ preventScroll: !!reviewDialog });
            return;
        }
        const next = validateResourceView(data.view);
        closeReview();
        reviewing = false;
        reviewDraft = undefined;
        renderedLocale = locale;
        options.onTitle?.(next.title);
        if (!editing && view && JSON.stringify(next) === JSON.stringify(view))
            return;
        view = next;
        render(view, draft);
    };
    const send = async (body, pendingLabel) => {
        if (busy || disposed)
            return;
        const focused = content.contains(document.activeElement) || reviewDialog?.contains(document.activeElement);
        const locale = lang.value;
        busy = true;
        ++epoch;
        feedback.textContent = pendingLabel || '';
        content.setAttribute('aria-busy', 'true');
        for (const e of [...content.querySelectorAll('button,input,select,textarea'),...(reviewDialog?.querySelectorAll('button,input,select,textarea')??[])])
            e.disabled = true;
        try {
            const data = await request(body, locale);
            busy = false;
            display(data, locale);
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
                el.disabled = el.dataset.unavailable === 'true' || (!!reviewDialog && content.contains(el)) || !!el.closest('.plugin-config-label[hidden]');
            if (focused) restoreToggleFocus();
            syncLocale();
        }
    };
    const render = (v, draft) => {
        if (!v || disposed)
            return;
        const focused = content.contains(document.activeElement);
        content.replaceChildren();
        const compact = v.form?.compact === true;
        content.classList.toggle('extension-resource-compact', compact);
        readDraft = undefined;
        editing = !!v.form || v.refresh === false;
        if(options.inlineToggle){
            if(v.toggle){
                const a=v.actions.find(a=>a.id===v.toggle.action),b=node('button','resource-inline-toggle');
                b.type='button';b.setAttribute('role','switch');b.setAttribute('aria-label',v.toggle.label);b.setAttribute('aria-checked',String(v.toggle.checked));
                b.disabled=!a;b.dataset.unavailable=String(!a);
                b.title=v.toggle.label+' · '+local(v.toggle.checked?'已开启':'已关闭',v.toggle.checked?'On':'Off')+(v.toggle.status?' · '+v.toggle.status:'')+(!a?' · '+(v.note||local('当前不可更改','Currently unavailable')):'');
                b.addEventListener('click',()=>{if(a)void send({action:a.id,values:a.values});});
                content.append(b);
                if(v.manage && options.onManage && v.actions.some(a=>a.id!==v.toggle.action)) {
                    const manage=node('button','resource-inline-setup resource-inline-manage','···');
                    manage.type='button';manage.setAttribute('aria-label',local('对话选项','Conversation options'));manage.setAttribute('aria-haspopup','dialog');
                    manage.onclick=()=>options.onManage();
                    content.append(manage);
                }
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
        if (!compact) content.append(actions);
        if (v.note)
            content.append(node('p', 'extension-text extension-resource-note', v.note));
        if (v.form) {
            const form = node('form', 'extension-resource-form'), controls = new Map(), conditions = [];
            const advanced = node('details', 'extension-resource-advanced');
            advanced.append(node('summary', '', local('高级选项', 'Advanced')));
            const appendGuidance = (target, after) => {
                for (const g of v.form.guidance ?? []) {
                    if (g.after !== after) continue;
                    const detail = node('p', 'extension-resource-detail', g.detail);
                    const element = g.summary ? node('details', 'extension-resource-menu extension-resource-guidance') : detail;
                    if (g.summary) element.append(node('summary', '', g.summary), detail);
                    target.append(element);
                    if (g.when) conditions.push({ element, when: g.when });
                }
            };
            for (const f of v.form.fields) {
                const label = node(f.type === 'directories' ? 'div' : 'label', 'plugin-config-label', f.label), control = node(f.type === 'textarea' || f.type === 'directories' ? 'textarea' : f.type === 'select' ? 'select' : 'input', 'p-input extension-field');
                if (f.type === 'select')
                    for (const o of f.options) {
                        const opt = node('option', '', o.label);
                        opt.value = o.value;
                        control.append(opt);
                    }
                else if (f.type !== 'textarea' && f.type !== 'directories')
                    control.type = f.type;
                if (f.type === 'checkbox')
                    control.checked = f.value === true;
                else
                    control.value = f.type === 'password' ? '' : String(f.value ?? '');
                const saved = draft?.action === v.form.action ? draft.fields.get(f.id) : undefined;
                if (saved?.type === f.type) {
                    if (f.type === 'checkbox') control.checked = saved.value;
                    else if (f.type !== 'select' || f.options.some(o => o.value === saved.value)) control.value = saved.value;
                }
                if(f.type === 'password') control.autocomplete = 'current-password';
                if (f.type === 'textarea') {
                    control.rows = 4;
                    control.maxLength = 8000;
                }
                label.append(control);
                if (f.type === 'directories') {
                    control.setAttribute('aria-label', f.label);
                    const list = node('div', 'extension-directory-list');
                    const paths = () => [...new Set(control.value.split('\n').map(p => p.trim()).filter(Boolean))];
                    const draw = () => {
                        list.replaceChildren();
                        for (const value of paths()) {
                            const row = node('div', 'extension-directory-row'), remove = node('button', 'p-btn', local('移除', 'Remove'));
                            remove.type = 'button'; remove.setAttribute('aria-label', local('移除 ', 'Remove ') + value);
                            remove.onclick = () => { control.value = paths().filter(p => p !== value).join('\n'); draw(); };
                            const displayedPath = node('span', 'extension-directory-path');
                            for (const part of value.split(/(?<=[/\\])(?![/\\])/u)) {
                                if (displayedPath.hasChildNodes()) displayedPath.append(node('wbr'));
                                displayedPath.append(part);
                            }
                            row.append(displayedPath, remove); list.append(row);
                        }
                        if (!paths().length) list.append(node('p', 'extension-resource-detail', local('尚未选择目录', 'No directories selected')));
                    };
                    const pick = node('button', 'p-btn', local('添加目录', 'Add directory')); pick.type = 'button';
                    const picker = window.electronAPI?.pickDirectory;
                    control.hidden = !!picker;
                    if (!picker) control.addEventListener('input', draw);
                    pick.disabled = !picker; pick.dataset.unavailable = String(!picker);
                    pick.onclick = async () => {
                        pick.disabled = true;
                        const token = epoch;
                        try {
                            const chosen = await picker();
                            // Ignore native dialogs returning after navigation, submission or disposal.
                            if (!disposed && !busy && epoch === token && label.isConnected && !label.hidden && chosen?.cwd) {
                                control.value = [...new Set([...paths(), chosen.cwd])].join('\n'); draw();
                            }
                        } catch (e) { if (!disposed && label.isConnected) feedback.textContent = e.message; }
                        finally { if (label.isConnected && !busy) pick.disabled = !picker || label.hidden; }
                    };
                    draw(); label.append(list, pick);
                    if (!picker) label.append(node('p', 'extension-resource-detail', local('每行输入一个绝对路径；桌面客户端支持选择目录。', 'Enter one absolute path per line; the desktop app supports a directory picker.')));
                }
                const group = f.advanced ? advanced : form;
                group.append(label);
                appendGuidance(group, f.id);
                controls.set(f.id, { control, type: f.type });
                if (f.when)
                    conditions.push({ element: label, when: f.when });
            }
            const visibility = () => {
                for (const { element, when } of conditions) {
                    element.hidden = !when.values.includes(String(controls.get(when.field)?.control.value));
                    // Hidden alternatives must not participate in browser form validation.
                    for (const control of element.querySelectorAll('button,input,select,textarea'))
                        control.disabled = element.hidden || busy || control.dataset.unavailable === 'true';
                }
            };
            if (advanced.children.length > 1)
                form.append(advanced);
            const save = node('button', 'p-btn-primary', v.form.submit);
            save.type = 'submit';
            form.append(save);
            appendGuidance(form, undefined);
            form.addEventListener('change', visibility);
            visibility();
            form.addEventListener('submit', e => { e.preventDefault(); for (const f of v.form.fields) {
                const { control, type } = controls.get(f.id);
                f.value = type === 'checkbox' ? control.checked : control.value;
            } const values = { ...v.form.values }; for (const [key, { control, type }] of controls)
                values[key] = type === 'checkbox' ? control.checked : type === 'number' ? Number(control.value) : control.value; void send({ action: v.form.action, values }); });
            content.append(form);
            if (v.title) {
                // Capture the current controls only when a locale response arrives.
                // Even edits made while the read was pending stay in this window.
                readDraft = () => ({ action: v.form.action, fields: new Map([...controls].map(([id, { control, type }]) => [id, {
                    type, value: type === 'checkbox' ? control.checked : control.value,
                    focused: control === document.activeElement, start: control.selectionStart, end: control.selectionEnd,
                }])) });
                const previous = draft?.action === v.form.action ? [...draft.fields].find(([, field]) => field.focused) : undefined;
                if (previous) {
                    const next = controls.get(previous[0]);
                    if (next?.type === previous[1].type && !next.control.disabled) {
                        next.control.focus({ preventScroll: true });
                        if (typeof previous[1].start === 'number' && typeof next.control.setSelectionRange === 'function')
                            next.control.setSelectionRange(previous[1].start, previous[1].end);
                    }
                }
            }
        }
        if (compact) content.append(actions);
        const rows = node('div', 'extension-resource-rows');
        let section, sectionRows = rows;
        for (const r of v.rows) {
            if (r.section !== section) {
                section = r.section;
                sectionRows = rows;
                if (section) {
                    const group = node('section', 'extension-resource-section');
                    group.append(node('h2', 'extension-resource-section-title', section));
                    sectionRows = node('div', 'extension-resource-section-rows'); group.append(sectionRows); rows.append(group);
                }
            }
            const row = node('article', 'extension-resource-row');
            row.append(node('h3', 'extension-resource-title', r.title));
            if (r.detail)
                row.append(node('p', 'extension-resource-detail', r.detail));
            if (r.qr)
                row.append(renderQr(r.qr));
            if (r.status)
                row.append(node('p', 'extension-resource-status', r.status));
            if (r.conversationId) {
                const link = node('a', 'extension-resource-link', local('查看对话', 'Open conversation'));
                link.href = '/' + encodeURIComponent(r.conversationId);
                if(options.openConversation) link.addEventListener('click',e=>{e.preventDefault();options.openConversation(r.conversationId);});
                row.append(link);
            }
            // Reference an existing action; presentation never adds authority.
            if (r.inlineActions) {
                const controls = node('div', 'extension-resource-actions extension-resource-inline-actions');
                for (const a of r.actions) controls.append(button(a));
                row.append(controls); sectionRows.append(row); continue;
            }
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
            sectionRows.append(row);
        }
        content.append(rows);
    };
    const refresh = async (forLocale = false) => {
        if (disposed || busy || refreshing || reviewing || (!forLocale && (editing || document.hidden || container.closest('[hidden]'))))
            return;
        refreshing = true;
        const locale = lang.value;
        const token = ++epoch;
        try {
            const data = await request(undefined, locale);
            if (token === epoch && !busy && !reviewing && (!editing || forLocale) && (!view?.title || locale === lang.value))
                display(data, locale, forLocale ? readDraft?.() : undefined);
        }
        catch (e) {
            // Errors belong to the same request generation as successful snapshots.
            if (!disposed && token === epoch && !busy && (!editing || forLocale) && locale === lang.value)
                feedback.textContent = e.message;
        }
        finally {
            refreshing = false;
            if (locale !== lang.value || token !== epoch) syncLocale();
        }
    };
    const syncLocale = () => { if (view?.title && renderedLocale !== lang.value) void refresh(true); };
    document.addEventListener('langchange', syncLocale);
    // Initial load even while the drawer is closed; refresh only visible idle views.
    const initial = ++epoch, initialLocale = lang.value;
    void request(undefined, initialLocale).then(data => { if (initial === epoch)
        display(data, initialLocale); }).catch(e => { if (!disposed && initial === epoch)
        feedback.textContent = e.message; }).finally(() => { refreshing = false; syncLocale(); });
    const timer = setInterval(() => void refresh(), 5000);
    return () => { disposed = true; ++epoch; abort.abort(); clearInterval(timer); document.removeEventListener('langchange', syncLocale); closeReview(); content.remove(); feedback.remove(); };
}

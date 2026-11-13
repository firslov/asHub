import { DeviceSharing } from './sharing.mjs';
import { RemoteAccount } from './client.mjs';
const action = (id, label, values = {}) => ({ id, label, values });
const stateLabels = { online: '允许访问 · 在线', revoked: '授权已撤销', error: '连接异常', connecting: '允许访问 · 连接中' };

// The plugin owns device discovery, account policy and this single-page view.
// The host renders declarative controls and confirms the actual directory grant.
export function connectionResource(account, sharing) {
    let editing = false, loginEditing = !sharing;
    const view = () => {
        const local = sharing?.status();
        const actions = account.cookie ? [action('refresh', '刷新设备'), action('logout', '退出连接账号')] : [];
        if (sharing && !account.cookie && !editing && !loginEditing) actions.push(action('connect-account', '连接其他电脑'));
        if (editing || (sharing && loginEditing)) actions.push(action('cancel-sharing', '取消设置'));
        if (sharing?.recovery) actions.push(action('ack-recovery', '恢复码已保存'));
        const rows = local ? [{
            title: local.deviceName || '本机', primaryAction: 'edit-sharing',
            status: [local.username, local.enabled ? stateLabels[local.status] || '等待连接' : '未共享'].filter(Boolean).join(' · '),
            detail: local.error || (sharing.recovery ? '请保存账号恢复码：' + sharing.recovery
                : '仅共享已授权目录中的对话。手机入口：' + (local.gateway || 'https://ashub.aihao.world/mobile/')),
            actions: [action('edit-sharing', local.enabled ? '设置共享目录' : '允许访问本机'),
                ...(local.enabled ? [action('disable-sharing', '关闭本机访问')] : [])],
        }] : [];
        for (const [id, r] of account.records) rows.push({
            title: String(r.device.name || '远程电脑'), status: r.device.online ? '在线' : '离线', detail: '',
            actions: r.device.online ? [action('open', '打开工作区', { device: id })] : [],
            ...(r.device.online ? { primaryAction: 'open' } : {}),
        });
        const form = editing ? { action: 'configure-sharing', submit: '确认共享范围', values: {}, fields: [
            { id: 'username', type: 'text', label: '互联账号', value: local.username || account.user || '' },
            { id: 'password', type: 'password', label: '密码' },
            { id: 'deviceName', type: 'text', label: '本机名称', value: local.deviceName || '我的电脑' },
            { id: 'roots', type: 'textarea', label: '共享目录（每行一个绝对路径）', value: (local.roots || []).join('\n') },
            { id: 'create', type: 'checkbox', label: '注册新账号', value: false },
        ] } : !account.cookie && loginEditing ? { action: 'login', submit: '登录', values: {}, fields: [
            { id: 'username', type: 'text', label: '账号', value: account.user || local?.username || '' },
            { id: 'password', type: 'password', label: '密码' },
        ] } : undefined;
        return {
            actions, rows, ...(form ? { form } : {}),
            note: account.error || (account.cookie
                ? '选择一台电脑继续工作。每个窗口只连接所选电脑，任务在该电脑执行。'
                : '连接其他电脑，或允许手机访问本机。两者可独立使用。'),
        };
    };
    return { view, prepare: async (id, values) => {
        if (id === 'connect-account') return { execute: () => { loginEditing = true; editing = false; return view(); } };
        if (id === 'edit-sharing' && sharing) return { execute: () => { editing = true; loginEditing = false; return view(); } };
        if (id === 'cancel-sharing') return { execute: () => { editing = false; loginEditing = false; return view(); } };
        if (id === 'ack-recovery' && sharing) return { execute: () => { sharing.recovery = ''; return view(); } };
        if (id === 'disable-sharing' && sharing) return { execute: () => { sharing.disable(); editing = false; return view(); } };
        if (id === 'configure-sharing' && sharing) {
            const roots = String(values.roots || '').split('\n').map(x => x.trim()).filter(Boolean);
            return {
                sharingAuthorization: { roots },
                preview: { title: '允许访问本机', fields: [
                    { label: '账号', value: String(values.username || '') },
                    { label: '设备', value: String(values.deviceName || '我的电脑') },
                ] },
                execute: async grantId => { await sharing.configure({ ...values }, grantId); editing = false; return view(); },
            };
        }
        if (id === 'login') return {
            preview: { title: '连接远程账号', fields: [
                { label: '账号', value: String(values.username || '') },
                { label: '权限', value: '访问此账号下已授权的电脑；登录不会开启本机共享。凭据使用系统加密存储，密码不保存。' },
            ] },
            execute: async () => { await account.login(String(values.username || ''), String(values.password || '')); loginEditing = false; return view(); },
        };
        if (id === 'refresh') return { execute: async () => { await account.refresh(); return view(); } };
        if (id === 'logout') return { execute: async () => { await account.logout(); return view(); } };
        if (id === 'open') {
            const target = values.device;
            if (typeof target !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(target)) throw Error('设备无效');
            return { execute: async () => { await account.openDevice(target); return view(); } };
        }
        throw Error('不支持的操作');
    } };
}

export default async function activate(ctx) {
    const account = new RemoteAccount({ backends: ctx.services.backends, signal: ctx.signal });
    let sharing;
    try { sharing = new DeviceSharing(ctx); } catch (e) { account.close(); throw e; }
    ctx.services.interactions.register('connections', connectionResource(account, sharing));
    void account.refresh().catch(() => {});
    return { stop: async () => { account.close(); await sharing.close(); }, canStop: () => !account.loggingIn && !sharing.busy() };
}

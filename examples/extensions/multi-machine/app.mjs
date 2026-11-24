import { DeviceSharing } from './sharing.mjs';
import { RemoteAccount } from './client.mjs';
import { QrCode } from './vendor-qrcodegen.mjs';
const action = (id, label, values = {}) => ({ id, label, values });
const stateLabels = { online: '在线', revoked: '授权已撤销，请重新验证', replaced: '连接已被接替', error: '连接异常', connecting: '连接中' };
const rootsOf = value => [...new Set(String(value || '').split('\n').map(x => x.trim()).filter(Boolean))];
const impact = '新增目录中的对话将对手机和其他电脑可见；移除目录后，仅不再被任何已授权目录（含其子目录）覆盖的对话会隐藏。不会删除本地对话，也不会改变工具权限。保存后远程连接会短暂重连。';

function publicMobileEntry(gateway) {
    try {
        const url = new URL(gateway || 'https://ashub.aihao.world/mobile/');
        if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash) return url.href;
    } catch {}
    return '';
}

function mobileEntryQr(entry) {
    if (!entry || entry.length > 512) return undefined;
    const qr = QrCode.encodeText(entry, QrCode.Ecc.MEDIUM);
    const modules = Array.from({ length: qr.size }, (_, y) =>
        Array.from({ length: qr.size }, (_, x) => qr.getModule(x, y) ? '1' : '0').join(''));
    return { label: '用手机相机扫码打开', modules };
}

// Account policy, presentation and directory-change semantics belong to the plugin.
// The host only renders bounded controls and confirms the actual directory grant.
export function connectionResource(account, sharing) {
    let page = sharing || account.cookie ? 'overview' : 'login';
    account.showDevices = () => { page = 'overview'; };
    const view = () => {
        const local = sharing?.status();
        if (page !== 'overview') {
            const roots = { id: 'roots', type: 'directories', label: '共享目录', value: (local?.roots || []).join('\n') };
            const form = page === 'roots' ? { action: 'update-roots', submit: '核对目录变更', values: {}, fields: [roots] }
                : page === 'binding' ? { action: 'configure-sharing', submit: '核对并授权', values: {}, fields: [
                    { id: 'username', type: 'text', label: '共享账号', value: local?.username || account.user || '' },
                    { id: 'password', type: 'password', label: '密码（重新验证账号）' },
                    { id: 'deviceName', type: 'text', label: '本机名称', value: local?.deviceName || '我的电脑' },
                    roots, { id: 'create', type: 'checkbox', label: '注册新账号', value: false },
                ] } : { action: 'login', submit: '登录连接账号', values: {}, fields: [
                    { id: 'username', type: 'text', label: '连接账号', value: account.user || local?.username || '' },
                    { id: 'password', type: 'password', label: '密码' },
                ] };
            return { actions: [action('cancel-sharing', '返回')], rows: [], form, note: page === 'roots'
                ? '设置共享目录 · 保持当前账号和设备身份\n' + impact
                : page === 'binding' ? '允许其他设备访问本机 · 绑定或切换账号需要验证密码；同一账号沿用原设备身份。'
                    : '访问其他电脑 · 登录不会开启本机共享。请先在目标电脑的「设备互联 → 允许其他设备访问本机」授权共享目录，再使用同一账号登录。' };
        }
        const remoteSection = '访问其他电脑', localSection = '允许其他设备访问本机';
        const help = '请在目标电脑打开「设备互联 → 允许其他设备访问本机」，授权共享目录，并使用同一账号登录。';
        const discovery = account.discovery || (account.cookie ? 'ready' : 'idle');
        const status = discovery === 'expired' ? '登录已过期' : !account.cookie ? '未登录' : discovery === 'loading' ? '正在查询设备…'
            : discovery === 'error' ? '设备状态待确认' : account.records.size ? '已登录 · ' + account.records.size + ' 台设备' : '暂无已授权设备';
        const detail = discovery === 'expired' ? '请重新登录连接账号；本机共享不受影响。'
            : !account.cookie || (discovery === 'ready' && !account.records.size) ? help
            : discovery === 'loading' ? '正在核对账号与设备权限，请稍候。'
            : discovery === 'error' ? '查询失败，已保留上次设备列表。请检查网络后刷新；打开前会重新核验。\n' + account.error
            : '任务在选定电脑执行。退出连接账号只关闭控制端，不影响其他设备访问本机。';
        const rows = [{ section: remoteSection, title: account.user || (account.cookie ? '已登录连接账号' : '未登录连接账号'),
            status, detail, inlineActions: true,
            actions: account.cookie ? [{ ...action('refresh', '刷新设备'), pendingLabel: '正在查询设备…' }, action('logout', '退出连接账号')] : [action('connect-account', '登录连接账号')],
        }];
        for (const [id, r] of account.records) {
            const unknown = discovery === 'error' || discovery === 'loading', name = String(r.device.name || '远程电脑').slice(0, 160);
            rows.push({ section: remoteSection, title: name,
                status: account.opening?.has(id) ? '正在连接…' : unknown ? '状态待确认' : r.device.online ? '在线' : '离线',
                detail: unknown ? '打开前重新核验设备状态与访问权限。' : r.device.online ? '' : '请在目标电脑启动 asHub 并保持联网。' + help,
                actions: r.device.online || unknown ? [{ ...action('open', unknown ? '核验并打开' : '打开工作区', { device: id }), pendingLabel: '正在连接「' + name + '」…' }] : [],
                ...(r.device.online || unknown ? { primaryAction: 'open' } : {}),
            });
        }
        if (local) {
            const entry = publicMobileEntry(local.gateway);
            if (entry) rows.push({ section: localSection, title: '手机入口', detail: entry,
                qr: mobileEntryQr(entry), actions: [] });
            rows.push({ section: localSection, title: local.deviceName || '本机',
                status: (local.username ? '共享账号：' + local.username + ' · ' : '') + (local.enabled ? stateLabels[local.status] || '等待连接' : '已关闭'),
                detail: [local.error, sharing.recovery ? '请保存账号恢复码：' + sharing.recovery : '',
                    '已授权目录：\n' + (local.roots.join('\n') || '尚未授权'),
                    '本机共享同时供手机和其他电脑使用。关闭后，两者均无法访问本机；本地对话及连接其他电脑不受影响。'].filter(Boolean).join('\n\n'),
                inlineActions: true, actions: [
                    ...(local.enabled ? [action('edit-sharing', '设置共享目录'), action('disable-sharing', '关闭本机访问'), action('bind-sharing', '重新验证 / 切换共享账号')]
                        : [action('bind-sharing', '允许访问本机')]),
                    ...(sharing.recovery ? [action('ack-recovery', '恢复码已保存')] : []),
                ],
            });
        }
        return { actions: [], rows };
    };
    return { view, onReveal: account.showDevices, prepare: async (id, values) => {
        if (id === 'connect-account') return { execute: () => { page = 'login'; return view(); } };
        if (id === 'edit-sharing' && sharing) return { execute: () => { page = sharing.status().enabled ? 'roots' : 'binding'; return view(); } };
        if (id === 'bind-sharing' && sharing) return { execute: () => { page = 'binding'; return view(); } };
        if (id === 'cancel-sharing') return { execute: () => { page = 'overview'; return view(); } };
        if (id === 'ack-recovery' && sharing) return { execute: () => { sharing.recovery = ''; return view(); } };
        if (id === 'disable-sharing' && sharing) return {
            preview: { title: '关闭本机访问', fields: [{ label: '影响', value: '手机和其他电脑都将无法访问本机共享的对话。保留设备身份与授权目录；本地对话及连接其他电脑不受影响。' }] },
            execute: () => { sharing.disable(); page = 'overview'; return view(); },
        };
        if (id === 'update-roots' && sharing) {
            const local = sharing.status(), revision = sharing.revision();
            const { roots, added, removed } = sharing.directoryChange(rootsOf(values.roots));
            if (!local.enabled || local.status === 'revoked') throw Error('请先重新验证共享账号');
            return {
                sharingAuthorization: { roots },
                preview: { title: '确认共享目录变更', fields: [
                    { label: '新增目录', value: added.join('\n') || '无' },
                    { label: '移除目录', value: removed.join('\n') || '无' },
                    { label: '远程可见范围', value: impact },
                ] },
                execute: async grantId => { await sharing.updateRoots(grantId, revision); page = 'overview'; return view(); },
            };
        }
        if (id === 'configure-sharing' && sharing) return {
            sharingAuthorization: { roots: sharing.directoryChange(rootsOf(values.roots)).roots },
            preview: { title: '允许访问本机', fields: [
                { label: '账号', value: String(values.username || '') },
                { label: '设备', value: String(values.deviceName || '我的电脑') },
                { label: '影响', value: '手机和其他电脑可访问授权目录中的对话。切换账号后，原账号不再能访问本机。连接账号保持不变。' },
            ] },
            execute: async grantId => { await sharing.configure({ ...values }, grantId); page = 'overview'; return view(); },
        };
        if (id === 'login') return {
            preview: { title: '连接远程账号', fields: [
                { label: '账号', value: String(values.username || '') },
                { label: '权限', value: '访问此账号下已授权的电脑；登录不会开启本机共享。凭据使用系统加密存储，密码不保存。' },
            ] },
            execute: async () => { await account.login(String(values.username || ''), String(values.password || '')); page = 'overview'; return view(); },
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

import { registerDesktopBridge } from './bridge.js';
import path from 'node:path';
import os from 'node:os';
import { activateDesktopControl, isDesktopControlTool } from './plugin.js';
import { isolateDesktopTools } from './isolation.js';
import { leaseService } from './leases.js';
import { defaults, readDesktopSettings, settingsRevision } from './settings.js';
export default async function activate(ctx: any): Promise<void> {
  if (!ctx.agent || typeof ctx.onDispose !== 'function') throw Error('Desktop control requires the asHub plugin lifecycle and an active agent backend');
  const file = path.join(path.resolve(process.env.AGENT_SH_HOME || path.join(os.homedir(), '.agent-sh')), 'settings.json');
  // Advertise the namespace to asHub's existing plugin configuration editor.
  ctx.getExtensionSettings('desktop-control', defaults());
  const lease = await leaseService(file); const service = lease.service;
  let disposed = false;
  ctx.onDispose(() => { disposed = true; void lease.release().catch(() => {}); });
  activateDesktopControl(ctx, service);
  isolateDesktopTools(ctx, isDesktopControlTool);
  registerDesktopBridge(ctx, service);
  const report = (message: string, error = false) => { if (!disposed) ctx.bus.emit(error ? 'ui:error' : 'ui:info', { message }); };
  ctx.registerCommand('/desktop', 'Desktop control: install, status, apps, enable, disable, allow, revoke, stop', async (input = '') => {
    try {
      const [command = 'status', ...args] = String(input).trim().split(/\s+/).filter(Boolean);
      if (command === 'install') {
        report('正在检查或修复桌面控制组件（需要 Python 3.12+）…');
        const health = await service.runtime.ensureInstalled();
        if (disposed) return;
        if (!health.healthy) throw Error(service.runtime.error || health.healthError || 'Desktop runtime is unavailable');
        report('桌面控制组件已安装并通过健康检查。请授予辅助功能权限；截图还需要屏幕录制权限，然后运行 /desktop apps');
      } else if (command === 'stop') {
        await service.stop(); report('所有桌面任务及待审批请求已停止');
      } else if (command === 'revoke') {
        if (args.length !== 1) throw Error('用法：/desktop revoke <Bundle ID | all>');
        const old = readDesktopSettings(file);
        const approvedApps = args[0] === 'all' ? [] : (old.approvedApps ?? []).filter(id => id !== args[0]);
        await service.save({ ...old, approvedApps }, settingsRevision(old));
        report('已撤销所选应用的全局桌面授权并停止现有桌面任务。');
      } else if (command === 'enable' || command === 'disable' || command === 'allow') {
        const old = readDesktopSettings(file); const next = { ...old };
        if (command === 'allow') {
          if (!args.length) throw Error('用法：/desktop allow com.apple.TextEdit（替换允许应用列表）；清空用 /desktop allow none');
          next.allowedApps = args.length === 1 && args[0] === 'none' ? [] : args;
        } else next.enabled = command === 'enable';
        await service.save(next, settingsRevision(old));
        report(`桌面控制${next.enabled ? '已启用' : '已停用'}；允许的应用：${next.allowedApps.join(', ') || '无'}。原有任务已停止。`);
      } else if (command === 'apps') {
        const state = await service.status(true);
        report(JSON.stringify(state, null, 2));
      } else if (command === 'status') {
        report(JSON.stringify(await service.status(), null, 2));
      } else throw Error('用法：/desktop install | status | apps | allow <Bundle IDs> | revoke <Bundle ID | all> | enable | disable | stop');
    } catch (e) { report(e instanceof Error ? e.message : String(e), true); }
  });
}

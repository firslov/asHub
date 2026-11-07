const { createHash } = require('node:crypto');
const { isIP, BlockList } = require('node:net');
const nonPublic4 = new BlockList();
for (const [base, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
])
  nonPublic4.addSubnet(base, bits, 'ipv4');
const global6 = new BlockList();
global6.addSubnet('2000::', 3, 'ipv6');
const special6 = new BlockList();
for (const [base, bits] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
])
  special6.addSubnet(base, bits, 'ipv6');
function publicAddress(address) {
  if (isIP(address) === 4) return !nonPublic4.check(address, 'ipv4');
  return isIP(address) === 6 && global6.check(address, 'ipv6') && !special6.check(address, 'ipv6');
}
async function publicDNS(session, hostname) {
  const { endpoints } = await session.resolveHost(hostname);
  return endpoints.length > 0 && endpoints.every((endpoint) => publicAddress(endpoint.address));
}
const { snapshot, resolveTarget } = require('./browser-dom.cjs');

function publicURL(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) throw Error('Expected an HTTPS website address.');
  const url = new URL(raw),
    host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    !host.includes('.') ||
    isIP(host) ||
    host.includes(':') ||
    /(?:^|\.)(localhost|local|internal|lan|home|arpa)$/.test(host)
  )
    throw Error('Only HTTPS websites are supported.');
  return url;
}

function configureSession(session, origin, resolvePublic) {
  session.setPermissionRequestHandler((_wc, _perm, answer) => answer(false));
  session.setPermissionCheckHandler(() => false);
  session.setDevicePermissionHandler(() => false);
  session.setDisplayMediaRequestHandler((_request, answer) => answer({}));
  session.on('will-download', (event) => event.preventDefault());
  session.webRequest.onBeforeRequest(async (request, answer) => {
    try {
      if (request.resourceType !== 'mainFrame' && /^(data|blob):/.test(request.url)) return answer({});
      const url = publicURL(request.url);
      if (request.resourceType === 'mainFrame' && url.origin !== origin) return answer({ cancel: true });
      answer({ cancel: !(await resolvePublic(session, url.hostname)) });
    } catch {
      answer({ cancel: true });
    }
  });
}

function createBrowserPages({
  electron,
  notify = () => {},
  now = () => new Date(),
  resolvePublic = publicDNS,
}) {
  const activations = new Map();
  const pages = new Map(),
    mounted = new Map(),
    configured = new WeakSet();
  const detach = (win) => {
    const page = mounted.get(win);
    if (!page) return;
    mounted.delete(win);
    if (!win.isDestroyed()) win.contentView.removeChildView(page.view);
  };
  const status = (id) => {
    const p = pages.get(id);
    if (!p) return null;
    const history = p.contents.navigationHistory;
    return { pageId: p.contents.id, origin: p.origin, manual: p.manual, back: history.canGoBack(), forward: history.canGoForward() };
  };
  function remove(p) {
    if (!p || pages.get(p.id) !== p) return;
    pages.delete(p.id);
    p.revision++;
    p.refs.clear();
    p.daily.clear();
    for (const [win, page] of mounted) if (page === p) detach(win);
    if (!p.contents.isDestroyed()) p.contents.close({ waitForBeforeUnload: false });
    notify(p.id);
  }
  function create(id, origin, owner) {
    if (pages.size >= 8) throw Error('Close an unused browser pane before opening another.');
    const partition =
      'persist:ashub-browser-' +
      createHash('sha256')
        .update(id + '\0' + origin)
        .digest('hex');
    const session = electron.session.fromPartition(partition);
    if (!configured.has(session)) {
      configureSession(session, origin, resolvePublic);
      configured.add(session);
    }
    const view = new electron.WebContentsView({
      webPreferences: {
        session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        disableDialogs: true,
        webviewTag: false,
      },
    });
    const contents = view.webContents;
    const p = {
      id,
      origin,
      owner,
      view,
      contents,
      manual: false,
      revision: 0,
      hasLoadedPage: false,
      viewport: 'initial',
      refs: new Map(),
      daily: new Map(),
      command: async (method, args) => contents.debugger.sendCommand(method, args),
    };
    pages.set(id, p);
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-prevent-unload', (event) => event.preventDefault());
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.on('will-navigate', (event, url) => {
      try {
        if (publicURL(event.url || url).origin === origin) return;
      } catch {}
      event.preventDefault();
    });
    contents.on('did-start-navigation', (event, _url, _inPlace, isMainFrame) => {
      if (event.isMainFrame ?? isMainFrame) {
        p.revision++;
        p.refs.clear();
      }
    });
    const navigated = () => {
      p.revision++;
      p.refs.clear();
      notify(id);
    };
    contents.on('did-navigate', navigated);
    contents.on('did-navigate-in-page', (_event, _url, main) => {
      if (main) navigated();
    });
    contents.once('destroyed', () => remove(p));
    contents.once('render-process-gone', () => remove(p));
    try {
      contents.debugger.attach('1.3');
    } catch (e) {
      remove(p);
      throw e;
    }
    notify(id);
    return p;
  }
  const trackedWindows = new WeakSet();
  function mount(win, id, bounds) {
    const p = pages.get(id);
    if (!p || !bounds || win.isDestroyed()) {
      detach(win);
      return;
    }
    if (!trackedWindows.has(win)) {
      trackedWindows.add(win);
      win.once('closed', () => detach(win));
      win.webContents.on('render-process-gone', () => detach(win));
      win.webContents.on('did-start-navigation', (event, _url, inPlace, isMainFrame) => {
        if ((event.isMainFrame ?? isMainFrame) && !(event.isSameDocument ?? inPlace)) detach(win);
      });
    }
    // A session can be present in more than one asHub window. Only one owns its native view.
    for (const [other, page] of mounted)
      if (other !== win && page === p) {
        if (!win.isFocused() && other.isVisible()) return;
        detach(other);
      }
    if (mounted.get(win) !== p) {
      detach(win);
      win.contentView.addChildView(p.view);
      mounted.set(win, p);
    }
    const zoom = win.webContents.getZoomFactor();
    const box = Object.fromEntries(
      ['x', 'y', 'width', 'height'].map((k) => [k, Math.round(bounds[k] * zoom)]),
    );
    if (!Object.values(box).every(Number.isFinite) || box.width < 1 || box.height < 1) {
      detach(win);
      return;
    }
    p.view.setBounds(box);
    if (p.viewport === 'virtual') {
      void p.command('Emulation.clearDeviceMetricsOverride').catch(() => {});
    }
    p.viewport = 'native';
  }
  function control(id, action, pageId) {
    const p = pages.get(id);
    if (!p || (pageId !== undefined && p.contents.id !== pageId)) return;
    if (action === 'close') {
      p.owner.close();
      return;
    }
    if (action === 'back' || action === 'forward') {
      const history = p.contents.navigationHistory;
      if (action === 'back' ? !history.canGoBack() : !history.canGoForward()) return;
      p.owner.cancel();
      if (action === 'back') history.goBack();
      else history.goForward();
      return;
    }
    if (action === 'manual' || action === 'resume') {
      p.manual = action === 'manual';
      p.revision++;
      p.refs.clear();
      p.owner.cancel();
      notify(id);
      if (p.manual) p.contents.focus();
    }
  }

  function enable(plugin, signal) {
    if (signal.aborted) return;
    activations.set(plugin, signal);
    signal.addEventListener(
      'abort',
      () => {
        if (activations.get(plugin) !== signal) return;
        activations.delete(plugin);
        for (const p of pages.values()) if (p.owner.plugin === plugin) p.owner.close();
      },
      { once: true },
    );
  }
  function bind(id, plugin, approve) {
    let pending;
    let disposed = false;
    const owner = {
      plugin,
      available() {
        return !disposed && activations.has(plugin);
      },
      cancel() {
        pending?.abort();
      },
      close() {
        owner.cancel();
        const p = pages.get(id);
        if (p?.owner === owner) remove(p);
      },
      async run(request, signal) {
        if (!request || typeof request !== 'object') throw Error('Invalid browser request.');
        const { op, ref, url, value, daily, references } = request;
        const req = { op, ref, url, value, daily, references };
        if (req.op === 'close') {
          owner.close();
          return { closed: true };
        }
        if (pending) throw Error('Another browser operation is in progress.');
        if (!owner.available()) throw Error('Browser extension is disabled.');
        const controller = new AbortController();
        pending = controller;
        const active = AbortSignal.any([
          controller.signal,
          activations.get(plugin),
          ...(signal ? [signal] : []),
        ]);
        const confirm = async (title, fields, browser, scope) => {
          active.throwIfAborted();
          const decision = await approve(
            {
              title, browser, scope,
              items: [{ title: 'Browser', fields: fields.map(([label, value]) => ({ label, value: String(value) })) }],
            },
            active,
          );
          active.throwIfAborted();
          if (decision !== true && decision !== 'automatic') throw Error('Browser permission denied or expired.');
          return decision;
        };
        try {
          active.throwIfAborted();
          let p = pages.get(id);
          if (p && p.owner !== owner) throw Error('Browser belongs to another activation.');
          if (p?.manual) throw Error('Manual control is active. Return control in the browser pane.');
          if (req.op === 'open') {
            const url = publicURL(req.url);
            if (
              !p ||
              p.origin !== url.origin ||
              (p.contents.getURL() !== url.href && p.lastOpen !== url.href)
            ) {
              await confirm('打开网页 · Open website', [
                ['URL', url.href],
                [
                  '权限 / Access',
                  '读取此站点的页面内容，按对话保留登录状态 · Read this site in this conversation',
                ],
              ], { action: 'open', origin: url.origin }, 'site');
            }
            if (pages.get(id) !== p) throw Error('Browser was replaced.');
            if (!p || p.origin !== url.origin) {
              remove(p);
              p = create(id, url.origin, owner);
            }
            p.lastOpen = url.href;
            // Reopening the same URL refreshes its current state for recurring tasks.
            const abort = () => {
              if (!p.contents.isDestroyed()) p.contents.stop();
            };
            active.addEventListener('abort', abort, { once: true });
            const timeout = setTimeout(abort, 20000);
            try {
              // Chromium only initializes a renderer after its first navigation.
              // An unmounted view needs a layout viewport before site scripts run.
              if (p.viewport === 'initial') {
                await p.contents.loadURL('about:blank');
                active.throwIfAborted();
                if (p.viewport === 'initial') {
                  p.viewport = 'virtual';
                  await p.command('Emulation.setDeviceMetricsOverride', {
                    width: 480,
                    height: 640,
                    deviceScaleFactor: 0,
                    mobile: false,
                    dontSetVisibleSize: true,
                  });
                  active.throwIfAborted();
                }
              }
              await p.contents.loadURL(url.href);
              active.throwIfAborted();
              if (!p.hasLoadedPage) {
                const history = p.contents.navigationHistory;
                if (history.getActiveIndex() > 0 && history.getEntryAtIndex(0)?.url === 'about:blank') {
                  history.removeEntryAtIndex(0);
                  notify(id);
                }
              }
              p.hasLoadedPage = true;
            } catch (e) {
              // A later failed/interrupted load must not destroy a usable navigation history.
              if (pages.get(id) === p) {
                if (!p.hasLoadedPage && !p.manual) remove(p);
                else notify(id);
              }
              throw e;
            } finally {
              clearTimeout(timeout);
              active.removeEventListener('abort', abort);
            }
          }
          if (!p) throw Error('Open a browser page first.');
          const revision = p.revision;
          const check = () => {
            active.throwIfAborted();
            if (
              pages.get(id) !== p ||
              p.revision !== revision ||
              p.manual ||
              p.contents.mainFrame.origin !== p.origin ||
              publicURL(p.contents.getURL()).origin !== p.origin
            )
              throw Error('Page changed. Observe again.');
          };
          check();
          if (req.op === 'open' || req.op === 'observe')
            return await snapshot(p, check, req.references !== false);
          if (!['click', 'fill'].includes(req.op)) throw Error('Unsupported browser operation.');
          const value = req.op === 'fill' ? req.value : '';
          if (typeof value !== 'string' || value.length > 1000)
            throw Error('Field value exceeds the allowed length.');
          const daily = req.daily === true;
          const target = await resolveTarget(p, req.ref, check, daily);
          try {
            const info = await target.call(req.op, value, null);
            check();
            if (info.blocked) throw Error(info.blocked);
            if (daily && (!info.dailyEligible || !target.entry.name))
              throw Error(
                'Daily approval requires a named standalone button with a unique stable ID, including its component hosts.',
              );
            const key = JSON.stringify([info.identity, target.entry.name]);
            const observedAt = now();
            const today = observedAt.toDateString();
            if (daily) {
              for (const [targetKey, record] of p.daily) {
                if (record.expires <= observedAt.getTime() && record.lastDay !== today) p.daily.delete(targetKey);
              }
            }
            const previousGrant = daily ? p.daily.get(key) : undefined;
            if (previousGrant?.lastDay === today) return { status: 'already-attempted' };
            const grant = previousGrant && observedAt.getTime() < previousGrant.expires;
            let automatic = false;
            if (!grant) {
              const fields = [
                ['URL', p.contents.getURL()],
                ['控件 / Control', target.entry.name || target.entry.role],
                ...info.fields,
              ];
              if (info.checked != null) fields.push(['当前勾选 / Checked', String(info.checked)]);
              if (info.destination) fields.push(['目标地址 / Destination', info.destination]);
              if (req.op === 'fill') fields.push(['填写 / Fill', value]);
              if (daily) {
                fields.push(['按钮位置 / Button path', info.dailyPath.join(' → ')]);
                fields.push([
                  '重复授权 / Schedule',
                  '本对话此页面的同一按钮，每天最多一次，有效七天。关闭页面撤销 · Once per day for seven days, until closed.',
                ]);
              }
              const decision = await confirm(
                req.op === 'fill' ? '填写网页 · Fill field' : '点击网页控件 · Click control',
                fields, { action: req.op, origin: p.origin }, daily ? 'daily7' : 'once',
              );
              automatic = decision === 'automatic';
            }
            check();
            // Reserve only when the renderer command is about to be sent, after
            // host-side checks. A lost response must still count as an attempt.
            let expired;
            const reserve = () => {
              if (!daily) return;
              const at = now();
              if (grant && at.getTime() >= previousGrant.expires) {
                expired = new Error('Daily approval expired before dispatch. Request approval again.');
                throw expired;
              }
              p.daily.set(key, {
                lastDay: at.toDateString(),
                // Plugin-wide consent applies to this attempt. Only a manual
                // approval of the schedule may authorize clicks on future days.
                expires: automatic ? 0 : grant ? previousGrant.expires : at.getTime() + 7 * 86400000,
              });
            };
            p.refs.delete(req.ref);
            let result;
            try {
              result = await target.call(req.op, value, { identity: info.identity, daily }, reserve);
            } catch (error) {
              if (expired && error === expired) throw error;
              throw Error(`Could not confirm action: ${error.message}. Inspect the page before retrying.`);
            }
            if (result?.changed || result?.blocked) {
              // The isolated world explicitly declined before clicking or filling.
              if (daily) {
                if (previousGrant) p.daily.set(key, previousGrant);
                else p.daily.delete(key);
              }
              throw Error(result.blocked || 'Page changed during approval. Observe again.');
            }
            return { status: 'performed' };
          } finally {
            await target.release();
          }
        } finally {
          if (pending === controller) pending = undefined;
        }
      },
    };
    return Object.freeze({
      available: owner.available,
      run: owner.run,
      close() {
        disposed = true;
        owner.close();
      },
    });
  }
  return {
    enable,
    bind,
    status,
    mount,
    detach,
    control,
    close() {
      for (const p of [...pages.values()]) p.owner.close();
    },
  };
}
module.exports = { createBrowserPages, publicURL, publicAddress };

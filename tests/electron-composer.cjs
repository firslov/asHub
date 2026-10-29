// Actual composer markup and stylesheet order, isolated from sessions and model calls.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-composer-ui-'));
app.setPath('userData', profile);
const watchdog = setTimeout(() => app.exit(1), 30000);
let win;
app.whenReady().then(async () => {
  try {
    const html = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8');
    const styles = [...html.matchAll(/<link\b[^>]*href="(\/css\/[^\"]+\.css)"[^>]*>/g)]
      .map(m => `<link rel="stylesheet" href="${pathToFileURL(path.join(root, 'web', m[1]))}">`).join('');
    const form = html.match(/<form class="live-input" id="form">[\s\S]*?<\/form>/)?.[0];
    assert.ok(form && styles, 'Missing real composer fixture');
    const fixture = path.join(profile, 'fixture.html');
    fs.writeFileSync(fixture, `<!doctype html><meta charset="utf-8">${styles}<style>*{transition:none!important;animation:none!important}</style><div class="live-wrap">${form}</div>`);
    win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
    await win.loadFile(fixture);
    const run = code => win.webContents.executeJavaScript(code);
    const debug = win.webContents.debugger;
    debug.attach('1.3');
    await debug.sendCommand('DOM.enable');
    await debug.sendCommand('CSS.enable');
    const { root: dom } = await debug.sendCommand('DOM.getDocument');
    const { nodeId } = await debug.sendCommand('DOM.querySelector', { nodeId: dom.nodeId, selector: '#send-btn' });
    let checked = 0;
    for (const theme of ['light', 'dark']) for (const shell of [false, true]) {
      for (const state of ['send', 'disabled', 'busy']) for (const focus of ['none', 'input', 'button']) {
        if (state === 'disabled' && focus === 'button') continue;
        for (const hover of [false, true]) {
          const label = JSON.stringify({ theme, shell, state, focus, hover });
          await debug.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: hover ? ['hover'] : [] });
          const result = await run(`(() => {
            document.documentElement.dataset.theme = ${JSON.stringify(theme)};
            const form = document.getElementById('form'), btn = document.getElementById('send-btn'), input = document.getElementById('query');
            form.classList.toggle('shell-mode', ${shell});
            btn.classList.toggle('busy', ${state === 'busy'});
            btn.disabled = ${state === 'disabled'};
            input.value = ${JSON.stringify(state === 'disabled' ? '' : shell ? '! pwd' : 'Hello')};
            document.activeElement?.blur();
            if (${focus === 'input'}) input.focus();
            if (${focus === 'button'}) btn.focus();
            const resolve = token => {
              const probe = document.createElement('span'); probe.style.color = 'var(' + token + ')'; form.append(probe);
              const color = getComputedStyle(probe).color; probe.remove(); return color;
            };
            const arrow = getComputedStyle(btn.querySelector('.send-arrow')), stop = getComputedStyle(btn.querySelector('.send-stop'));
            return { color: getComputedStyle(btn).color, background: getComputedStyle(btn).backgroundColor,
              expected: resolve(${JSON.stringify(state === 'disabled' ? '--text-faint' : state === 'busy' ? '--red' : '--on-accent')}),
              arrow: arrow.display, stroke: arrow.stroke, stop: stop.display, fill: stop.fill,
              focused: form.matches(':focus-within'), hovered: btn.matches(':hover') };
          })()`);
          assert.equal(result.focused, focus !== 'none', label);
          assert.equal(result.hovered, hover, label);
          assert.equal(result.color, result.expected, label);
          assert.notEqual(result.color, result.background, label);
          if (state === 'busy') {
            assert.equal(result.arrow, 'none', label);
            assert.notEqual(result.stop, 'none', label);
            assert.equal(result.fill, result.expected, label);
          } else {
            assert.notEqual(result.arrow, 'none', label);
            assert.equal(result.stop, 'none', label);
            assert.equal(result.stroke, result.expected, label);
          }
          checked++;
        }
      }
    }
    console.log(`PASS ${checked} composer states: light/dark, normal/shell, send/disabled/stop, focus and hover`);
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
  }
}).then(() => finish(0), error => { console.error(error); finish(1); });
function finish(code) {
  clearTimeout(watchdog);
  fs.rmSync(profile, { recursive: true, force: true });
  app.exit(code);
}

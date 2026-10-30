import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const appRoot = process.env.ASHUB_TEST_APP_ROOT || path.resolve(import.meta.dirname, '..');
const { openBrowser } = await import(pathToFileURL(path.join(appRoot, 'node_modules/agent-sh/dist/agent/extensions/codex-provider/auth.js')).href);

const loginURL = 'https://auth.openai.com/oauth/authorize?response_type=code&client_id=test&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid+profile&code_challenge=test&code_challenge_method=S256&state=test';
const unusualURL = loginURL + '&literal=%PATH%&quoted=\'"&value=$(throw "must not execute")&unicode=中文';

// Capture the real launcher without opening browsers or contacting OAuth.
function capture(platform, url, failure) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const original = childProcess.spawn;
  let call;
  let unref = false;
  try {
    Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
    childProcess.spawn = (command, args, options) => {
      call = { command, args, options };
      if (failure === 'throw') throw new Error('unavailable launcher');
      return {
        on(event, callback) {
          assert.equal(event, 'error');
          if (failure === 'event') callback(new Error('unavailable launcher'));
          return this;
        },
        unref() { unref = true; },
      };
    };
    syncBuiltinESMExports();
    openBrowser(url);
    return { ...call, unref };
  } finally {
    childProcess.spawn = original;
    syncBuiltinESMExports();
    Object.defineProperty(process, 'platform', descriptor);
  }
}

test('Windows launcher preserves the complete OAuth URL outside shell source', () => {
  for (const url of [loginURL, unusualURL]) {
    const { command, args, options, unref } = capture('win32', url);
    assert.equal(command, 'powershell.exe');
    assert.deepEqual(args, ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $env:AGENT_SH_CODEX_LOGIN_URL']);
    assert.equal(options.env.AGENT_SH_CODEX_LOGIN_URL, url);
    const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path');
    assert.ok(pathKey);
    assert.equal(options.env[pathKey], process.env[pathKey]);
    assert.equal(options.windowsHide, true);
    assert.equal(options.stdio, 'ignore');
    assert.equal(options.detached, true);
    assert.equal(options.shell, undefined);
    assert.equal(unref, true);
  }
});

test('macOS and Linux launchers still pass the URL as one argument', () => {
  for (const [platform, expected] of [['darwin', 'open'], ['linux', 'xdg-open']]) {
    const { command, args, options, unref } = capture(platform, loginURL);
    assert.equal(command, expected);
    assert.deepEqual(args, [loginURL]);
    assert.equal(options.env, undefined);
    assert.equal(unref, true);
  }
});

test('launcher failures leave manual URL login available', () => {
  for (const failure of ['throw', 'event']) {
    assert.doesNotThrow(() => capture('win32', loginURL, failure));
  }
});

test('Windows PowerShell passes all characters unchanged to Start-Process', { skip: process.platform !== 'win32' }, () => {
  for (const url of [loginURL, unusualURL]) {
    const { command, args, options } = capture('win32', url);
    // Replace only the final OS browser invocation, keeping the actual parser.
    const prefix = 'function Start-Process { param([string]$FilePath) [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($FilePath)) }; ';
    const result = childProcess.spawnSync(command, [...args.slice(0, -1), prefix + args.at(-1)], {
      env: options.env, windowsHide: true, encoding: 'utf8', timeout: 15000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(Buffer.from(result.stdout.trim(), 'base64').toString('utf8'), url);
  }
});

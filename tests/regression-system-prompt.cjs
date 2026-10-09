const test = require('node:test');
const assert = require('node:assert/strict');
const { env } = require('./harness.cjs');

test('asHub prompt distinguishes chat and terminal surfaces without shared mutation', () => {
  const { ASHUB_IDENTITY, ASHUB_ACTION_SCOPE, buildAshubFrontendPrompt } = env().load('src/prompts/ashub.ts');
  const chat = buildAshubFrontendPrompt();
  const terminal = buildAshubFrontendPrompt('ash-terminal');
  assert.match(ASHUB_IDENTITY, /^你是 asHub 中的 AI 助手/);
  assert.match(chat, /桌面客户端或浏览器/);
  assert.match(terminal, /agent 终端会话/);
  assert(!terminal.includes('当前是 asHub 的会话界面'));
  assert.equal(buildAshubFrontendPrompt('agent'), chat);
  assert.match(ASHUB_ACTION_SCOPE, /明确的创建、修改、修复或交付请求/);
  assert.match(ASHUB_ACTION_SCOPE, /实际工具权限、审批结果与用户设置始终有效/);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { withMemory } from '../context.mjs';
import { Assistant } from '../shared.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-recall-'));
  const session = { instanceId: 'assistant', kind: 'agent', cwd: dir };
  const assistant = new Assistant({
    dataDirectory: dir,
    host: { snapshot: () => ({ sessions: [session], projects: [] }) },
  });
  t.after(() => { assistant.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  assistant.store.bind(session.instanceId, session.cwd, true);

  for (const [title, content] of [
    ['花生过敏', '我对花生过敏，聚餐要避免含花生的菜'],
    ['会议纪要', '会议纪要要整理为 Markdown'],
    ['台风预警', '台风预警通过短信接收'],
  ]) {
    assistant.store.add({ title, content, kind: 'fact', scope: 'personal' }, { type: 'user', at: 1 }, 'active');
  }
  return messages => withMemory(messages, assistant, session.instanceId);
}

const attachmentText = '来自附录的无关文字。'.repeat(60);
const titles = prefix => JSON.parse(prefix.split('\n')[1]).items.map(item => item.title).sort();

test('long multipart messages recall from both ends without expanding the query or altering the request', t => {
  const recall = fixture(t);
  const body = '聚餐时怎么避开花生过敏？\n' + attachmentText + '\n台风预警\n'
    + attachmentText + '\n会议纪要有格式要求吗？';
  const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,fixture' } };
  const parts = [{ type: 'text', text: body }, image];
  const messages = [{ role: 'user', content: parts }];
  const result = recall(messages);

  assert.deepEqual(titles(result[0].content[0].text), ['会议纪要', '花生过敏'].sort());
  assert.deepEqual(result[0].content.slice(1), parts);
  assert.equal(result[0].content[2], image);
  assert.equal(messages[0].content, parts);
});

test('short follow-ups keep the beginning of the preceding long user turn through tool continuation', t => {
  const recall = fixture(t);
  const user = { role: 'user', content: '聚餐时怎么避开花生过敏？\n' + attachmentText };
  const messages = [
    user,
    { role: 'assistant', content: '台风预警' },
    { role: 'user', content: '那按我的情况呢？' },
    { role: 'tool', tool_call_id: 'call-1', content: '原结果' },
  ];
  const result = recall(messages);

  assert.deepEqual(titles(result.at(-1).content), ['花生过敏']);
  assert.equal(result.at(-1).tool_call_id, 'call-1');
  assert.ok(result.at(-1).content.endsWith('原结果'));
  assert.equal(messages.at(-1).content, '原结果');
  assert.equal(result[0], user);

  const generated = [{ ...user, content: '[Compacted conversation]\n' + user.content }, messages[2]];
  assert.equal(recall(generated), generated);
});

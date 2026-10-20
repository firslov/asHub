const test = require('node:test');
const assert = require('node:assert/strict');
const { env } = require('./harness.cjs');
const { unicodeSlice, clipHeadTail, wellFormedText, wellFormedJson, guardLlmUnicode } = env().load('src/unicode.ts');

test('all head/tail boundary positions retain well-formed text within budgets', () => {
  for (const [head, tail] of [[1500,500], [300,200], [0,0], [5,0], [0,5]]) {
    for (const pos of [head - 1, head, head + 1, head + 100, head + 101]) {
      const text = 'a'.repeat(Math.max(0, pos)) + '🟡' + 'z'.repeat(head + tail + 10);
      const result = clipHeadTail(text, head, tail);
      assert(result.isWellFormed());
      const match = result.match(/^(.*)\n\[\.\.\. (\d+) chars truncated \.\.\.\]\n(.*)$/s);
      assert(match);
      assert(match[1].length <= head && match[3].length <= tail);
      assert.equal(Number(match[2]), text.length - match[1].length - match[3].length);
    }
    const text = 'a'.repeat(head + 100) + '🟡' + 'b'.repeat(Math.max(0, tail - 1));
    assert(clipHeadTail(text, head, tail).isWellFormed());
  }
  assert.equal(clipHeadTail('中文 🟡',1500,500),'中文 🟡');
});

test('unicodeSlice protects both boundaries, including resume and summary limits', () => {
  for (const limit of [60,80,200,300,500,1500,2000]) {
    assert.equal(unicodeSlice('a'.repeat(limit-1)+'🟡z',0,limit),'a'.repeat(limit-1));
  }
  const text = 'a🟡b🌍c';
  for (let start = -10; start <= 10; start++) for (let end = -10; end <= 10; end++) {
    const sliced = unicodeSlice(text,start,end);
    assert(sliced.isWellFormed()); assert(sliced.length <= text.slice(start,end).length);
  }
});

test('repair changes lone surrogates only and never edits caller-owned history', () => {
  const good = '中文 🟡 👩🏽‍💻 é \\ud83d';
  assert.equal(wellFormedText(good), good);
  assert.equal(wellFormedText('\ud83dX\udfe1'), '�X�');
  const input = Object.freeze({messages:Object.freeze([{content:[{type:'text',text:'bad \ud83d'}],reasoning_content:'\udfe1',tool_calls:[{function:{arguments:'literal \\ud83d'}}]}])});
  const result = wellFormedJson(input);
  assert.equal(result.messages[0].content[0].text,'bad �');
  assert.equal(result.messages[0].reasoning_content,'�');
  assert.equal(result.messages[0].tool_calls[0].function.arguments,'literal \\ud83d');
  assert.equal(input.messages[0].content[0].text,'bad \ud83d');
});

test('guard preserves signals, binding, streaming return type and reconfiguration', () => {
  const controller = new AbortController(), streamResult = { [Symbol.asyncIterator]: async function* () {} };
  const calls = [];
  const client = {
    model: 'first',
    stream(options) { calls.push({model:this.model,options}); return streamResult; },
    complete(options) { calls.push({model:this.model,options}); return Promise.resolve('ok'); },
  };
  guardLlmUnicode(client); const wrapped = client.stream; guardLlmUnicode(client); assert.equal(client.stream,wrapped);
  const options = {messages:[{content:'bad \ud83d'}],signal:controller.signal,headers:{'X-Test':'normal'},max_tokens:123};
  assert.equal(client.stream(options),streamResult);
  assert.equal(calls[0].options.signal,controller.signal);
  assert.equal(calls[0].options.max_tokens,123);
  assert.equal(calls[0].options.messages[0].content,'bad �');
  controller.abort(); assert(calls[0].options.signal.aborted);
  client.model='second'; client.complete(options); assert.equal(calls[1].model,'second');
});

test('JSON copying preserves sparse arrays, special keys and rejects repair collisions', () => {
  const arr = new Array(4); arr[1]='🟡'; assert.equal(JSON.stringify(wellFormedJson(arr)),JSON.stringify(arr));
  const value=JSON.parse('{"__proto__":"safe","x":"ok"}');
  assert.equal(JSON.stringify(wellFormedJson(value)),JSON.stringify(value));
  assert.equal(wellFormedJson({'\ud83d':'ok'})['�'],'ok');
  assert.throws(()=>wellFormedJson({'\ud83d':1,'�':2}), /duplicate JSON keys/);
});

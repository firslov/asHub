const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
// The server website is maintained separately from the application repository.
const hasRemote = fs.existsSync(path.join(root, 'remote'));
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
function load(remote = false, compatible = true) {
  const context = vm.createContext({});
  vm.runInContext(read(remote ? 'remote/public/marked.min.js' : 'web/vendor/marked.min.js'), context);
  if (compatible) vm.runInContext(read(remote ? 'remote/public/markdown-compat.js' : 'web/js/markdown-compat.js'), context);
  context.marked.setOptions({ breaks: true, gfm: true });
  return context;
}
const sentence = '没有证据覆盖的部分默认“未检查”，不是默认通过。';
const rest = '正式库、恢复候选、原始压缩包和暂缓恢复情形分别登记，结论不会相互串用。';
for (const remote of hasRemote ? [false, true] : [false]) {
  const label = remote ? 'remote' : 'desktop';
  test(`${label}: real Chinese reply renders bold without changing token text`, () => {
    const { marked } = load(remote);
    const source = `**${sentence}**${rest}`;
    assert.equal(marked.parse(source), `<p><strong>${sentence}</strong>${rest}</p>\n`);
    const token = marked.lexer(source)[0].tokens[0];
    assert.equal(token.type, 'strong');
    assert.equal(token.raw, `**${sentence}**`);
    assert.equal(token.text, sentence);
    assert.equal(source, `**${sentence}**${rest}`);
  });
  test(`${label}: CJK quotes, lists, tables, adjacent bold and inline code`, () => {
    const { marked } = load(remote);
    for (const source of [
      '中文**“未检查”**正式库',
      '- **没有证据。**正式库',
      '| 状态 | 说明 |\n| --- | --- |\n| 未检查 | **没有证据。**正式库 |',
      '`code` **没有证据。**正式库',
      '**没有证据。**正式库 **其他**',
      '**包含 `code` 和 *说明*。**正式库',
    ]) assert.match(marked.parse(source), /<strong>[^]*?<\/strong>/, source);
    assert.equal(marked.parse('中文**“未检查”**正式库'), '<p>中文<strong>“未检查”</strong>正式库</p>\n');
    assert.equal(marked.parse('**没有证据。**正式库 **其他**'), '<p><strong>没有证据。</strong>正式库 <strong>其他</strong></p>\n');
    assert.equal(marked.parse('**包含 `code` 和 *说明*。**正式库'), '<p><strong>包含 <code>code</code> 和 <em>说明</em>。</strong>正式库</p>\n');
  });
  test(`${label}: standard Markdown and protected syntax retain original behavior`, () => {
    const baseline = load(remote, false).marked;
    const { marked } = load(remote);
    for (const source of [
      '**normal**', '**中文**', '**中文。** 后文', '***中文。***后文',
      '*emphasis* and **strong**', '**outer *inner* text**', '__中文__',
      'plain **literal', '** 中文。**后文', '**中文。 **后文',
      '***中文。**后文', '**中文。***后文', '**English.**next',
      '`**没有证据。**正式库`', '``**没有证据。**正式库``',
      '```md\n**没有证据。**正式库\n```', '    **没有证据。**正式库',
      String.raw`\*\*没有证据。\*\*正式库`,
      String.raw`**中文\*\*说明。**正式库`,
      '<pre>**没有证据。**正式库</pre>', '<code>**没有证据。**正式库</code>',
      '<span title="**没有证据。**正式库">内容</span>',
      '[文档](https://example.com/**没有证据。**正式库)',
      '![图片](image.png "**没有证据。**正式库")',
      '<https://example.com/**没有证据。**正式库>',
      '$**中文。**后文$', '$$**中文。**后文$$',
      String.raw`\(**中文。**后文\)`, String.raw`\[**中文。**后文\]`,
      '**第一行\n第二行。**后文',
    ]) assert.equal(marked.parse(source), baseline.parse(source), source);
  });
  test(`${label}: streaming prefixes converge to history rendering`, () => {
    const { marked } = load(remote);
    const source = `**${sentence}**${rest}`;
    const baseline = load(remote, false).marked;
    for (let i = 0; i <= source.length; i++) {
      const prefix = source.slice(0, i);
      const html = marked.parse(prefix);
      if (i < sentence.length + 4) assert.equal(html, baseline.parse(prefix));
      else assert.ok(html.includes(`<strong>${sentence}</strong>`), prefix);
    }
    assert.equal(marked.parse(source), load(remote).marked.parse(source));
  });
  test(`${label}: registering twice is harmless`, () => {
    const context = load(remote);
    const source = `**${sentence}**${rest}`;
    const html = context.marked.parse(source);
    vm.runInContext(read('web/js/markdown-compat.js'), context);
    assert.equal(context.marked.parse(source), html);
  });
}
test('desktop loads the compatibility rule after Marked and before the client', () => {
  const html = read('web/index.html');
  assert.ok(html.indexOf('markdown-compat.js') > html.indexOf('marked.min.js'));
  assert.ok(html.indexOf('markdown-compat.js') < html.indexOf('/js/client.js'));
});
test('mobile ships the same rule in the correct load order and offline cache', {
  skip: hasRemote ? false : 'Remote website is not included in this checkout',
}, () => {
  assert.equal(read('web/js/markdown-compat.js'), read('remote/public/markdown-compat.js'));
  const html = read('remote/public/index.html');
  assert.ok(html.indexOf('markdown-compat.js') > html.indexOf('marked.min.js'));
  assert.ok(html.indexOf('markdown-compat.js') < html.indexOf('./app.js'));
  assert.match(read('remote/public/sw.js'), /'\.\/markdown-compat\.js'/);
});

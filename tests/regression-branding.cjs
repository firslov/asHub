const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { inflateSync } = require('node:zlib');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8');
const firstScript = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const paths = svg => [...svg.matchAll(/<path\b[^>]*\bd="([^"]+)"/g)].map(m => m[1]);

test('native Mac controls reserve space before first paint, browsers do not', () => {
  for (const [native, browser, platform, inset] of [
    ['darwin', 'MacIntel', 'darwin', 'mac'],
    ['win32', 'MacIntel', 'win32', ''],
    ['linux', 'Linux x86_64', 'linux', ''],
    [null, 'MacIntel', 'darwin', ''],
    [null, 'Win32', 'win32', ''],
  ]) {
    const document = { documentElement: { dataset: {} } };
    vm.runInNewContext(firstScript, {
      document, navigator: { platform: browser },
      window: native ? { electronAPI: { platform: native } } : {},
    });
    assert.equal(document.documentElement.dataset.platform, platform);
    assert.equal(document.documentElement.dataset.nativeTitlebar, inset);
  }
});

test('welcome, loading and favicon share the vector brand geometry', () => {
  const master = paths(fs.readFileSync(path.join(root, 'web/assets/brand/mark.svg'), 'utf8'));
  assert(master.length > 0, 'the shared mark must contain visible geometry');
  const marks = [...html.matchAll(/<svg\b[^>]*class="[^"]*brand-mark[^"]*"[\s\S]*?<\/svg>/g)];
  assert.equal(marks.length, 3);
  for (const [svg] of marks) assert.deepEqual(paths(svg), master);
  assert.deepEqual(paths(fs.readFileSync(path.join(root, 'web/assets/brand/icon.svg'), 'utf8')), master);
  for (const file of ['electron/icon.svg', 'electron/tray.svg', 'remote/public/icon.svg']) {
    // The remote website is maintained separately and is absent in core CI.
    if (file.startsWith('remote/') && !fs.existsSync(path.join(root, file))) continue;
    assert.deepEqual(paths(fs.readFileSync(path.join(root, file), 'utf8')), master, `${file} must not retain an older identity`);
  }
});

test('both titlebar wordmarks match the locally supported font master', () => {
  const asset = fs.readFileSync(path.join(root, 'web/assets/brand/wordmark.svg'), 'utf8');
  const text = asset.match(/<text\b[\s\S]*?<\/text>/)[0];
  const words = [...html.matchAll(/<svg class="brand-wordmark"[\s\S]*?<\/svg>/g)];
  assert.equal(words.length, 2);
  for (const [svg] of words) {
    assert(svg.replace(/(?:win|title)-lettering/g, "brand-lettering").includes(text));
    assert.deepEqual(paths(svg), paths(asset), 'the titlebar flourish must also match its master');
  }
  const fonts = fs.readFileSync(path.join(root, 'web/vendor/fonts/fonts.css'), 'utf8');
  for (const [style, weight] of [['italic', '400'], ['normal', '600']]) {
    const faces = fonts.split('@font-face');
    assert(faces.some(face => face.includes("font-family: 'Source Serif 4'") &&
      face.includes(`font-style: ${style}`) && face.includes(`font-weight: ${weight}`)));
  }
});

test('wordmark paint servers have unique IDs in the shared document', () => {
  const ids = [...html.matchAll(/<linearGradient id="([^"]+)"/g)].map(m => m[1]);
  assert.equal(new Set(ids).size, ids.length);
  for(const [,ref] of html.matchAll(/fill="url\(#([^)]*)\)"/g)) assert(ids.includes(ref));
});

// Decode the generated RGBA PNGs without introducing a new runtime dependency.
// Inspect pixels as well as headers: a correctly sized but blank or opaque Mac
// template is accepted by nativeImage, yet produces an unusable status-bar icon.
function readPng(data, size, label) {
  assert(data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `${label}: PNG signature`);
  let offset = 8, header, ended = false;
  const image = [];
  while (offset < data.length) {
    assert(offset + 12 <= data.length, `${label}: truncated chunk`);
    const length = data.readUInt32BE(offset), type = data.toString('ascii', offset + 4, offset + 8);
    assert(offset + 12 + length <= data.length, `${label}: truncated ${type}`);
    const content = data.subarray(offset + 8, offset + 8 + length);
    if (!header) {
      assert.equal(type, 'IHDR', `${label}: first chunk`);
      assert.equal(length, 13);
      header = content;
      assert.equal(header.readUInt32BE(0), size, `${label}: width`);
      assert.equal(header.readUInt32BE(4), size, `${label}: height`);
      assert.deepEqual([...header.subarray(8)], [8, 6, 0, 0, 0], `${label}: generated icons must be non-interlaced RGBA8`);
    } else if (type === 'IHDR') assert.fail(`${label}: duplicate IHDR`);
    if (type === 'IDAT') image.push(content);
    offset += length + 12;
    if (type === 'IEND') { assert.equal(length, 0); ended = true; break; }
  }
  assert(ended && image.length && offset === data.length, `${label}: complete PNG stream`);
  const stride = size * 4, raw = inflateSync(Buffer.concat(image), { maxOutputLength: (stride + 1) * size });
  assert.equal(raw.length, (stride + 1) * size, `${label}: pixel payload size`);
  const pixels = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    const filter = raw[y * (stride + 1)];
    assert(filter <= 4, `${label}: invalid row filter`);
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x, left = x >= 4 ? pixels[at - 4] : 0;
      const above = y ? pixels[at - stride] : 0, corner = y && x >= 4 ? pixels[at - stride - 4] : 0;
      const p = left + above - corner, a = Math.abs(p - left), b = Math.abs(p - above), c = Math.abs(p - corner);
      const predictor = filter === 1 ? left : filter === 2 ? above : filter === 3 ? Math.floor((left + above) / 2)
        : filter === 4 ? (a <= b && a <= c ? left : b <= c ? above : corner) : 0;
      pixels[at] = (raw[y * (stride + 1) + x + 1] + predictor) & 255;
    }
  }
  let visible = 0, transparent = 0, solid = 0;
  const colors = new Set();
  for (let at = 0; at < pixels.length; at += 4) {
    const alpha = pixels[at + 3];
    if (alpha) { visible++; colors.add(pixels.readUIntBE(at, 3)); }
    else transparent++;
    if (alpha === 255) solid++;
  }
  assert(visible > size * size * .05 && solid > 0, `${label}: visible, nonblank artwork`);
  return { pixels, visible, transparent, colors };
}

test('desktop and template PNGs have usable sizes, alpha and monochrome template pixels', () => {
  for (const [file, size, template] of [
    ['electron/icon.png', 1024, false], ['electron/tray.png', 64, false],
    ['electron/trayTemplate.png', 18, true], ['electron/trayTemplate@2x.png', 36, true],
  ]) {
    const decoded = readPng(fs.readFileSync(path.join(root, file)), size, file);
    assert(decoded.transparent > 0, `${file}: transparent surrounding pixels`);
    if (template) assert.equal(decoded.colors.size, 1, `${file}: a Mac template must be monochrome`);
    else assert(decoded.colors.size > 1, `${file}: colored application artwork`);
  }
});

test('Windows ICO directories point to complete matching PNG frames, including small and HiDPI sizes', () => {
  for (const [file, sizes] of [
    ['electron/icon.ico', [16, 24, 32, 48, 64, 128, 256]],
    ['electron/tray.ico', [16, 20, 24, 32, 48, 64, 256]],
  ]) {
    const data = fs.readFileSync(path.join(root, file));
    assert.equal(data.readUInt16LE(0), 0); assert.equal(data.readUInt16LE(2), 1);
    assert.equal(data.readUInt16LE(4), sizes.length);
    let next = 6 + sizes.length * 16;
    sizes.forEach((size, index) => {
      const at = 6 + index * 16;
      assert.equal(data[at] || 256, size); assert.equal(data[at + 1] || 256, size);
      assert.equal(data[at + 3], 0); assert.equal(data.readUInt16LE(at + 4), 1); assert.equal(data.readUInt16LE(at + 6), 32);
      const length = data.readUInt32LE(at + 8), start = data.readUInt32LE(at + 12);
      assert.equal(start, next, `${file}: frames must not overlap or leave stale trailing data`);
      assert(length > 0 && start + length <= data.length, `${file}: frame bounds`);
      readPng(data.subarray(start, start + length), size, `${file}/${size}`);
      next += length;
    });
    assert.equal(next, data.length, `${file}: directory accounts for the entire file`);
  }
});

test('Mac ICNS contains correctly sized PNG chunks for standard and Retina representations', () => {
  const data = fs.readFileSync(path.join(root, 'electron/icon.icns'));
  assert.equal(data.toString('ascii', 0, 4), 'icns'); assert.equal(data.readUInt32BE(4), data.length);
  const expected = { icp4: 16, icp5: 32, icp6: 64, ic07: 128, ic08: 256, ic09: 512, ic10: 1024, ic11: 32, ic12: 64, ic13: 256, ic14: 512 };
  const seen = new Set();
  for (let offset = 8; offset < data.length;) {
    assert(offset + 8 <= data.length, 'truncated ICNS chunk');
    const type = data.toString('ascii', offset, offset + 4), length = data.readUInt32BE(offset + 4);
    assert(Object.hasOwn(expected, type) && !seen.has(type), `unexpected or duplicate ICNS type ${type}`);
    assert(length > 8 && offset + length <= data.length, `${type}: complete ICNS payload`);
    readPng(data.subarray(offset + 8, offset + length), expected[type], `ICNS/${type}`);
    seen.add(type); offset += length;
  }
  assert.deepEqual([...seen].sort(), Object.keys(expected).sort());
});

test('available PWA icons match manifest dimensions and the Apple icon has an opaque background', t => {
  const remote = path.join(root, 'remote/public');
  if (!fs.existsSync(path.join(remote, 'icon.svg'))) return t.skip('remote website is absent from this core-only checkout');
  const manifest = JSON.parse(fs.readFileSync(path.join(remote, 'manifest.webmanifest'), 'utf8'));
  for (const size of [192, 512]) {
    const file = `icon-${size}.png`;
    assert(manifest.icons.some(icon => icon.src === `./${file}` && icon.sizes === `${size}x${size}` && icon.type === 'image/png'));
    readPng(fs.readFileSync(path.join(remote, file)), size, file);
  }
  const apple = readPng(fs.readFileSync(path.join(remote, 'apple-touch-icon.png')), 180, 'Apple touch icon');
  assert.equal(apple.transparent, 0, 'iOS must receive an opaque app background');
  for (let at = 3; at < apple.pixels.length; at += 4) assert.equal(apple.pixels[at], 255);
});

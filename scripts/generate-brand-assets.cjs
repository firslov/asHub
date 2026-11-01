// Render the checked-in SVG masters; no image service or native image library.
// Run: npx electron scripts/generate-brand-assets.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-brand-'));
app.setPath('userData', profile);
app.on('window-all-closed', () => {});
let win;
const watchdog = setTimeout(() => finish(1), 60000);

async function render(file, size, background = null) {
  const svg = fs.readFileSync(path.join(root, file), 'utf8');
  const source = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
  const data = await win.webContents.executeJavaScript(`(async () => {
    const image = new Image(); image.src = ${JSON.stringify(source)}; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = ${size};
    const ctx = canvas.getContext('2d');
    if (${JSON.stringify(background)}) { ctx.fillStyle = ${JSON.stringify(background)}; ctx.fillRect(0, 0, ${size}, ${size}); }
    ctx.drawImage(image, 0, 0, ${size}, ${size}); return canvas.toDataURL('image/png');
  })()`);
  return Buffer.from(data.split(',')[1], 'base64');
}

function ico(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, index) => {
    const at = 6 + index * 16;
    header[at] = header[at + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(png.length, at + 8); header.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map(image => image.png)]);
}

function icns(images) {
  const chunks = images.map(({ type, png }) => {
    const head = Buffer.alloc(8); head.write(type); head.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([head, png]);
  });
  const head = Buffer.alloc(8); head.write('icns');
  head.writeUInt32BE(8 + chunks.reduce((size, chunk) => size + chunk.length, 0), 4);
  return Buffer.concat([head, ...chunks]);
}

app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  await win.loadURL('about:blank');
  const images = new Map();
  for (const size of [16, 20, 24, 32, 48, 64, 128, 256, 512, 1024]) images.set(size, await render('electron/icon.svg', size));
  const write = (file, data) => fs.writeFileSync(path.join(root, file), data);
  write('electron/icon.png', images.get(1024));
  write('electron/icon.ico', ico([16, 24, 32, 48, 64, 128, 256].map(size => ({ size, png: images.get(size) }))));
  write('electron/icon.icns', icns(Object.entries({ icp4:16, icp5:32, icp6:64, ic07:128, ic08:256, ic09:512, ic10:1024, ic11:32, ic12:64, ic13:256, ic14:512 }).map(([type, size]) => ({ type, png: images.get(size) }))));
  write('electron/tray.png', images.get(64));
  write('electron/tray.ico', ico([16, 20, 24, 32, 48, 64, 256].map(size => ({ size, png: images.get(size) }))));
  write('electron/trayTemplate.png', await render('electron/tray.svg', 18));
  write('electron/trayTemplate@2x.png', await render('electron/tray.svg', 36));
  if (fs.existsSync(path.join(root, 'remote/public/icon.svg'))) {
    for (const size of [192, 512]) write(`remote/public/icon-${size}.png`, await render('remote/public/icon.svg', size));
    write('remote/public/apple-touch-icon.png', await render('remote/public/icon.svg', 180, '#272824'));
  }
  console.log('Generated application, tray and available PWA icons from SVG masters');
}).then(() => finish(0), error => { console.error(error); finish(1); });

function finish(code) {
  clearTimeout(watchdog);
  if (win && !win.isDestroyed()) win.destroy();
  fs.rmSync(profile, { recursive: true, force: true });
  app.exit(code);
}

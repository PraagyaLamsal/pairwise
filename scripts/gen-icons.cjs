// Rasterizes the SVG sources in resources/icons with Chromium (run inside Electron):
//   xvfb-run -a npx electron --no-sandbox scripts/gen-icons.cjs
const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

const dir = join(__dirname, '..', 'resources', 'icons');

const jobs = [
  { svg: 'tray.svg', out: 'trayTemplate.png', size: 16 },
  { svg: 'tray.svg', out: 'trayTemplate@2x.png', size: 32 },
  { svg: 'tray-live.svg', out: 'tray-liveTemplate.png', size: 16 },
  { svg: 'tray-live.svg', out: 'tray-liveTemplate@2x.png', size: 32 },
  { svg: 'app-icon.svg', out: 'icon.png', size: 1024 },
  { svg: 'app-icon.svg', out: 'icon-256.png', size: 256 },
];

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 200, height: 200, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<html><body></body></html>');
  const available = new Set(readdirSync(dir));
  for (const job of jobs) {
    if (!available.has(job.svg)) continue;
    const svg = readFileSync(join(dir, job.svg), 'utf8');
    const dataUrl = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
    const png = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = ${job.size}; c.height = ${job.size};
        const ctx = c.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, ${job.size}, ${job.size});
        resolve(c.toDataURL('image/png'));
      };
      img.onerror = reject;
      img.src = ${JSON.stringify(dataUrl)};
    })`);
    writeFileSync(join(dir, job.out), Buffer.from(png.split(',')[1], 'base64'));
    console.log('wrote', job.out);
  }
  app.quit();
});

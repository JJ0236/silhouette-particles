// Windows shell for the installation.
//
// Three things this wrapper buys over running it in a browser:
//   - a pinned Chromium, so the vision pipeline behaves identically on every
//     machine instead of tracking whatever the system browser became overnight;
//   - camera permission granted up front, so a power-cycled installation comes
//     back on its own with nobody there to click Allow;
//   - real control of which display it occupies, which a browser cannot do.
//
// CommonJS on purpose: the app itself is ESM, but an Electron main process in
// ESM is fragile across packagers, and this file has no reason to be clever.

const { app, BrowserWindow, screen, ipcMain, shell } = require('electron');
const { createServer } = require('node:http');
const { readFile, stat } = require('node:fs/promises');
const { extname, join, normalize } = require('node:path');
const { autoUpdater } = require('electron-updater');

const ROOT = join(__dirname, '..');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
};

// Serve over http://127.0.0.1 rather than file://.
//
// getUserMedia requires a secure context, and file:// is not one. Serving on
// loopback keeps the exact MIME behaviour the app was built against — Chromium
// refuses an ES module delivered as anything but a JS type.
function startServer() {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://127.0.0.1');
        let path = decodeURIComponent(url.pathname);
        if (path.endsWith('/')) path += 'index.html';
        const full = join(ROOT, normalize(path).replace(/^(\.\.[/\\])+/, ''));
        if (!full.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
        const info = await stat(full);
        if (info.isDirectory()) { res.writeHead(404).end('not found'); return; }
        const body = await readFile(full);
        res.writeHead(200, {
          'Content-Type': TYPES[extname(full).toLowerCase()] || 'application/octet-stream',
          'Content-Length': body.length,
          'Cache-Control': 'no-store',
        });
        res.end(body);
      } catch {
        res.writeHead(404).end('not found');
      }
    });
    server.on('error', reject);
    // Port 0: let the OS pick a free one, so two copies never collide.
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

// The projector is the display that is not the one with the desktop on it.
function installationDisplay() {
  const all = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  return all.find((d) => d.id !== primary.id) ?? primary;
}

let win = null;

async function createWindow() {
  const port = await startServer();
  const target = installationDisplay();

  win = new BrowserWindow({
    x: target.bounds.x, y: target.bounds.y,
    width: target.bounds.width, height: target.bounds.height,
    backgroundColor: '#000000',
    fullscreen: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,   // a projector piece must not slow when unfocused
    },
  });

  // Grant the camera without a prompt. An installation gets power-cycled and
  // has to come back by itself; there is nobody standing there to click Allow.
  const ses = win.webContents.session;
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media' || permission === 'fullscreen');
  });
  ses.setPermissionCheckHandler(() => true);

  win.loadURL(`http://127.0.0.1:${port}/`);
  win.on('closed', () => { win = null; });

  // Never navigate away or spawn windows; this is a kiosk.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

app.whenReady().then(async () => {
  await createWindow();

  // Check on launch and hourly. Downloads happen in the background and install
  // on quit, so a running installation is never interrupted mid-show.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  const check = () => autoUpdater.checkForUpdates().catch((e) => console.warn('[update]', e.message));
  check();
  setInterval(check, 60 * 60 * 1000);

  // Report every stage, not just success. An installation that silently fails
  // to update looks identical to one that is already current, and the two need
  // very different responses.
  const say = (state, detail) => { if (win) win.webContents.send('update-state', { state, detail }); };
  autoUpdater.on('checking-for-update', () => say('checking'));
  autoUpdater.on('update-not-available', () => say('current', app.getVersion()));
  autoUpdater.on('update-available', (i) => say('downloading', i.version));
  autoUpdater.on('download-progress', (p) => say('downloading', `${Math.round(p.percent)}%`));
  autoUpdater.on('update-downloaded', (i) => {
    console.info('[update] ready:', i.version);
    say('ready', i.version);
  });
  autoUpdater.on('error', (e) => { console.warn('[update]', e); say('failed', e?.message ?? String(e)); });
});

ipcMain.handle('app-version', () => app.getVersion());
ipcMain.handle('quit-and-install', () => autoUpdater.quitAndInstall());
ipcMain.handle('displays', () => screen.getAllDisplays().map((d) => ({
  id: d.id, bounds: d.bounds, primary: d.id === screen.getPrimaryDisplay().id,
})));

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!win) createWindow(); });

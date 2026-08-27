// Minimal bridge. The page stays a plain web app: everything it needs from the
// shell is exposed here explicitly, with context isolation left on.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('installation', {
  version: () => ipcRenderer.invoke('app-version'),
  displays: () => ipcRenderer.invoke('displays'),
  quitAndInstall: () => ipcRenderer.invoke('quit-and-install'),
  onUpdateReady: (fn) => ipcRenderer.on('update-ready', (_e, v) => fn(v)),
});

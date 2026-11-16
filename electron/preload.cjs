// MultimediaMX — puente seguro entre la interfaz y el sistema
// Copyright (C) 2026 Santiago Miguel — GPL-3.0-or-later
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = (ch) => (arg) => ipcRenderer.invoke(ch, arg);

contextBridge.exposeInMainWorld('mmx', {
  openFiles: call('open-files'),
  openFolder: call('open-folder'),
  scanFolder: call('scan-folder'),
  openPlaylist: call('open-playlist'),
  readPlaylist: call('read-playlist'),
  savePlaylist: call('save-playlist'),
  probe: call('probe'),
  sourceUrl: call('source-url'),
  meta: call('meta'),
  sidecars: call('sidecars'),
  extractSubtitle: call('extract-subtitle'),
  httpGet: call('http-get'),
  httpPeek: call('http-peek'),
  exists: call('exists'),
  reveal: call('reveal'),
  openExternal: call('open-external'),
  takePending: call('take-pending'),
  appInfo: call('app-info'),
  setFullscreen: call('set-fullscreen'),
  setAlwaysOnTop: call('set-always-on-top'),
  setMini: call('set-mini'),
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return null; } },
  onOpenFiles: (cb) => ipcRenderer.on('open-files', (_e, files) => cb(files))
});

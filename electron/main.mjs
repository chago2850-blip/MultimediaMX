// MultimediaMX — proceso principal de escritorio (macOS, Windows, Linux)
// Copyright (C) 2026 Santiago Miguel <chago2850@gmail.com>
//
// Este programa es software libre: puede redistribuirlo y/o modificarlo bajo los
// términos de la Licencia Pública General GNU publicada por la Free Software
// Foundation, ya sea la versión 3 de la Licencia o (a su elección) cualquier
// versión posterior. Se distribuye SIN NINGUNA GARANTÍA. Consulte LICENSE.

import { app, BrowserWindow, ipcMain, dialog, session, shell, Menu, nativeTheme, net } from 'electron';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { probe, decide, transcodeArgs, extractSubtitle, ffmpegPath, isMediaFile, extOf, PLAYLIST_EXT, AUDIO_EXT, VIDEO_EXT } from './media.mjs';
import { parseM3U, writeM3U, isUrl } from '../src/core/m3u.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !!process.env.MMX_DEV_URL;
const TOKEN = crypto.randomBytes(16).toString('hex');
let serverPort = 0;
let win = null;
const pendingOpen = [];

if (process.env.MMX_NO_SANDBOX) app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.setName('MultimediaMX');

// ---------------------------------------------------------------- servidor local
// Entrega archivos locales con soporte de Range y conversión al vuelo con FFmpeg.
const MIME = {
  mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', m4b: 'audio/mp4',
  aac: 'audio/aac', wav: 'audio/wav', weba: 'audio/webm', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', mkv: 'video/x-matroska',
  webm: 'video/webm', ogv: 'video/ogg', '3gp': 'video/3gpp', vtt: 'text/vtt', srt: 'text/plain', lrc: 'text/plain'
};

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://127.0.0.1');
        res.setHeader('Access-Control-Allow-Origin', '*');
        if (url.searchParams.get('k') !== TOKEN) { res.writeHead(403); return res.end(); }
        const p = url.searchParams.get('p');
        if (url.pathname === '/file') return serveFile(p, req, res);
        if (url.pathname === '/tx') return serveTranscode(p, url.searchParams, req, res);
        res.writeHead(404); res.end();
      } catch (e) {
        if (!res.headersSent) res.writeHead(500);
        res.end(String(e?.message || e));
      }
    });
    server.listen(0, '127.0.0.1', () => { serverPort = server.address().port; resolve(); });
  });
}

async function serveFile(p, req, res) {
  let st;
  try { st = await fsp.stat(p); } catch { res.writeHead(404); return res.end(); }
  const type = MIME[extOf(p)] || 'application/octet-stream';
  const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
  if (range) {
    let start = range[1] === '' ? st.size - Number(range[2]) : Number(range[1]);
    let end = range[1] !== '' && range[2] !== '' ? Number(range[2]) : st.size - 1;
    if (start >= st.size || start < 0) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    end = Math.min(end, st.size - 1);
    res.writeHead(206, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${st.size}` });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(p, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(p).pipe(res);
  }
}

function serveTranscode(p, q, req, res) {
  const opts = {
    ss: Number(q.get('ss')) || 0,
    audioOnly: q.get('ao') === '1',
    vcopy: q.get('vc') === '1',
    acopy: q.get('ac') === '1',
    audioTrack: Number(q.get('at')) || 0
  };
  const proc = spawn(ffmpegPath(), transcodeArgs(p, opts), { windowsHide: true });
  res.writeHead(200, { 'Content-Type': opts.audioOnly ? 'audio/mp4' : 'video/mp4', 'Cache-Control': 'no-store' });
  proc.stdout.pipe(res);
  proc.stderr.on('data', (d) => { if (isDev) process.stderr.write(d); });
  const kill = () => { try { proc.kill('SIGKILL'); } catch {} };
  req.on('close', kill);
  res.on('close', kill);
  proc.on('error', () => res.end());
}

const fileUrl = (p) => `http://127.0.0.1:${serverPort}/file?k=${TOKEN}&p=${encodeURIComponent(p)}`;

// ---------------------------------------------------------------- utilidades de archivos
async function scanFolder(dir, out = [], depth = 0) {
  if (depth > 12) return out;
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await scanFolder(full, out, depth + 1);
    else if (isMediaFile(e.name)) out.push(full);
  }
  return out;
}

function resolveEntry(location, baseDir) {
  if (isUrl(location)) return location;
  let loc = location;
  if (/^file:\/\//i.test(loc)) { try { return fileURLToPath(loc); } catch { return null; } }
  if (process.platform !== 'win32') loc = loc.replace(/\\/g, '/');
  return path.isAbsolute(loc) || /^[a-z]:[\\/]/i.test(loc) ? loc : path.resolve(baseDir, loc);
}

async function readPlaylist(file) {
  const raw = await fsp.readFile(file);
  // M3U simple suele venir en Latin-1; M3U8 en UTF-8
  let text = raw.toString('utf8');
  if (extOf(file) === 'm3u' && text.includes('�')) text = raw.toString('latin1');
  const parsed = parseM3U(text);
  const base = path.dirname(file);
  const items = [];
  for (const it of parsed.items) {
    const loc = resolveEntry(it.location, base);
    if (!loc) continue;
    const remote = isUrl(loc);
    items.push({ ...it, location: loc, remote, exists: remote ? true : fs.existsSync(loc) });
  }
  return { name: parsed.name || path.basename(file).replace(/\.m3u8?$/i, ''), path: file, items };
}

async function readMeta(p) {
  try {
    const mm = await import('music-metadata');
    const meta = await mm.parseFile(p, { duration: true, skipCovers: false });
    const c = meta.common;
    let cover = null;
    const pic = c.picture?.[0];
    if (pic && pic.data?.length < 4 * 1024 * 1024) cover = `data:${pic.format};base64,${Buffer.from(pic.data).toString('base64')}`;
    return {
      title: c.title || null, artist: c.artist || null, album: c.album || null, year: c.year || null,
      genre: c.genre?.[0] || null, track: c.track?.no || null, duration: meta.format.duration || null,
      codec: meta.format.codec || null, bitrate: meta.format.bitrate || null, sampleRate: meta.format.sampleRate || null,
      lyrics: extractEmbeddedLyrics(c), cover
    };
  } catch {
    return {};
  }
}

function extractEmbeddedLyrics(c) {
  const l = c.lyrics?.[0];
  if (!l) return null;
  if (typeof l === 'string') return l;
  if (l.text) return l.text;
  if (Array.isArray(l.syncText) && l.syncText.length) {
    return l.syncText.map((s) => {
      const t = (s.timestamp || 0) / 1000;
      const mm = String(Math.floor(t / 60)).padStart(2, '0');
      const ss = (t % 60).toFixed(2).padStart(5, '0');
      return `[${mm}:${ss}]${s.text}`;
    }).join('\n');
  }
  return null;
}

async function findSidecars(p) {
  const dir = path.dirname(p);
  const stem = path.basename(p).replace(/\.[^.]+$/, '');
  const out = { lrc: null, subtitles: [] };
  let list = [];
  try { list = await fsp.readdir(dir); } catch { return out; }
  for (const name of list) {
    if (!name.startsWith(stem)) continue;
    const e = extOf(name);
    const full = path.join(dir, name);
    if (e === 'lrc' && !out.lrc) out.lrc = await fsp.readFile(full, 'utf8').catch(() => null);
    if (e === 'srt' || e === 'vtt') {
      const text = await fsp.readFile(full, 'utf8').catch(() => null);
      if (text) out.subtitles.push({ label: name.slice(stem.length).replace(/^[._ -]+/, '').replace(/\.(srt|vtt)$/i, '') || 'Externo', format: e, text });
    }
  }
  return out;
}

// ---------------------------------------------------------------- IPC
function registerIpc() {
  const mediaFilters = [
    { name: 'Audio y video', extensions: [...AUDIO_EXT, ...VIDEO_EXT] },
    { name: 'Audio', extensions: AUDIO_EXT },
    { name: 'Video', extensions: VIDEO_EXT },
    { name: 'Todos los archivos', extensions: ['*'] }
  ];
  ipcMain.handle('open-files', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: mediaFilters });
    return r.canceled ? [] : r.filePaths;
  });
  ipcMain.handle('open-folder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    if (r.canceled) return [];
    return scanFolder(r.filePaths[0]);
  });
  ipcMain.handle('scan-folder', (_e, dir) => scanFolder(dir));
  ipcMain.handle('open-playlist', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Listas M3U', extensions: PLAYLIST_EXT }] });
    if (r.canceled) return [];
    return Promise.all(r.filePaths.map(readPlaylist));
  });
  ipcMain.handle('read-playlist', (_e, file) => readPlaylist(file));
  ipcMain.handle('save-playlist', async (_e, { name, items, relative }) => {
    const r = await dialog.showSaveDialog(win, {
      defaultPath: `${(name || 'Lista').replace(/[\\/:*?"<>|]/g, '_')}.m3u8`,
      filters: [{ name: 'Lista M3U8 (UTF-8)', extensions: ['m3u8'] }, { name: 'Lista M3U', extensions: ['m3u'] }]
    });
    if (r.canceled || !r.filePath) return null;
    const base = path.dirname(r.filePath);
    const out = items.map((it) => ({
      ...it,
      location: !it.remote && relative ? path.relative(base, it.location).split(path.sep).join('/') : it.location
    }));
    await fsp.writeFile(r.filePath, writeM3U(name, out), 'utf8');
    return r.filePath;
  });
  ipcMain.handle('probe', async (_e, input) => {
    const info = await probe(input);
    if (!info.ok) return { ...info, decision: { mode: 'native', audioOnly: !VIDEO_EXT.includes(extOf(input)) } };
    return { ...info, decision: decide(info) };
  });
  ipcMain.handle('source-url', (_e, { input, transcode, ss, audioOnly, vcopy, acopy, audioTrack }) => {
    if (!transcode) return isUrl(input) ? input : fileUrl(input);
    const q = new URLSearchParams({ k: TOKEN, p: input, ss: String(ss || 0), ao: audioOnly ? '1' : '0', vc: vcopy ? '1' : '0', ac: acopy ? '1' : '0', at: String(audioTrack || 0) });
    return `http://127.0.0.1:${serverPort}/tx?${q}`;
  });
  ipcMain.handle('meta', (_e, p) => readMeta(p));
  ipcMain.handle('sidecars', (_e, p) => findSidecars(p));
  ipcMain.handle('extract-subtitle', (_e, { input, index }) => extractSubtitle(input, index));
  ipcMain.handle('http-get', async (_e, url) => {
    if (!/^https:\/\//.test(url)) return { ok: false, status: 0 };
    try {
      const r = await net.fetch(url, { headers: { 'User-Agent': `MultimediaMX/${app.getVersion()} (https://github.com/chago2850-blip/MultimediaMX)` } });
      const text = await r.text();
      return { ok: r.ok, status: r.status, text };
    } catch (e) {
      return { ok: false, status: 0, error: String(e?.message || e) };
    }
  });
  ipcMain.handle('exists', (_e, p) => fs.existsSync(p));
  ipcMain.handle('reveal', (_e, p) => shell.showItemInFolder(p));
  ipcMain.handle('open-external', (_e, url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });
  ipcMain.handle('take-pending', () => pendingOpen.splice(0));
  ipcMain.handle('app-info', () => ({ version: app.getVersion(), platform: process.platform, ffmpeg: ffmpegPath(), electron: process.versions.electron }));
  ipcMain.handle('set-fullscreen', (_e, v) => win?.setFullScreen(!!v));
  ipcMain.handle('set-always-on-top', (_e, v) => win?.setAlwaysOnTop(!!v));
  ipcMain.handle('set-mini', (_e, v) => {
    if (!win) return;
    if (v) { win.__prevBounds = win.getBounds(); win.setMinimumSize(320, 140); win.setSize(420, 168); }
    else { win.setMinimumSize(760, 520); if (win.__prevBounds) win.setBounds(win.__prevBounds); }
  });
}

// ---------------------------------------------------------------- ventana
function collectArgs(argv) {
  return argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith('-') && fs.existsSync(a) && (isMediaFile(a) || PLAYLIST_EXT.includes(extOf(a)))).map((a) => path.resolve(a));
}

function createWindow() {
  nativeTheme.themeSource = 'dark';
  win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 760, minHeight: 520,
    backgroundColor: '#0b0a18',
    title: 'MultimediaMX',
    icon: path.join(__dirname, '../build/icons/512x512.png'),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  if (isDev) win.loadURL(process.env.MMX_DEV_URL);
  else win.loadFile(path.join(__dirname, '../dist/index.html'));
}

function pushOpen(files) {
  if (!files.length) return;
  pendingOpen.push(...files);
  win?.webContents.send('open-files', pendingOpen.splice(0));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', (_e, argv) => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
    pushOpen(collectArgs(argv));
  });
  app.on('open-file', (e, file) => { e.preventDefault(); if (win) pushOpen([file]); else pendingOpen.push(file); });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]) : null);
    // Permite que las transmisiones de radio/IPTV de las listas M3U pasen por el ecualizador
    session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
      const h = details.responseHeaders || {};
      const has = Object.keys(h).some((k) => k.toLowerCase() === 'access-control-allow-origin');
      if (!has && details.resourceType === 'media') h['Access-Control-Allow-Origin'] = ['*'];
      cb({ responseHeaders: h });
    });
    await startServer();
    registerIpc();
    pendingOpen.push(...collectArgs(process.argv));
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}


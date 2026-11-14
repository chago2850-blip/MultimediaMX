// Adaptador de plataforma: escritorio (Electron), Android (Capacitor) y navegador
// MultimediaMX — Copyright (C) 2026 Santiago Miguel — GPL-3.0-or-later
import { isUrl, parseM3U, writeM3U } from './m3u.js';
import { registerPlugin, CapacitorHttp } from '@capacitor/core';

const MediaLibrary = registerPlugin('MediaLibrary');

const AUDIO_EXT = ['mp3', 'flac', 'ogg', 'oga', 'opus', 'm4a', 'm4b', 'aac', 'wav', 'wma', 'ape', 'aif', 'aiff', 'aifc', 'alac', 'mka', 'ac3', 'eac3', 'dts', 'wv', 'tta', 'mpc', 'amr', 'au', 'caf', 'spx', 'mp2', 'mid', 'midi', 'weba', 'dsf', 'dff'];
const VIDEO_EXT = ['mp4', 'm4v', 'mkv', 'webm', 'avi', 'mov', 'qt', 'wmv', 'asf', 'flv', 'f4v', 'mpg', 'mpeg', 'mpe', 'm2v', 'ts', 'm2ts', 'mts', 'vob', '3gp', '3g2', 'ogv', 'rm', 'rmvb', 'divx', 'xvid', 'dv', 'mxf'];
export const extOf = (p) => (String(p).split(/[?#]/)[0].match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
export const kindOf = (p) => VIDEO_EXT.includes(extOf(p)) ? 'video' : AUDIO_EXT.includes(extOf(p)) ? 'audio' : (isUrl(p) ? 'stream' : null);
export const baseName = (p) => decodeURIComponent(String(p).split(/[?#]/)[0].split(/[\\/]/).pop() || p);
export const ACCEPT = [...AUDIO_EXT, ...VIDEO_EXT].map((e) => '.' + e).join(',') + ',audio/*,video/*';

function pickFiles(accept, multiple = true) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', () => { resolve([...input.files]); input.remove(); }, { once: true });
    input.addEventListener('cancel', () => { resolve([]); input.remove(); }, { once: true });
    input.click();
  });
}

function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'audio/x-mpegurl' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// Lectura de etiquetas en el navegador / Android
async function parseBlobMeta(blob) {
  try {
    const mm = await import('music-metadata');
    const meta = await mm.parseBlob(blob, { duration: false, skipCovers: false });
    const c = meta.common;
    let cover = null;
    const pic = c.picture?.[0];
    if (pic) {
      const b = new Blob([pic.data], { type: pic.format });
      cover = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.onerror = () => r(null); fr.readAsDataURL(b); });
    }
    const l = c.lyrics?.[0];
    return {
      title: c.title || null, artist: c.artist || null, album: c.album || null, year: c.year || null,
      duration: meta.format.duration || null, cover,
      lyrics: typeof l === 'string' ? l : l?.text || null
    };
  } catch {
    return {};
  }
}

// Lee solo el principio del archivo (etiquetas) sin descargarlo completo
async function parseStreamMeta(url) {
  const ctrl = new AbortController();
  const res = await fetch(url, { signal: ctrl.signal });
  if (!res.ok || !res.body) { ctrl.abort(); return {}; }
  try {
    const mm = await import('music-metadata');
    const size = Number(res.headers.get('content-length')) || undefined;
    const meta = await mm.parseWebStream(res.body, { mimeType: res.headers.get('content-type') || undefined, size }, { duration: false, skipPostHeaders: true });
    const c = meta.common;
    let cover = null;
    const pic = c.picture?.[0];
    if (pic) {
      const b = new Blob([pic.data], { type: pic.format });
      cover = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.onerror = () => r(null); fr.readAsDataURL(b); });
    }
    const l = c.lyrics?.[0];
    return { title: c.title || null, artist: c.artist || null, album: c.album || null, year: c.year || null, duration: meta.format.duration || null, cover, lyrics: typeof l === 'string' ? l : l?.text || null };
  } finally {
    ctrl.abort();
  }
}

// ------------------------------------------------------------------ Escritorio
function desktop() {
  const m = window.mmx;
  return {
    name: 'desktop',
    canTranscode: true,
    canScanFolders: true,
    canRevealFiles: true,
    async pickMedia() { return (await m.openFiles()).map((p) => ({ src: p })); },
    async pickFolder() { return (await m.openFolder()).map((p) => ({ src: p })); },
    async scanDevice() { return null; },
    async importPlaylists() { return m.openPlaylist(); },
    async readPlaylistPath(p) { return m.readPlaylist(p); },
    async savePlaylist(name, items, relative) { return m.savePlaylist({ name, items, relative }); },
    probe: (src) => m.probe(src),
    sourceUrl: (opts) => m.sourceUrl(opts),
    meta: (src) => m.meta(src),
    sidecars: (src) => m.sidecars(src),
    extractSubtitle: (input, index) => m.extractSubtitle({ input, index }),
    exists: (src) => m.exists(src),
    reveal: (src) => m.reveal(src),
    openExternal: (url) => m.openExternal(url),
    async httpGet(url) { return m.httpGet(url); },
    pathForFile: (f) => m.pathForFile(f),
    takePending: () => m.takePending(),
    onOpenFiles: (cb) => m.onOpenFiles(cb),
    info: () => m.appInfo(),
    setFullscreen: (v) => m.setFullscreen(v),
    setMini: (v) => m.setMini(v),
    setAlwaysOnTop: (v) => m.setAlwaysOnTop(v)
  };
}

// ------------------------------------------------------------------ Navegador / Android
const blobs = new Map(); // id efímero -> File

function web(cap) {
  const native = !!cap;
  let srv = null;
  // En Android los archivos se sirven desde un servidor local del complemento nativo (con soporte de Range)
  const fileSrc = async (p) => {
    srv = srv || await MediaLibrary.server();
    return `http://127.0.0.1:${srv.port}/f?k=${srv.token}&p=${encodeURIComponent(p.replace(/^file:\/\//, ''))}`;
  };

  const urlFor = async (src) => {
    if (isUrl(src)) return src;
    if (src.startsWith('blob:') || src.startsWith('data:')) return src;
    if (src.startsWith('mem:')) { const f = blobs.get(src); return f ? URL.createObjectURL(f) : null; }
    return native ? fileSrc(src) : src;
  };

  const fromFiles = (files) => files.map((f) => {
    const id = `mem:${crypto.randomUUID()}`;
    blobs.set(id, f);
    return { src: id, name: f.name, ephemeral: true };
  });

  return {
    name: native ? 'android' : 'web',
    canTranscode: false,
    canScanFolders: false,
    canScanDevice: native,
    canRevealFiles: false,
    async pickMedia() { return fromFiles(await pickFiles(ACCEPT)); },
    async pickFolder() { return []; },
    async scanDevice() {
      const ML = MediaLibrary;
      const perm = await ML.requestAccess().catch(() => null);
      if (!perm || (perm.audio !== 'granted' && perm.video !== 'granted')) return { denied: true };
      const r = await ML.scan();
      return (r.items || []).map((it) => ({
        src: it.path, title: it.title || null, artist: it.artist && it.artist !== '<unknown>' ? it.artist : null,
        album: it.album || null, duration: it.duration ? it.duration / 1000 : null, kind: it.isVideo ? 'video' : 'audio'
      }));
    },
    async importPlaylists() {
      const files = await pickFiles('.m3u,.m3u8,audio/x-mpegurl,application/vnd.apple.mpegurl,audio/mpegurl');
      const out = [];
      for (const f of files) {
        const buf = new Uint8Array(await f.arrayBuffer());
        let text = new TextDecoder('utf-8').decode(buf);
        if (text.includes('�')) text = new TextDecoder('latin1').decode(buf);
        const parsed = parseM3U(text);
        out.push({ name: parsed.name || f.name.replace(/\.m3u8?$/i, ''), path: null, items: parsed.items.map((it) => ({ ...it, remote: isUrl(it.location), exists: isUrl(it.location) || it.location.startsWith('/') })) });
      }
      return out;
    },
    async readPlaylistPath() { return null; },
    async savePlaylist(name, items) {
      const text = writeM3U(name, items);
      const fname = `${(name || 'Lista').replace(/[\\/:*?"<>|]/g, '_')}.m3u8`;
      if (native) {
        const { Filesystem } = await import('@capacitor/filesystem');
        await Filesystem.writeFile({ path: `MultimediaMX/${fname}`, data: text, directory: 'DOCUMENTS', encoding: 'utf8', recursive: true });
        return `Documents/MultimediaMX/${fname}`;
      }
      download(fname, text);
      return fname;
    },
    async probe(src) {
      const k = kindOf(src) || (blobs.get(src)?.type?.startsWith('video') ? 'video' : 'audio');
      return { ok: false, decision: { mode: 'native', audioOnly: k !== 'video' }, audio: [], subtitles: [] };
    },
    async sourceUrl({ input }) { return urlFor(input); },
    async meta(src) {
      if (isUrl(src)) return {};
      try {
        if (src.startsWith('mem:')) return parseBlobMeta(blobs.get(src));
        if (kindOf(src) === 'video') return {};
        return parseStreamMeta(await urlFor(src));
      } catch { return {}; }
    },
    async sidecars(src) {
      const out = { lrc: null, subtitles: [] };
      if (!native || isUrl(src) || src.startsWith('mem:')) return out;
      const stem = src.replace(/\.[^./]+$/, '');
      for (const [e, key] of [['lrc', 'lrc'], ['srt', 'sub'], ['vtt', 'sub']]) {
        try {
          const r = await fetch(await fileSrc(`${stem}.${e}`));
          if (!r.ok) continue;
          const text = await r.text();
          if (key === 'lrc') out.lrc = text; else out.subtitles.push({ label: 'Externo', format: e, text });
        } catch { /* no existe */ }
      }
      return out;
    },
    async extractSubtitle() { return null; },
    async exists(src) { return !src.startsWith('mem:') || blobs.has(src); },
    async reveal() {},
    openExternal: (url) => window.open(url, '_blank'),
    async httpGet(url) {
      try {
        if (native) {
          const r = await CapacitorHttp.get({ url, headers: { 'User-Agent': 'MultimediaMX/1.0 (https://github.com/chago2850-blip/MultimediaMX)' }, responseType: 'text' });
          return { ok: r.status >= 200 && r.status < 300, status: r.status, text: typeof r.data === 'string' ? r.data : JSON.stringify(r.data) };
        }
        const r = await fetch(url);
        return { ok: r.ok, status: r.status, text: await r.text() };
      } catch (e) {
        return { ok: false, status: 0, error: String(e) };
      }
    },
    pathForFile: () => null,
    adoptFiles: (files) => fromFiles(files),
    async takePending() { return []; },
    onOpenFiles() {},
    async info() { return { version: '1.0.0', platform: native ? 'android' : 'web' }; },
    async setFullscreen(v) {
      try { if (v) await document.documentElement.requestFullscreen(); else if (document.fullscreenElement) await document.exitFullscreen(); } catch {}
    },
    async setMini() {},
    async setAlwaysOnTop() {}
  };
}

export const platform = window.mmx ? desktop() : web(window.Capacitor?.isNativePlatform?.() ? window.Capacitor : null);

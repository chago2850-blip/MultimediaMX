// Listas M3U en línea (IPTV / radios), enlaces cortos y tipos de transmisión
// MultimediaMX — Copyright (C) 2026 Santiago Miguel — GPL-3.0-or-later
import { parseM3U, isUrl } from './m3u.js';

const MEDIA_EXT = /\.(mp3|aac|m4a|flac|ogg|oga|opus|wav|wma|mp4|m4v|mkv|webm|avi|mov|wmv|flv|mpg|mpeg|3gp|ogv|mpd)$/;
const urlPath = (u) => { try { return new URL(u).pathname.toLowerCase(); } catch { return String(u).toLowerCase(); } };

export const looksLikeM3U = (u) => isUrl(u) && /\.m3u8?$/.test(urlPath(u));
export const looksLikeHls = (u) => isUrl(u) && /\.m3u8$/.test(urlPath(u));
export const looksLikeTs = (u) => isUrl(u) && /\.ts$/.test(urlPath(u));
/** Enlace sin extensión de medio conocida (bit.ly, acortadores, paneles IPTV…). */
export const looksUnknown = (u) => isUrl(u) && !MEDIA_EXT.test(urlPath(u)) && !looksLikeM3U(u) && !looksLikeTs(u);

/** ¿El texto es una transmisión HLS (y no una lista de canales)? */
export const isHlsText = (text) => /#EXT-X-(TARGETDURATION|STREAM-INF|MEDIA-SEQUENCE|MEDIA:|KEY|VERSION|INDEPENDENT|PROGRAM-DATE-TIME)/i.test(text);
const isM3UText = (text) => /^﻿?\s*#EXTM3U/i.test(text) || /^\s*#EXTINF/im.test(text);

/** Orden de métodos para reproducir una transmisión. */
export function remoteSteps(track) {
  const src = track.src;
  if (track.hls || looksLikeHls(src)) return ['hls', 'native'];
  if (track.ts || looksLikeTs(src)) return ['mpegts', 'native', 'hls'];
  if (MEDIA_EXT.test(urlPath(src))) return ['native'];
  return ['native', 'hls', 'mpegts'];
}

const cache = new Map();

/**
 * Revisa qué hay detrás de una URL sin descargar transmisiones completas.
 * peek(url) → { ok, status, contentType, finalUrl, text|null, binary }
 * @returns {Promise<{type:'list', list:{name:string|null, items:Array}}|{type:'hls'}|{type:'ts'}|{type:'media'}|null>}
 */
export async function inspectUrl(url, peek) {
  if (cache.has(url)) return cache.get(url);
  let res;
  try { res = await peek(url); } catch { return null; }
  if (!res?.ok) return null;
  const ct = (res.contentType || '').toLowerCase();
  let out;
  if (res.text != null && isM3UText(res.text)) {
    out = isHlsText(res.text) ? { type: 'hls' } : { type: 'list', list: channelsFrom(res.text, res.finalUrl || url) };
  } else if (/mp2t/.test(ct)) out = { type: 'ts' };
  else if (/mpegurl/.test(ct)) out = { type: 'hls' };
  else out = { type: 'media' };
  cache.set(url, out);
  return out;
}

/** Convierte el texto de una lista de canales en entradas con logo, grupo y URL absoluta. */
export function channelsFrom(text, base) {
  const parsed = parseM3U(text);
  const items = [];
  for (const it of parsed.items) {
    let src = it.location;
    if (!isUrl(src)) { try { src = new URL(src, base).href; } catch { continue; } }
    if (!isUrl(src)) continue;
    const group = it.group || it.attrs?.['group-title'] || null;
    const audioGroup = /radio|music|música|musica|audio/i.test(group || '');
    const nested = looksLikeM3U(src) && !looksLikeHls(src);
    items.push({
      src, remote: true, title: it.title || it.attrs?.['tvg-name'] || null, artist: null, duration: null,
      kind: audioGroup ? 'audio' : 'video',
      logo: it.attrs?.['tvg-logo'] || null, group,
      hls: looksLikeHls(src) || undefined, ts: looksLikeTs(src) || undefined,
      // los canales de una lista se dan por buenos; solo se vuelven a revisar las sublistas .m3u
      checked: !nested
    });
  }
  return { name: parsed.name, items };
}

/** Entradas que conviene revisar: listas .m3u o enlaces sin extensión aún no revisados. */
export const needsInspection = (it) => it?.src && isUrl(it.src) && !it.checked && !it.hls && (looksLikeM3U(it.src) || looksUnknown(it.src));

/**
 * Sustituye en la lista cada entrada que resulte ser otra lista M3U por sus canales.
 * Modifica el arreglo recibido. Devuelve cuántas listas se desplegaron.
 */
export async function expandRemoteLists(items, peek, depth = 0) {
  let expanded = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!needsInspection(it)) continue;
    const r = await inspectUrl(it.src, peek);
    if (!r) continue; // sin conexión o error: se intentará otra vez más tarde
    if (r.type === 'list') {
      const children = r.list.items;
      if (depth < 2) await expandRemoteLists(children, peek, depth + 1);
      items.splice(i, 1, ...children);
      i += children.length - 1;
      expanded++;
    } else {
      it.checked = true;
      if (r.type === 'hls') it.hls = true;
      if (r.type === 'ts') it.ts = true;
      if (r.type !== 'media') it.kind = it.kind === 'audio' && it.group ? 'audio' : 'video';
    }
  }
  return expanded;
}

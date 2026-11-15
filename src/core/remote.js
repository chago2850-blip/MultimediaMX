// Listas M3U en línea (IPTV / radios) y detección de transmisiones HLS
// MultimediaMX — Copyright (C) 2026 Santiago Miguel — GPL-3.0-or-later
import { parseM3U, isUrl } from './m3u.js';

const path = (u) => { try { return new URL(u).pathname.toLowerCase(); } catch { return String(u).toLowerCase(); } };
export const looksLikeM3U = (u) => isUrl(u) && /\.m3u8?$/.test(path(u));
export const looksLikeHls = (u) => isUrl(u) && /\.m3u8$/.test(path(u));

/** ¿El texto es una transmisión HLS (y no una lista de canales)? */
export const isHlsText = (text) => /#EXT-X-(TARGETDURATION|STREAM-INF|MEDIA-SEQUENCE|MEDIA:|KEY|VERSION|INDEPENDENT)/i.test(text);

const cache = new Map();

/**
 * Si la URL es una lista de canales, devuelve sus entradas; si es HLS u otra cosa, null.
 * @param {string} url
 * @param {(url:string)=>Promise<{ok:boolean,text?:string}>} http
 */
export async function fetchChannelList(url, http) {
  if (cache.has(url)) return cache.get(url);
  let res;
  try { res = await http(url); } catch { return null; }
  if (!res?.ok || !res.text) return null;
  const text = res.text;
  if (isHlsText(text) || !/#EXTINF|^\s*https?:\/\//im.test(text)) { cache.set(url, null); return null; }
  const parsed = parseM3U(text);
  const base = url;
  const items = parsed.items.map((it) => {
    let src = it.location;
    if (!isUrl(src)) { try { src = new URL(src, base).href; } catch { /* se deja igual */ } }
    const hls = looksLikeHls(src);
    const audioGroup = /radio|music|música|musica|audio/i.test(`${it.group || ''} ${it.attrs?.['group-title'] || ''}`);
    return {
      src, remote: true, title: it.title || it.attrs?.['tvg-name'] || null, artist: null, duration: null,
      kind: audioGroup ? 'audio' : (hls || it.attrs?.['tvg-logo'] ? 'video' : 'audio'),
      logo: it.attrs?.['tvg-logo'] || null, group: it.group || it.attrs?.['group-title'] || null, hls
    };
  }).filter((x) => isUrl(x.src));
  const out = { name: parsed.name, items };
  cache.set(url, out);
  return out;
}

/**
 * Sustituye en la lista cada entrada que sea otra lista M3U en línea por sus canales.
 * Modifica el arreglo recibido y devuelve cuántas listas se desplegaron.
 */
export async function expandRemoteLists(items, http, depth = 0) {
  let expanded = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it?.src || !looksLikeM3U(it.src) || it.hls) continue;
    const list = await fetchChannelList(it.src, http);
    if (!list) { if (looksLikeHls(it.src)) { it.hls = true; it.kind = it.kind || 'video'; } continue; }
    if (depth < 2) await expandRemoteLists(list.items, http, depth + 1);
    items.splice(i, 1, ...list.items);
    i += list.items.length - 1;
    expanded++;
  }
  return expanded;
}

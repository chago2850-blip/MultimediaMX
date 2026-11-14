// Letras: incrustadas, archivo .lrc, caché y búsqueda en línea (LRCLIB y lyrics.ovh)
// MultimediaMX — Copyright (C) 2026 Santiago Miguel — GPL-3.0-or-later
import { kv } from './store.js';

/** Convierte texto LRC en líneas con tiempo. Devuelve null si no hay marcas de tiempo. */
export function parseLRC(text) {
  if (!text) return null;
  const lines = [];
  let offset = 0;
  const off = text.match(/\[offset:\s*([+-]?\d+)\]/i);
  if (off) offset = Number(off[1]) / 1000;
  for (const raw of text.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g)];
    if (!stamps.length) continue;
    const words = raw.replace(/\[[^\]]*\]/g, '').replace(/<\d+:\d+(?:\.\d+)?>/g, '').trim();
    for (const s of stamps) {
      const t = Number(s[1]) * 60 + Number(s[2].replace(':', '.')) - offset;
      lines.push({ time: Math.max(0, t), text: words });
    }
  }
  if (!lines.length) return null;
  lines.sort((a, b) => a.time - b.time);
  return lines;
}

const JUNK = /\s*[([](?:official|oficial|video|v[ií]deo|audio|lyrics?|letra|hd|4k|hq|remaster(?:ed)?|live|en vivo|visualizer|mv|clip|explicit|feat\.?[^)\]]*|ft\.?[^)\]]*)[^)\]]*[)\]]/gi;

/** Limpia título y artista; si no hay artista intenta sacarlo de «Artista - Título». */
export function guessQuery(track) {
  let artist = (track.artist || '').trim();
  let title = (track.title || '').trim();
  if (!title && track.src) title = track.src.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
  title = title.replace(/_/g, ' ').replace(/^\d{1,3}[\s.\-_]+/, '');
  if (!artist) {
    const m = title.split(/\s+[-–—]\s+/);
    if (m.length >= 2) { artist = m[0]; title = m.slice(1).join(' - '); }
  }
  title = title.replace(JUNK, '').replace(/\s+/g, ' ').trim();
  artist = artist.replace(JUNK, '').split(/\s*(?:,|&| feat\.? | ft\.? | x )\s*/i)[0].trim();
  return { artist, title, album: track.album || '', duration: track.duration || 0 };
}

const cacheKey = (q) => `lyrics:${q.artist.toLowerCase()}|${q.title.toLowerCase()}`;

async function getJson(http, url) {
  const r = await http(url);
  if (!r?.ok || !r.text) return null;
  try { return JSON.parse(r.text); } catch { return null; }
}

/**
 * Busca la letra. Orden: incrustada → .lrc junto al archivo → caché → LRCLIB → lyrics.ovh
 * @returns {Promise<{source:string, synced:Array|null, plain:string|null}|null>}
 */
export async function findLyrics(track, { http, sidecarLrc, embedded, online = true, force = false, query = null }) {
  if (!force) {
    const synced = parseLRC(sidecarLrc);
    if (synced) return { source: 'lrc', synced, plain: null };
    if (embedded) {
      const s = parseLRC(embedded);
      return { source: 'tag', synced: s, plain: s ? null : embedded };
    }
  }
  const q = query || guessQuery(track);
  if (!q.title) return null;
  if (!force) {
    const cached = await kv.get(cacheKey(q)).catch(() => null);
    if (cached) return { ...cached, synced: cached.lrc ? parseLRC(cached.lrc) : null };
  }
  if (!online || (typeof navigator !== 'undefined' && navigator.onLine === false)) return null;

  let result = null;
  // 1) LRCLIB — coincidencia exacta
  if (q.artist) {
    const p = new URLSearchParams({ artist_name: q.artist, track_name: q.title });
    if (q.album) p.set('album_name', q.album);
    if (q.duration) p.set('duration', String(Math.round(q.duration)));
    const j = await getJson(http, `https://lrclib.net/api/get?${p}`);
    if (j && (j.syncedLyrics || j.plainLyrics)) result = { source: 'LRCLIB', lrc: j.syncedLyrics || null, plain: j.plainLyrics || null };
  }
  // 2) LRCLIB — búsqueda libre, se prefiere la que tenga letra sincronizada y duración parecida
  if (!result) {
    const p = new URLSearchParams(q.artist ? { track_name: q.title, artist_name: q.artist } : { q: q.title });
    let list = await getJson(http, `https://lrclib.net/api/search?${p}`);
    if ((!Array.isArray(list) || !list.length) && q.artist) list = await getJson(http, `https://lrclib.net/api/search?${new URLSearchParams({ q: `${q.artist} ${q.title}` })}`);
    if (Array.isArray(list) && list.length) {
      const score = (x) => (x.syncedLyrics ? 2 : 0) + (q.duration && x.duration ? (Math.abs(x.duration - q.duration) < 4 ? 3 : 0) : 0) + (x.instrumental ? -5 : 0);
      const best = [...list].sort((a, b) => score(b) - score(a))[0];
      if (best && (best.syncedLyrics || best.plainLyrics)) result = { source: 'LRCLIB', lrc: best.syncedLyrics || null, plain: best.plainLyrics || null };
    }
  }
  // 3) lyrics.ovh — solo texto
  if (!result && q.artist) {
    const j = await getJson(http, `https://api.lyrics.ovh/v1/${encodeURIComponent(q.artist)}/${encodeURIComponent(q.title)}`);
    if (j?.lyrics) result = { source: 'lyrics.ovh', lrc: null, plain: j.lyrics.replace(/\r\n/g, '\n').trim() };
  }
  if (!result) return null;
  kv.set(cacheKey(q), result).catch(() => {});
  return { ...result, synced: result.lrc ? parseLRC(result.lrc) : null };
}

/** Índice de la línea activa (búsqueda binaria). */
export function activeLine(lines, t) {
  let lo = 0, hi = lines.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].time <= t + 0.15) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** Subtítulos SRT/VTT → [{start,end,text}] */
export function parseSubs(text) {
  const cues = [];
  const blocks = String(text).replace(/\r/g, '').replace(/^WEBVTT[^\n]*\n/, '').split(/\n{2,}/);
  const ts = (s) => { const m = s.trim().match(/(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/); return m ? (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4].padEnd(3, '0')) / 1000 : null; };
  for (const b of blocks) {
    const lines = b.split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, z] = lines[i].split('-->');
    const start = ts(a), end = ts(z);
    if (start == null || end == null) continue;
    const textLines = lines.slice(i + 1).join('\n').replace(/<(?!\/?(?:i|b|u)>)[^>]+>/g, '').replace(/\{[^}]*\}/g, '').trim();
    if (textLines) cues.push({ start, end, text: textLines });
  }
  return cues.sort((x, y) => x.start - y.start);
}

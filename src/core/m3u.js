// Lectura y escritura de listas M3U / M3U8 (extendidas y simples)
// MultimediaMX — Copyright (C) 2026 Santiago Miguel — GPL-3.0-or-later

const ATTR_RE = /([\w-]+)="([^"]*)"/g;

export function isUrl(s) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/^file:\/\//i.test(s);
}

/**
 * Analiza el texto de una lista M3U.
 * @returns {{ name: string|null, items: Array<{location:string,title:string|null,artist:string|null,duration:number|null,attrs:object,group:string|null}> }}
 */
export function parseM3U(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  const items = [];
  let name = null;
  let pending = null;
  let group = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      if (/^#EXTINF:/i.test(line)) {
        const body = line.slice(8);
        const comma = findTitleComma(body);
        const head = comma >= 0 ? body.slice(0, comma) : body;
        const label = comma >= 0 ? body.slice(comma + 1).trim() : '';
        const durMatch = head.match(/^\s*(-?\d+(?:\.\d+)?)/);
        const attrs = {};
        for (const m of head.matchAll(ATTR_RE)) attrs[m[1]] = m[2];
        const duration = durMatch ? Number(durMatch[1]) : null;
        let artist = null, title = label || null;
        const sep = label.indexOf(' - ');
        if (sep > 0) { artist = label.slice(0, sep).trim(); title = label.slice(sep + 3).trim(); }
        pending = { title, artist, duration: duration != null && duration >= 0 ? duration : null, attrs };
        if (attrs['group-title']) group = attrs['group-title'];
        if (attrs['tvg-name'] && !title) title = attrs['tvg-name'];
      } else if (/^#PLAYLIST:/i.test(line)) {
        name = line.slice(10).trim() || null;
      } else if (/^#EXTGRP:/i.test(line)) {
        group = line.slice(8).trim() || null;
      }
      continue;
    }
    const meta = pending || { title: null, artist: null, duration: null, attrs: {} };
    items.push({ location: line, ...meta, group });
    pending = null;
    group = null;
  }
  return { name, items };
}

// La coma que separa el título no puede estar dentro de comillas de un atributo
function findTitleComma(s) {
  let q = false;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '"') q = !q;
    else if (s[i] === ',' && !q) return i;
  }
  return -1;
}

/**
 * Genera texto M3U extendido.
 * @param {string} name
 * @param {Array<{location:string,title?:string,artist?:string,duration?:number}>} items
 */
export function writeM3U(name, items) {
  const out = ['#EXTM3U'];
  if (name) out.push(`#PLAYLIST:${name}`);
  for (const it of items) {
    const dur = Number.isFinite(it.duration) ? Math.round(it.duration) : -1;
    const label = [it.artist, it.title].filter(Boolean).join(' - ');
    out.push(`#EXTINF:${dur},${label}`);
    out.push(it.location);
  }
  return out.join('\n') + '\n';
}

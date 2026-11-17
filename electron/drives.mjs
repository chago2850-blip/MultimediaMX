// Unidades de almacenamiento y búsqueda de medios en disco
// MultimediaMX — Copyright (C) 2026 Santiago Miguel — GPL-3.0-or-later
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isMediaFile, extOf, AUDIO_EXT } from './media.mjs';

// Carpetas que nunca contienen la música o los videos del usuario
const SKIP_DIRS = new Set([
  'windows', 'program files', 'program files (x86)', 'programdata', '$recycle.bin', 'recycler', 'system volume information',
  'appdata', 'application data', 'msocache', 'perflogs', 'recovery', '$windows.~bt', '$windows.~ws', 'windows.old', 'config.msi',
  'library', 'applications', 'system', 'private', 'cores', 'volumes', '.trash', '.trashes', '.spotlight-v100', '.fseventsd', '.documentrevisions-v100',
  'proc', 'sys', 'dev', 'run', 'boot', 'snap', 'lost+found', 'usr', 'bin', 'sbin', 'lib', 'lib64', 'etc', 'var', 'tmp', 'opt',
  'node_modules', '__pycache__', 'cache', 'caches', 'android', 'steamapps', 'site-packages'
]);

export function shouldSkipDir(name, depth = 0) {
  if (!name || name.startsWith('.') || name.startsWith('$')) return true;
  const n = name.toLowerCase();
  // en la raíz de una unidad se descartan las carpetas del sistema; dentro de la carpeta del usuario solo las técnicas
  if (SKIP_DIRS.has(n)) return depth <= 1 || ['node_modules', '__pycache__', 'cache', 'caches', '.trash', 'appdata', 'library', 'steamapps', 'site-packages'].includes(n);
  return false;
}

/** Archivos de audio muy pequeños suelen ser sonidos del sistema o de juegos. */
export const MIN_AUDIO_BYTES = 48 * 1024;

const exists = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

function userFolders() {
  const home = os.homedir();
  const names = ['Music', 'Música', 'Musica', 'Videos', 'Vídeos', 'Movies', 'Películas', 'Downloads', 'Descargas', 'Desktop', 'Escritorio'];
  const seen = new Set();
  const out = [];
  for (const n of names) {
    const p = path.join(home, n);
    let real;
    try { real = fs.realpathSync(p); } catch { continue; }
    if (seen.has(real) || !exists(real)) continue;
    seen.add(real);
    out.push({ path: p, label: n, type: 'folder', removable: false });
  }
  return out;
}

function listDir(dir) { try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() || e.isSymbolicLink()); } catch { return []; } }

/** Unidades conectadas (USB, discos externos, tarjetas, otras particiones) y carpetas de medios del usuario. */
export function listDrives() {
  const drives = [];
  if (process.platform === 'win32') {
    const sys = (process.env.SystemDrive || 'C:').toUpperCase();
    for (let c = 67; c <= 90; c++) { // C..Z
      const letter = String.fromCharCode(c) + ':';
      const root = letter + '\\';
      if (letter === sys) continue; // el disco del sistema se recorre por las carpetas del usuario
      if (exists(root)) drives.push({ path: root, label: letter, type: 'drive', removable: true });
    }
  } else if (process.platform === 'darwin') {
    for (const e of listDir('/Volumes')) {
      const p = path.join('/Volumes', e.name);
      let real; try { real = fs.realpathSync(p); } catch { continue; }
      if (real === '/' || e.name.startsWith('.') || /^(com\.apple|Recovery|Preboot|VM|Update|Data)$/i.test(e.name)) continue;
      drives.push({ path: p, label: e.name, type: 'drive', removable: true });
    }
  } else {
    const user = os.userInfo().username;
    const bases = [`/media/${user}`, `/run/media/${user}`, '/media', '/mnt'];
    const seen = new Set();
    for (const b of bases) {
      for (const e of listDir(b)) {
        const p = path.join(b, e.name);
        if (p === `/media/${user}` || p === `/run/media/${user}` || seen.has(p)) continue;
        if (!exists(p)) continue;
        try { if (!fs.readdirSync(p).length) continue; } catch { continue; } // punto de montaje vacío
        seen.add(p);
        drives.push({ path: p, label: e.name, type: 'drive', removable: true });
      }
    }
  }
  return [...userFolders(), ...drives];
}

/**
 * Recorre carpetas buscando audio y video.
 * @param {string[]} roots
 * @param {{ signal?: {cancelled:boolean}, onProgress?: (n:number, dir:string)=>void, maxDepth?: number, skipSystem?: boolean }} opts
 */
export async function findMedia(roots, { signal = { cancelled: false }, onProgress = () => {}, maxDepth = 24, skipSystem = true } = {}) {
  const out = [];
  const seen = new Set();
  let last = 0;
  async function walk(dir, depth) {
    if (signal.cancelled || depth > maxDepth) return;
    let real;
    try { real = await fsp.realpath(dir); } catch { return; }
    if (seen.has(real)) return; // evita ciclos por enlaces
    seen.add(real);
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const e of entries) {
      if (signal.cancelled) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (skipSystem ? shouldSkipDir(e.name, depth) : e.name.startsWith('.')) continue;
        await walk(full, depth + 1);
      } else if ((e.isFile() || e.isSymbolicLink()) && !e.name.startsWith('.') && !e.name.startsWith('._') && isMediaFile(e.name)) {
        if (AUDIO_EXT.includes(extOf(e.name))) {
          try { if ((await fsp.stat(full)).size < MIN_AUDIO_BYTES) continue; } catch { continue; }
        }
        out.push(full);
        const now = Date.now();
        if (now - last > 250) { last = now; onProgress(out.length, dir); }
      }
    }
  }
  for (const r of roots) await walk(r, 0);
  onProgress(out.length, '');
  return out;
}

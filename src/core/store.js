// Almacenamiento persistente (IndexedDB) — MultimediaMX — GPL-3.0-or-later
const DB = 'multimediamx';
const STORE = 'kv';
let dbp = null;

function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(r?.result);
    t.onerror = () => reject(t.error);
  });
}

export const kv = {
  get: (k) => tx('readonly', (s) => s.get(k)),
  set: (k, v) => tx('readwrite', (s) => s.put(v, k)),
  del: (k) => tx('readwrite', (s) => s.delete(k))
};

// Escritura diferida para no saturar el disco
const timers = new Map();
export function saveLater(key, getValue, ms = 400) {
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => { timers.delete(key); kv.set(key, getValue()).catch(() => {}); }, ms));
}

export const DEFAULT_SETTINGS = {
  skin: 'aurora',
  lang: (navigator.language || 'es').toLowerCase().startsWith('es') ? 'es' : 'en',
  volume: 0.8,
  muted: false,
  shuffle: false,
  repeat: 'off', // off | all | one
  speed: 1,
  eq: { enabled: true, preset: 'flat', preamp: 0, bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], balance: 0 },
  customPresets: {},
  lyrics: { online: true, size: 'm', autoOpen: true },
  resume: true,
  visualizer: true,
  relativePaths: true,
  tvMode: 'auto' // auto | on | off
};

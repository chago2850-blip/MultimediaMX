// MultimediaMX — interfaz principal
// Copyright (C) 2026 Santiago Miguel <chago2850@gmail.com>
// Software libre bajo la GNU GPL versión 3 o posterior. Consulte LICENSE.
import './styles/base.css';
import './styles/skins.css';
import { kv, saveLater, DEFAULT_SETTINGS } from './core/store.js';
import { platform, kindOf, baseName, extOf } from './core/platform.js';
import { isUrl } from './core/m3u.js';
import { expandRemoteLists, needsInspection } from './core/remote.js';
import { audio, PRESETS } from './core/audio.js';
import { Player } from './core/player.js';
import { t, setLang } from './i18n/index.js';
import { icon } from './ui/icons.js';
import { $, $$, toast, fmtTime } from './ui/dom.js';
import { renderView, refreshView } from './ui/views.js';
import { initNowPlaying, onTrackChange, renderLyricsState, updateNowPlaying } from './ui/nowplaying.js';
import { renderEq } from './ui/eq.js';
import { enableTV, disableTV, isTV } from './ui/tvnav.js';
import * as tvnav from './ui/tvnav.js';
import { closeMenu } from './ui/dom.js';

// ------------------------------------------------------------------ estado
export const S = {
  settings: structuredClone(DEFAULT_SETTINGS),
  library: [],
  playlists: [],
  covers: new Map(),
  view: 'library',
  playlistId: null,
  query: '',
  panel: null,      // queue | lyrics | eq (cajón en Aurora/Vinilo)
  stageOpen: false,
  scanning: false
};
export const player = new Player($('#video'));
const bySrc = new Map();

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));

export function persist(what) {
  if (what === 'settings' || !what) saveLater('settings', () => S.settings);
  if (what === 'library' || !what) saveLater('library', () => S.library.filter((x) => !x.ephemeral), 800);
  if (what === 'playlists' || !what) saveLater('playlists', () => S.playlists.map((p) => ({ ...p, items: p.items.filter((i) => !i.ephemeral) })), 500);
}

export function trackLabel(tr) {
  if (tr.title || tr.name) return tr.title || tr.name;
  if (!isUrl(tr.src)) return baseName(tr.src);
  if (kindOf(tr.src) && kindOf(tr.src) !== 'stream') return baseName(tr.src);
  try { const u = new URL(tr.src); return u.host + (u.pathname.length > 1 ? u.pathname : ''); } catch { return tr.src; }
}

export function makeTrack(entry) {
  const src = entry.src;
  const kind = entry.kind || kindOf(src) || (entry.name ? kindOf(entry.name) : null) || 'audio';
  return {
    id: uid(), src, kind: kind === 'stream' ? 'audio' : kind,
    title: entry.title || null, name: entry.name || null,
    artist: entry.artist || null, album: entry.album || null, duration: entry.duration || null,
    remote: isUrl(src), ephemeral: !!entry.ephemeral, addedAt: Date.now(), metaRead: false
  };
}

export const findBySrc = (src) => bySrc.get(src);

// ------------------------------------------------------------------ biblioteca
export async function addEntries(entries, { quiet = false } = {}) {
  const added = [];
  for (const e of entries) {
    if (!e?.src || bySrc.has(e.src)) continue;
    const tr = makeTrack(e);
    S.library.push(tr);
    bySrc.set(tr.src, tr);
    added.push(tr);
  }
  if (added.length) {
    persist('library');
    refreshView();
    if (!quiet) toast(t('addedN', { n: added.length }));
    enrich(added);
  }
  return added;
}

export function removeFromLibrary(ids) {
  const set = new Set(ids);
  S.library = S.library.filter((x) => { if (set.has(x.id)) { bySrc.delete(x.src); return false; } return true; });
  persist('library');
  refreshView();
}

// Lee etiquetas en segundo plano, de pocos en pocos
const enrichQueue = [];
let enriching = 0;
function enrich(tracks) {
  enrichQueue.push(...tracks.filter((x) => !x.remote && (!x.metaRead || (!x.duration && platform.canTranscode))));
  pump();
}
function pump() {
  while (enriching < 3 && enrichQueue.length) {
    const tr = enrichQueue.shift();
    enriching++;
    readMeta(tr).finally(() => { enriching--; if (!enrichQueue.length && !enriching) { persist('library'); refreshView(); } else if (enrichQueue.length % 25 === 0) refreshView(); pump(); });
  }
}

export async function readMeta(tr) {
  if (tr.remote) return {};
  if (platform.name === 'android' && !tr.ephemeral && tr.metaRead) return {};
  const m = await platform.meta(tr.src).catch(() => ({}));
  tr.metaRead = true;
  if (m.title) tr.title = m.title;
  if (m.artist) tr.artist = m.artist;
  if (m.album) tr.album = m.album;
  if (m.year) tr.year = m.year;
  if (m.duration && !tr.duration) tr.duration = m.duration;
  if (m.cover) setCover(tr, m.cover);
  // la duración de videos y formatos sin etiquetas se obtiene con FFmpeg
  if (!tr.duration && platform.canTranscode) {
    const p = await platform.probe(tr.src).catch(() => null);
    if (p?.duration) tr.duration = p.duration;
    if (p?.ok) tr.kind = p.video ? 'video' : 'audio';
  }
  return m;
}

export function setCover(tr, dataUrl) {
  S.covers.set(tr.src, dataUrl);
  tr.hasCover = true;
  if (dataUrl.length < 1_500_000) kv.set(`cover:${tr.src}`, dataUrl).catch(() => {});
}

export async function coverOf(tr) {
  if (!tr) return null;
  if (tr.logo && !S.covers.has(tr.src)) return tr.logo;
  if (S.covers.has(tr.src)) return S.covers.get(tr.src);
  if (!tr.hasCover) return null;
  const c = await kv.get(`cover:${tr.src}`).catch(() => null);
  if (c) S.covers.set(tr.src, c);
  return c;
}

export async function pickFiles() { await addEntries(await platform.pickMedia()); }
export async function pickFolder() {
  S.scanning = true; refreshView();
  try { await addEntries(await platform.pickFolder()); } finally { S.scanning = false; refreshView(); }
}
export async function scanDevice() {
  S.scanning = true; refreshView();
  try {
    const r = await platform.scanDevice();
    if (r?.denied) toast(t('permissionDenied'), 4000);
    else if (Array.isArray(r)) {
      const added = await addEntries(r, { quiet: true });
      toast(t('addedN', { n: added.length }));
    }
  } finally { S.scanning = false; refreshView(); }
}

/** Mueve archivos locales a la papelera del sistema y los quita de la biblioteca. */
export async function trashTracks(tracks) {
  const local = tracks.filter((x) => !x.remote && !x.ephemeral);
  if (!local.length || !platform.canTrash) return { ok: [], failed: [] };
  if (player.track && local.some((x) => x.src === player.track.src)) player.halt();
  const r = await platform.trash(local.map((x) => x.src));
  const okSet = new Set(r.ok);
  removeFromLibrary(local.filter((x) => okSet.has(x.src)).map((x) => x.id));
  return r;
}

// ------------------------------------------------------------------ búsqueda en unidades
let scanToken = 0;
export const drivesState = { known: null, last: [] };

/**
 * Busca audio y video en las unidades conectadas.
 * roots: rutas a recorrer (en Android '*mediastore' añade el índice de medios del sistema).
 */
export async function searchDrives(roots, { auto = false } = {}) {
  if (!roots?.length || !platform.canScanDrives) return [];
  if (S.scanning) { if (!auto) toast(t('scanBusy')); return []; }
  const my = ++scanToken;
  S.scanning = true; S.scanFound = 0; refreshView();
  if (!auto) toast(t('scanStarted'), 1800);
  try {
    const r = await platform.findMedia(roots, (n) => { if (my === scanToken) { S.scanFound = n; refreshView(); } });
    if (r?.denied) { if (!auto) toast(t('permissionDenied'), 4000); return []; }
    const added = await addEntries(r || [], { quiet: true });
    if (added.length || !auto) toast(t('scanDone', { n: added.length, total: (r || []).length }), 4000);
    return added;
  } catch {
    if (!auto) toast(t('failed'), 3000);
    return [];
  } finally {
    if (my === scanToken) { S.scanning = false; S.scanFound = 0; refreshView(); }
  }
}

export function cancelSearch() { platform.cancelScan?.(); }

/** Raíces predeterminadas: carpetas de medios del usuario y unidades conectadas. */
export function defaultRoots(drives) {
  const roots = drives.map((d) => d.path);
  return platform.name === 'android' ? ['*mediastore', ...roots] : roots;
}

/** Búsqueda automática: al iniciar y cada vez que se conecta una unidad. */
function initAutoScan() {
  if (!platform.canScanDrives) return;
  const check = async (first = false) => {
    if (S.settings.autoScan === false) { drivesState.known = null; return; }
    const drives = await platform.listDrives().catch(() => []);
    drivesState.last = drives;
    const prev = drivesState.known;
    drivesState.known = new Set(drives.map((d) => d.path));
    if (first || !prev) return searchDrives(defaultRoots(drives), { auto: true });
    const fresh = drives.filter((d) => !prev.has(d.path));
    if (fresh.length) {
      toast(t('driveConnected', { name: fresh.map((d) => d.label).join(', ') }), 3500);
      await searchDrives(fresh.map((d) => d.path), { auto: true });
    }
  };
  setTimeout(() => check(true), 2500);
  if (platform.name === 'desktop') setInterval(() => { if (!S.scanning) check(); }, 7000);
  platform.onDrivesChanged(() => setTimeout(() => check(), 1500));
  if (platform.name === 'android') import('@capacitor/app').then(({ App }) => App.addListener('resume', () => check())).catch(() => {});
}

// ------------------------------------------------------------------ listas
export function createPlaylist(name, items = []) {
  const pl = { id: uid(), name, items, createdAt: Date.now() };
  S.playlists.push(pl);
  persist('playlists');
  return pl;
}

export function playlistItemFromTrack(tr) {
  return { src: tr.src, title: tr.title, name: tr.name || null, artist: tr.artist, duration: tr.duration, kind: tr.kind, remote: tr.remote, ephemeral: tr.ephemeral };
}

export async function importPlaylists() {
  const lists = await platform.importPlaylists();
  let last = null;
  for (const l of lists || []) {
    const items = [];
    for (const it of l.items) {
      let src = it.location;
      // En Android las rutas relativas se buscan por nombre en la biblioteca
      if (platform.name !== 'desktop' && !isUrl(src) && !src.startsWith('/')) {
        const name = baseName(src).toLowerCase();
        const hit = S.library.find((x) => baseName(x.src).toLowerCase() === name);
        if (hit) src = hit.src; else { items.push({ src, title: it.title || baseName(src), artist: it.artist, duration: it.duration, kind: kindOf(src) || 'audio', missing: true }); continue; }
      }
      const known = bySrc.get(src);
      items.push({
        src, title: it.title || known?.title || (isUrl(src) ? it.attrs?.['tvg-name'] || src : null), artist: it.artist || known?.artist || null,
        duration: it.duration || known?.duration || null, kind: known?.kind || kindOf(src) || (isUrl(src) ? (it.attrs?.['tvg-logo'] || /\.m3u8|\/live|\.ts$/i.test(src) ? 'video' : 'audio') : 'audio'),
        remote: isUrl(src), missing: it.exists === false, logo: it.attrs?.['tvg-logo'] || null, group: it.group || null
      });
    }
    await expandItems(items);
    last = createPlaylist(l.name, items);
  }
  if (last) {
    toast(`${t('imported')}: ${last.name}`);
    go('playlist', last.id);
  }
}

export async function exportPlaylist(pl) {
  const items = pl.items.filter((i) => !i.ephemeral).map((i) => ({ location: i.src, title: i.title, artist: i.artist, duration: i.duration, remote: i.remote }));
  const where = await platform.savePlaylist(pl.name, items, S.settings.relativePaths);
  if (where) toast(`${t('saved')}: ${where}`, 3500);
}

// ------------------------------------------------------------------ reproducción
export function toTrack(item) {
  return bySrc.get(item.src) || { id: uid(), ...item, kind: item.kind || kindOf(item.src) || 'audio', remote: isUrl(item.src) };
}

/** Despliega las listas M3U en línea que haya dentro de items (modifica el arreglo). */
export async function expandItems(items) {
  if (!items.some(needsInspection)) return 0;
  toast(t('loadingRemoteList'), 60000);
  const before = items.length;
  const pending = items.filter(needsInspection).length;
  const n = await expandRemoteLists(items, (u) => platform.peek(u));
  if (n) toast(t('remoteListLoaded', { n: (items.length - before + n).toLocaleString() }), 3500);
  else if (items.some(needsInspection) && items.filter(needsInspection).length === pending) toast(t('remoteListFailed'), 4500);
  else toast(t('ready'), 800);
  return n;
}

export async function playList(items, index = 0, { shuffle = null } = {}) {
  if (items.some(needsInspection)) {
    const target = items[index];
    const n = await expandItems(items);
    if (n) {
      if (S.playlists.some((p) => p.items === items)) { persist('playlists'); renderView(); }
      const ni = items.indexOf(target);
      index = ni >= 0 ? ni : 0;
    }
  }
  if (!items.length) return;
  const tracks = items.map(toTrack);
  if (shuffle != null) { S.settings.shuffle = shuffle; player.setShuffle(shuffle); persist('settings'); renderBar(); }
  if (shuffle) index = Math.floor(Math.random() * tracks.length);
  player.setQueue(tracks, index);
}

export function queueTracks(items, next = false) {
  player.enqueue(items.map(toTrack), { next });
  toast(t('added'));
}

// ------------------------------------------------------------------ navegación
export function go(view, id = null) {
  S.view = view;
  if (view === 'playlist') S.playlistId = id;
  if (view === 'nowplaying') { openStage(true); return; }
  if (S.stageOpen) openStage(false);
  renderNav();
  renderView();
}

export function openStage(v) {
  S.stageOpen = v;
  $('#app').classList.toggle('stage-open', v);
  renderNav();
  if (v) updateNowPlaying();
}

export function setPanel(p) {
  S.panel = S.panel === p ? null : p;
  if (S.settings.skin === 'estudio' && !S.panel) S.panel = p;
  applyPanel();
}

function applyPanel() {
  const skin = S.settings.skin;
  const narrow = matchMedia('(max-width: 760px)').matches;
  const p = S.panel || (skin === 'estudio' && !narrow ? 'eq' : null);
  $('#app').dataset.panel = p || '';
  $('#app').classList.toggle('panel-open', !!S.panel || (skin === 'estudio' && !narrow));
  $$('.panel-page').forEach((el) => el.classList.toggle('on', el.dataset.page === p));
  $$('#panelTabs button').forEach((b) => b.classList.toggle('on', b.dataset.p === p));
  placeLyrics();
  renderBar();
}

/** La letra vive en el escenario (Aurora/Vinilo) o en el panel (Estudio). */
export function placeLyrics() {
  const lyr = $('#lyrics');
  const inPanel = S.settings.skin === 'estudio' && !matchMedia('(max-width: 760px)').matches;
  const home = inPanel ? $('#lyricsHomePanel') : $('#lyricsHomeStage');
  if (lyr.parentElement !== home) home.appendChild(lyr);
}

export function setSkin(skin) {
  S.settings.skin = skin;
  $('#app').dataset.skin = skin;
  persist('settings');
  applyPanel();
  updateNowPlaying();
  if (S.view === 'settings') renderView();
}

// ------------------------------------------------------------------ barra superior y de reproducción
const NAV = [
  ['library', 'library'], ['music', 'music'], ['videos', 'video'], ['playlists', 'list'], ['nowplaying', 'nowPlaying'], ['settings', 'settings']
];

export function renderNav() {
  const active = S.stageOpen ? 'nowplaying' : S.view === 'playlist' ? 'playlists' : S.view;
  $('#nav').innerHTML = NAV.map(([v, ic]) => `<button data-v="${v}" class="${active === v ? 'on' : ''}" title="${t(v === 'nowplaying' ? 'nowPlaying' : v)}">${icon(ic, 19)}<span>${t(v === 'nowplaying' ? 'nowPlaying' : v)}</span></button>`).join('');
}

export function renderBar() {
  // conservar el foco del control remoto al redibujar la barra
  const fe = document.activeElement;
  const keep = fe && fe.closest?.('#barControls, #barRight') ? (fe.dataset.a ? `[data-a="${fe.dataset.a}"]` : fe.id ? `#${fe.id}` : null) : null;
  renderBarInner();
  if (keep) $(`#bar ${keep}`)?.focus({ preventScroll: true });
}

function renderBarInner() {
  const playing = !player.paused && !!player.track;
  const rep = S.settings.repeat;
  $('#barControls').innerHTML = `
    <button class="icon-btn sm ${S.settings.shuffle ? 'on' : ''}" data-a="shuffle" title="${t('shuffle')}">${icon('shuffle', 18)}</button>
    <button class="icon-btn sm" data-a="stop" title="${t('stop')}" ${player.track ? '' : 'disabled'}>${icon('stop', 18)}</button>
    <button class="icon-btn" data-a="prev" title="${t('prev')}">${icon('prev', 22)}</button>
    <button class="play-btn" data-a="toggle" title="${playing ? t('pause') : t('play')}">${icon(playing ? 'pause' : 'play', 26)}</button>
    <button class="icon-btn" data-a="next" title="${t('next')}">${icon('next', 22)}</button>
    <button class="icon-btn sm ${rep !== 'off' ? 'on' : ''}" data-a="repeat" title="${rep === 'one' ? t('repeatOne') : t('repeat')}">${icon(rep === 'one' ? 'repeatOne' : 'repeat', 18)}</button>`;
  const v = S.settings.muted ? 0 : S.settings.volume;
  const tr = player.track;
  const hasSubs = !!(tr && player.kind === 'video');
  const multiAudio = (player.probe?.audio?.length || 0) > 1;
  const pOn = (p) => (S.panel === p || (S.settings.skin === 'estudio' && $('#app').dataset.panel === p)) ? 'on' : '';
  $('#barRight').innerHTML = `
    ${hasSubs ? `<button class="icon-btn sm" data-a="subs" title="${t('subtitles')}">${icon('cc', 19)}</button>` : ''}
    ${multiAudio ? `<button class="icon-btn sm" data-a="atrack" title="${t('audioTrack')}">${icon('audioTrack', 19)}</button>` : ''}
    <button class="icon-btn sm ${S.stageOpen || pOn('lyrics') ? 'on' : ''}" data-a="lyrics" title="${t('lyrics')}">${icon('lyrics', 19)}</button>
    <button class="icon-btn sm ${pOn('queue')}" data-a="queue" title="${t('queue')}">${icon('queue', 19)}</button>
    <button class="icon-btn sm ${pOn('eq')}" data-a="eq" title="${t('equalizer')}">${icon('eq', 19)}</button>
    <div class="vol">
      <button class="icon-btn sm" data-a="mute" title="${t('mute')}">${icon(v === 0 ? 'mute' : v < 0.5 ? 'volumeLow' : 'volume', 19)}</button>
      <input type="range" min="0" max="1" step="0.01" value="${v}" id="vol" style="--p:${v * 100}%" aria-label="Volume" />
    </div>
    ${hasSubs ? `<button class="icon-btn sm" data-a="fullscreen" title="${t('fullscreen')}">${icon('fullscreen', 18)}</button>` : ''}
    ${platform.name === 'desktop' ? `<button class="icon-btn sm" data-a="mini" title="${t('miniPlayer')}">${icon('mini', 18)}</button>` : ''}`;
  $('#vol').oninput = (e) => {
    const val = +e.target.value;
    S.settings.volume = val; S.settings.muted = val === 0;
    player.setVolume(val); player.setMuted(false);
    e.target.style.setProperty('--p', `${val * 100}%`);
    persist('settings');
  };
}

export function renderBarTrack() {
  const tr = player.track;
  $('#barTitle').textContent = tr ? trackLabel(tr) : t('nothingPlaying');
  $('#barArtist').textContent = tr ? (tr.artist || (tr.remote ? t('stream') : t('unknownArtist'))) : 'MultimediaMX';
  const img = $('.bar-cover img');
  img.removeAttribute('src');
  $('.bar-cover-fallback').innerHTML = icon(tr?.kind === 'video' ? 'video' : 'music', 20);
  $('.bar-cover').classList.remove('has');
  coverOf(tr).then((c) => { if (c && player.track === tr) { img.src = c; $('.bar-cover').classList.add('has'); } });
  document.title = tr ? `${trackLabel(tr)} — MultimediaMX` : 'MultimediaMX';
}

// barra de progreso
let dragging = false;
function seekRatio(e) {
  const r = $('#seek').getBoundingClientRect();
  return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
}
function initSeek() {
  const seek = $('#seek');
  seek.addEventListener('pointerdown', (e) => {
    if (!player.track || !player.duration) return;
    dragging = true;
    seek.setPointerCapture(e.pointerId);
    paintTime(seekRatio(e) * player.duration);
  });
  seek.addEventListener('pointermove', (e) => {
    const r = seekRatio(e);
    const tip = $('#seekTip');
    tip.textContent = fmtTime(r * (player.duration || 0));
    tip.style.left = `${r * 100}%`;
    if (dragging) paintTime(r * player.duration);
  });
  seek.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    dragging = false;
    player.seek(seekRatio(e) * player.duration);
  });
}

export function paintTime(forced) {
  const d = player.duration || 0;
  const c = forced ?? player.currentTime;
  const p = d ? Math.min(100, (c / d) * 100) : 0;
  $('#seekFill').style.width = `${p}%`;
  $('#seekThumb').style.left = `${p}%`;
  $('#tCur').textContent = fmtTime(c);
  $('#tDur').textContent = d ? fmtTime(d) : player.track?.remote ? 'LIVE' : '0:00';
  const el = player.active;
  if (el.buffered?.length && d) {
    const end = player.offset + el.buffered.end(el.buffered.length - 1);
    $('#seekBuf').style.width = `${Math.min(100, (end / d) * 100)}%`;
  } else $('#seekBuf').style.width = '0%';
  $('#app').style.setProperty('--progress', `${p}%`);
}

// ------------------------------------------------------------------ acciones de botones
const ACTIONS = {
  toggle: () => player.toggle(),
  stop: () => player.halt(),
  prev: () => player.prev(),
  next: () => player.next(),
  shuffle: () => { S.settings.shuffle = !S.settings.shuffle; player.setShuffle(S.settings.shuffle); persist('settings'); renderBar(); },
  repeat: () => {
    const order = ['off', 'all', 'one'];
    S.settings.repeat = order[(order.indexOf(S.settings.repeat) + 1) % 3];
    player.repeat = S.settings.repeat; persist('settings'); renderBar();
  },
  mute: () => {
    S.settings.muted = !S.settings.muted;
    if (!S.settings.muted && S.settings.volume === 0) { S.settings.volume = 0.5; player.setVolume(0.5); }
    player.setMuted(S.settings.muted); persist('settings'); renderBar();
  },
  lyrics: () => {
    const skin = S.settings.skin;
    const narrow = matchMedia('(max-width: 760px)').matches;
    if (skin === 'estudio' && !narrow) setPanel('lyrics');
    else openStage(!S.stageOpen);
  },
  queue: () => setPanel('queue'),
  eq: () => setPanel('eq'),
  fullscreen: () => toggleFullscreen(),
  mini: () => toggleMini(),
  subs: (e) => import('./ui/nowplaying.js').then((m) => m.subtitleMenu(e)),
  atrack: (e) => import('./ui/nowplaying.js').then((m) => m.audioTrackMenu(e))
};

function initActions() {
  document.addEventListener('click', (e) => {
    const b = e.target.closest('#bar [data-a], #stage [data-a]');
    if (b && ACTIONS[b.dataset.a]) { ACTIONS[b.dataset.a](e); return; }
    const n = e.target.closest('#nav button[data-v]');
    if (n) go(n.dataset.v);
  });
  $('#barNow').onclick = () => { if (player.track) ACTIONS.lyrics(); };
  $('#stageClose').onclick = () => openStage(false);
  $('#skinBtn').onclick = () => {
    const order = ['aurora', 'vinilo', 'estudio'];
    setSkin(order[(order.indexOf(S.settings.skin) + 1) % 3]);
    toast(`${t('interface')}: ${t('skin' + S.settings.skin[0].toUpperCase() + S.settings.skin.slice(1))}`);
  };
  $('#search').addEventListener('input', (e) => {
    S.query = e.target.value;
    if (!['library', 'music', 'videos'].includes(S.view)) { S.view = 'library'; renderNav(); renderView(); }
    else refreshView();
  });
}

let fsOn = false;
export function toggleFullscreen() {
  fsOn = !fsOn;
  $('#app').classList.toggle('video-fs', fsOn);
  platform.setFullscreen(fsOn);
}
let mini = false;
function toggleMini() {
  mini = !mini;
  $('#app').classList.toggle('mini', mini);
  platform.setMini(mini);
  platform.setAlwaysOnTop(mini);
}

// ------------------------------------------------------------------ botón Atrás (control remoto / Android)
let lastBack = 0;
export function goBack() {
  if (document.querySelector('.ctx-menu')) { closeMenu(); return true; }
  if ($('#modal.show')) { const no = $('#modal [data-a=no]'); if (no) no.click(); else $('#modal').click(); return true; }
  if (fsOn) { toggleFullscreen(); return true; }
  if (mini) { toggleMini(); return true; }
  const narrow = matchMedia('(max-width: 760px)').matches;
  if (S.panel && (S.settings.skin !== 'estudio' || narrow)) { S.panel = null; applyPanel(); return true; }
  if (S.stageOpen) { openStage(false); return true; }
  if (S.view === 'playlist') { go('playlists'); return true; }
  if (S.view !== 'library') { go('library'); return true; }
  if (platform.name === 'android') {
    if (Date.now() - lastBack < 2200) { import('@capacitor/app').then(({ App }) => App.exitApp()); return true; }
    lastBack = Date.now();
    toast(t('backAgainToExit'), 2200);
    return true;
  }
  return false;
}

export function applyTvMode(info = {}) {
  const mode = S.settings.tvMode || 'auto';
  const on = mode === 'on' || (mode === 'auto' && (!!info.tv || /[?&]tv=1/.test(location.search)));
  if (on) {
    enableTV({
      back: goBack, toggle: () => player.toggle(), next: () => player.next(), prev: () => player.prev(), stop: () => player.halt(),
      seek: (d) => player.seek(player.currentTime + d), fullscreen: () => { if (player.kind === 'video') toggleFullscreen(); }, isFullscreen: () => fsOn
    });
    $('#videoWrap').tabIndex = 0;
  } else {
    disableTV();
    $('#videoWrap').removeAttribute('tabindex');
  }
  return on;
}

// ------------------------------------------------------------------ teclado
function initKeys() {
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey) {
      if (e.key === 'Escape' && e.target.id === 'search') { e.target.value = ''; S.query = ''; refreshView(); e.target.blur(); }
      return;
    }
    const k = e.key.toLowerCase();
    if (k === ' ') { e.preventDefault(); player.toggle(); }
    else if (e.key === 'ArrowRight') player.seek(player.currentTime + (e.shiftKey ? 30 : 5));
    else if (e.key === 'ArrowLeft') player.seek(player.currentTime - (e.shiftKey ? 30 : 5));
    else if (e.key === 'ArrowUp') { e.preventDefault(); bumpVolume(0.05); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); bumpVolume(-0.05); }
    else if (k === 'n') player.next();
    else if (k === 'p') player.prev();
    else if (k === 'm') ACTIONS.mute();
    else if (k === 'x') player.halt();
    else if (e.key === 'MediaStop') player.halt();
    else if (k === 'l') ACTIONS.lyrics();
    else if (k === 's') ACTIONS.shuffle();
    else if (k === 'r') ACTIONS.repeat();
    else if (k === 'f' && player.kind === 'video') toggleFullscreen();
    else if (e.key === 'Escape') { if (fsOn) toggleFullscreen(); else if (mini) toggleMini(); else if (S.stageOpen) openStage(false); else if (S.panel) { S.panel = null; applyPanel(); } }
    else if (k === '/') { e.preventDefault(); $('#search').focus(); }
  });
}
function bumpVolume(d) {
  const v = Math.min(1, Math.max(0, S.settings.volume + d));
  S.settings.volume = v; S.settings.muted = false;
  player.setVolume(v); player.setMuted(false);
  persist('settings'); renderBar();
  toast(`${Math.round(v * 100)} %`, 900);
}

// ------------------------------------------------------------------ arrastrar y soltar
function initDrop() {
  let depth = 0;
  const drop = $('#drop');
  const hasFiles = (e) => !!e.dataTransfer?.types?.includes('Files');
  // destino: una lista abierta, la tarjeta de una lista o la biblioteca
  const targetOf = (e) => {
    const card = e.target?.closest?.('.pl-card');
    if (card) return S.playlists.find((p) => p.id === card.dataset.id) || null;
    if (S.view === 'playlist' && !S.stageOpen) return S.playlists.find((p) => p.id === S.playlistId) || null;
    return null;
  };
  const label = (pl) => {
    drop.firstElementChild.innerHTML = `${icon(pl ? 'list' : 'import', 42)}<span>${pl ? t('dropToPlaylist', { name: pl.name }) : t('dropHere')}</span>`;
  };
  const mark = (card) => $$('.pl-card.drop-on').forEach((c) => c.classList.toggle('drop-on', c === card));
  addEventListener('dragenter', (e) => { if (hasFiles(e)) { depth++; drop.classList.add('show'); label(targetOf(e)); } });
  addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) { drop.classList.remove('show'); mark(null); } });
  addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const card = e.target?.closest?.('.pl-card') || null;
    mark(card);
    label(targetOf(e));
    // posición de inserción dentro de una lista abierta
    if (S.view === 'playlist') { const r = e.target?.closest?.('.pl-row'); $$('.pl-row.drop-target').forEach((x) => x.classList.toggle('drop-target', x === r)); }
  });
  addEventListener('drop', async (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    depth = 0; drop.classList.remove('show'); mark(null);
    const target = targetOf(e);
    const row = target && S.view === 'playlist' ? e.target?.closest?.('.pl-row') : null;
    const at = row ? +row.dataset.idx : null;
    $$('.pl-row.drop-target').forEach((x) => x.classList.remove('drop-target'));
    const files = [...e.dataTransfer.files];
    if (platform.name === 'desktop') {
      const paths = files.map((f) => platform.pathForFile(f)).filter(Boolean);
      if (target) await addPathsToPlaylist(target, paths, at);
      else await openPaths(paths, { play: false });
    } else {
      const lists = files.filter((f) => /\.m3u8?$/i.test(f.name));
      const media = files.filter((f) => !/\.m3u8?$/i.test(f.name) && (kindOf(f.name) || /^(audio|video)\//.test(f.type)));
      if (media.length) {
        const entries = platform.adoptFiles(media);
        await addEntries(entries, { quiet: !!target });
        if (target) appendToPlaylist(target, entries.map((x) => findBySrc(x.src)).filter(Boolean).map(playlistItemFromTrack), at);
      }
      if (lists.length) toast(t('importM3U'));
    }
  });
}

/** Inserta elementos en una lista (al final o en la posición indicada). */
export function appendToPlaylist(pl, items, at = null) {
  if (!items.length) { toast(t('nothingToAdd'), 2500); return 0; }
  if (at == null || at < 0 || at > pl.items.length) pl.items.push(...items); else pl.items.splice(at, 0, ...items);
  persist('playlists');
  toast(`${t('addedN', { n: items.length })} → ${pl.name}`);
  if (S.view === 'playlist' && S.playlistId === pl.id) renderView(); else refreshView();
  return items.length;
}

/** Archivos, carpetas y listas .m3u soltados sobre una lista (escritorio). */
async function addPathsToPlaylist(pl, paths, at = null) {
  const items = [];
  const media = [];
  for (const p of paths) {
    const e = extOf(p);
    if (e === 'm3u' || e === 'm3u8') {
      const l = await window.mmx.readPlaylist(p);
      items.push(...l.items.map((it) => ({ src: it.location, title: it.title, artist: it.artist, duration: it.duration, kind: kindOf(it.location) || 'audio', remote: it.remote, missing: !it.exists })));
    } else if (kindOf(p)) media.push(p);
    else {
      S.scanning = true; refreshView();
      try { media.push(...await window.mmx.scanFolder(p)); } finally { S.scanning = false; }
    }
  }
  await addEntries(media.map((src) => ({ src })), { quiet: true });
  const tracks = media.map((src) => findBySrc(src)).filter(Boolean).map(playlistItemFromTrack);
  return appendToPlaylist(pl, [...tracks, ...items], at);
}

/** Elegir archivos (o una carpeta) y agregarlos directamente a una lista. */
export async function pickIntoPlaylist(pl, folder = false) {
  const entries = folder ? await platform.pickFolder() : await platform.pickMedia();
  if (!entries?.length) return;
  await addEntries(entries, { quiet: true });
  appendToPlaylist(pl, entries.map((x) => findBySrc(x.src)).filter(Boolean).map(playlistItemFromTrack));
}

/** Abre rutas de escritorio: archivos, carpetas y listas. */
async function openPaths(paths, { play = true } = {}) {
  const entries = [];
  let firstList = null;
  for (const p of paths) {
    const e = extOf(p);
    if (e === 'm3u' || e === 'm3u8') {
      const l = await window.mmx.readPlaylist(p);
      const its = l.items.map((it) => ({ src: it.location, title: it.title, artist: it.artist, duration: it.duration, kind: kindOf(it.location) || 'audio', remote: it.remote, missing: !it.exists }));
      await expandItems(its);
      const pl = createPlaylist(l.name, its);
      firstList = firstList || pl;
    } else if (kindOf(p)) entries.push({ src: p });
    else {
      const found = await window.mmx.scanFolder(p);
      entries.push(...found.map((src) => ({ src })));
    }
  }
  const added = await addEntries(entries);
  if (firstList) { go('playlist', firstList.id); if (play) playList(firstList.items, 0); }
  else if (play && entries.length) {
    const tracks = entries.map((e) => findBySrc(e.src)).filter(Boolean);
    if (tracks.length) player.setQueue(tracks, 0);
  }
  return added;
}

// ------------------------------------------------------------------ sesión de medios del sistema
function initMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  const set = (a, fn) => { try { ms.setActionHandler(a, fn); } catch {} };
  set('play', () => player.play());
  set('pause', () => player.pause());
  set('stop', () => player.halt());
  set('previoustrack', () => player.prev());
  set('nexttrack', () => player.next());
  set('seekto', (d) => player.seek(d.seekTime));
  set('seekbackward', () => player.seek(player.currentTime - 10));
  set('seekforward', () => player.seek(player.currentTime + 10));
}
async function updateMediaSession(tr) {
  if (!('mediaSession' in navigator) || !tr) return;
  const cover = await coverOf(tr);
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: trackLabel(tr), artist: tr.artist || '', album: tr.album || '',
      artwork: cover ? [{ src: cover, sizes: '512x512' }] : []
    });
  } catch {}
}

// ------------------------------------------------------------------ guardar sesión
function saveSession() {
  if (!S.settings.resume) return;
  const q = player.queue.filter((x) => !x.ephemeral);
  if (q.length !== player.queue.length || q.length > 3000) return;
  kv.set('session', {
    queue: q.map((x) => ({ src: x.src, title: x.title, artist: x.artist, album: x.album, duration: x.duration, kind: x.kind, remote: x.remote })),
    order: player.order, pos: player.pos, time: player.track && !player.track.remote ? player.currentTime : 0
  }).catch(() => {});
}

async function restoreSession() {
  const s = await kv.get('session').catch(() => null);
  if (!s?.queue?.length || !S.settings.resume) return;
  player.queue = s.queue.map(toTrack);
  player.order = s.order?.length === s.queue.length ? s.order : s.queue.map((_, i) => i);
  player.pos = Math.min(s.pos ?? 0, player.order.length - 1);
  player.dispatchEvent(new Event('queue'));
  await player.loadAt(player.pos, { play: false, at: s.time || 0 });
}

// ------------------------------------------------------------------ arranque
async function boot() {
  const [settings, library, playlists] = await Promise.all([kv.get('settings'), kv.get('library'), kv.get('playlists')]).catch(() => [null, null, null]);
  if (settings) S.settings = { ...structuredClone(DEFAULT_SETTINGS), ...settings, eq: { ...DEFAULT_SETTINGS.eq, ...settings.eq }, lyrics: { ...DEFAULT_SETTINGS.lyrics, ...settings.lyrics } };
  S.library = Array.isArray(library) ? library : [];
  S.playlists = Array.isArray(playlists) ? playlists : [];
  for (const tr of S.library) bySrc.set(tr.src, tr);

  setLang(S.settings.lang);
  $('#app').dataset.skin = S.settings.skin;
  $('#app').dataset.platform = platform.name;
  $('#app').dataset.lyricsSize = S.settings.lyrics.size;
  $('#search').placeholder = t('search');
  $('.search-ic').innerHTML = icon('search', 17);
  $('#skinBtn').innerHTML = icon('palette', 20);
  $('#skinBtn').title = t('interface');
  $('#stageClose').innerHTML = icon('close', 20);

  // audio
  audio.state = { ...audio.state, ...S.settings.eq };
  player.setVolume(S.settings.volume);
  player.setMuted(S.settings.muted);
  player.setSpeed(S.settings.speed);
  player.shuffle = S.settings.shuffle;
  player.repeat = S.settings.repeat;

  // eventos del reproductor
  player.addEventListener('time', () => { if (!dragging) paintTime(); });
  player.addEventListener('state', () => {
    renderBar();
    const playing = !player.paused && !!player.track;
    $('#app').classList.toggle('is-playing', playing);
    platform.keepAwake?.(playing);
  });
  player.addEventListener('buffering', (e) => $('#app').classList.toggle('buffering', !!e.detail));
  player.addEventListener('track', (e) => {
    const tr = e.detail;
    renderBarTrack(); renderBar(); paintTime();
    $('#app').classList.toggle('has-video', false);
    onTrackChange(tr);
    refreshView();
    updateMediaSession(tr);
  });
  player.addEventListener('loaded', (e) => {
    const isVideo = player.kind === 'video';
    $('#app').classList.toggle('has-video', isVideo);
    if (isVideo && S.settings.skin === 'aurora' && !S.stageOpen) openStage(true);
    renderBar();
    updateNowPlaying(e.detail?.probe);
  });
  player.addEventListener('queue', () => { import('./ui/views.js').then((m) => m.renderQueue()); saveSession(); });
  player.addEventListener('error', (e) => toast(t(e.detail || 'failed'), 4500));
  player.addEventListener('meta', () => paintTime());

  // estructura
  $('#panelTabs').innerHTML = [['queue', 'queue'], ['lyrics', 'lyrics'], ['eq', 'eq']].map(([p, ic]) => `<button data-p="${p}">${icon(ic, 17)}<span>${t(p === 'eq' ? 'equalizer' : p)}</span></button>`).join('') + `<button class="panel-x" data-p="close">${icon('close', 17)}</button>`;
  $('#panelTabs').onclick = (e) => {
    const b = e.target.closest('button[data-p]');
    if (!b) return;
    if (b.dataset.p === 'close') { S.panel = null; applyPanel(); return; }
    S.panel = b.dataset.p; applyPanel();
  };
  renderEq($('#eqPage'), { compact: true });
  initNowPlaying();
  initSeek();
  initActions();
  initKeys();
  initDrop();
  initMediaSession();
  initAutoScan();
  renderNav();
  renderBar();
  renderBarTrack();
  applyPanel();
  renderView();
  renderLyricsState();
  addEventListener('resize', () => applyPanel());
  setInterval(saveSession, 5000);
  addEventListener('beforeunload', saveSession);

  // modo TV (Android TV / Google TV o activado en Ajustes)
  const info = platform.deviceInfo ? await platform.deviceInfo().catch(() => ({})) : {};
  S.device = info;
  if (applyTvMode(info) && S.settings.skin === 'estudio' && !settings) setSkin('aurora');
  if (platform.name === 'android') {
    import('@capacitor/app').then(({ App }) => App.addListener('backButton', () => goBack())).catch(() => {});
  }

  // archivos abiertos desde el sistema (doble clic / «Abrir con»)
  platform.onOpenFiles((files) => openPaths(files, { play: true }));
  const pending = await platform.takePending();
  if (pending?.length) await openPaths(pending, { play: true });
  else await restoreSession().catch(() => {});

  // relee etiquetas pendientes
  enrich(S.library.filter((x) => platform.name === 'desktop' && (!x.metaRead || !x.duration)));
  document.body.classList.add('ready');
}

boot();

// Acceso para pruebas automatizadas y depuración
window.__mmx = { S, player, audio, addEntries, playList, go, setSkin, openStage, setPanel, importPlaylists, createPlaylist, expandItems, applyTvMode, goBack, isTV, tvnav, searchDrives, addPathsToPlaylist, appendToPlaylist, trashTracks };

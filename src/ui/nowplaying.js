// Pantalla de reproducción: portada, tocadiscos, video, letras, subtítulos y visualizador
// MultimediaMX — Copyright (C) 2026 Santiago Miguel — GPL-3.0-or-later
import { S, player, trackLabel, readMeta, coverOf } from '../main.js';
import { platform } from '../core/platform.js';
import { audio } from '../core/audio.js';
import { findLyrics, activeLine, parseSubs, guessQuery } from '../core/lyrics.js';
import { t } from '../i18n/index.js';
import { icon } from './icons.js';
import { $, esc, contextMenu, promptFields } from './dom.js';

let lyricsState = { status: 'idle' };
let lyricToken = 0;
let lastLine = -2;
let subs = { list: [], active: null, cues: [] };
let sidecarCache = null;
let embeddedLyrics = null;

export function initNowPlaying() {
  const lyr = $('#lyrics');
  lyr.addEventListener('click', (e) => {
    const line = e.target.closest('.ly-line[data-t]');
    if (line) { player.seek(+line.dataset.t); if (player.paused) player.play(); return; }
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'ly-search') manualSearch();
    if (a === 'ly-retry') reloadLyrics(true);
  });
  // pausa el desplazamiento automático mientras el usuario lee
  let userScroll = 0;
  lyr.addEventListener('wheel', () => { userScroll = Date.now(); }, { passive: true });
  lyr.addEventListener('touchmove', () => { userScroll = Date.now(); }, { passive: true });
  lyr.userScrolled = () => Date.now() - userScroll < 3500;

  player.addEventListener('time', tick);
  $('#videoWrap').addEventListener('dblclick', () => import('../main.js').then((m) => m.toggleFullscreen()));
  $('#videoWrap').addEventListener('click', (e) => { if (e.target.id === 'video') player.toggle(); });
  requestAnimationFrame(drawLoop);
}

export async function onTrackChange(tr) {
  subs = { list: [], active: null, cues: [] };
  $('#subs').textContent = '';
  sidecarCache = null;
  embeddedLyrics = null;
  updateNowPlaying();
  if (!tr) { lyricsState = { status: 'idle' }; renderLyricsState(); return; }
  const token = ++lyricToken;
  lyricsState = { status: 'loading' };
  renderLyricsState();

  // metadatos y archivos acompañantes en paralelo
  const [meta, side] = await Promise.all([
    tr.remote ? Promise.resolve({}) : readMeta(tr).catch(() => ({})),
    tr.remote ? Promise.resolve({ lrc: null, subtitles: [] }) : platform.sidecars(tr.src).catch(() => ({ lrc: null, subtitles: [] }))
  ]);
  if (token !== lyricToken) return;
  sidecarCache = side;
  embeddedLyrics = meta?.lyrics || null;
  updateNowPlaying();
  import('../main.js').then((m) => { m.renderBarTrack(); });

  // subtítulos externos
  subs.list = (side.subtitles || []).map((s, i) => ({ id: `ext${i}`, label: s.label, text: s.text }));
  if (subs.list.length) setSubtitle(subs.list[0].id);
  await loadLyrics(tr, token, false);
}

export function reloadLyrics(force = false) {
  const tr = player.track;
  if (!tr) return;
  const token = ++lyricToken;
  lyricsState = { status: 'loading' };
  renderLyricsState();
  loadLyrics(tr, token, force);
}

async function loadLyrics(tr, token, force, query = null) {
  const online = S.settings.lyrics.online;
  let res = null;
  try {
    res = await findLyrics(tr, { http: (u) => platform.httpGet(u), sidecarLrc: sidecarCache?.lrc, embedded: embeddedLyrics, online, force, query });
  } catch { res = null; }
  if (token !== lyricToken) return;
  if (res && (res.synced?.length || res.plain)) lyricsState = { status: 'ok', ...res };
  else if (!online) lyricsState = { status: 'disabled' };
  else if (navigator.onLine === false) lyricsState = { status: 'offline' };
  else lyricsState = { status: 'none' };
  lastLine = -2;
  renderLyricsState();
}

function markLyrics() { $('#app').classList.toggle('has-lyrics', lyricsState.status === 'ok'); }

async function manualSearch() {
  const tr = player.track;
  if (!tr) return;
  const q = guessQuery(tr);
  const r = await promptFields(t('lyricsSearch'), [{ name: 'artist', label: t('artist'), value: q.artist }, { name: 'title', label: t('title'), value: q.title }]);
  if (!r?.title) return;
  const token = ++lyricToken;
  lyricsState = { status: 'loading' };
  renderLyricsState();
  loadLyrics(tr, token, true, { artist: r.artist, title: r.title, album: '', duration: tr.duration || player.duration || 0 });
}

export function renderLyricsState() {
  markLyrics();
  const el = $('#lyrics');
  const st = lyricsState;
  const tools = `<div class="ly-tools"><button class="btn ghost xs" data-a="ly-search">${icon('search', 14)}<span>${t('lyricsSearch')}</span></button></div>`;
  el.classList.toggle('synced', st.status === 'ok' && !!st.synced);
  if (!player.track) { el.innerHTML = `<div class="ly-msg">${icon('lyrics', 30)}<p>${t('pickSomething')}</p></div>`; return; }
  if (st.status === 'loading') { el.innerHTML = `<div class="ly-msg"><div class="spinner"></div><p>${t('lyricsSearching')}</p></div>`; return; }
  if (st.status === 'none') { el.innerHTML = `<div class="ly-msg">${icon('lyrics', 30)}<p>${t('lyricsNone')}</p><button class="btn xs" data-a="ly-search">${icon('search', 14)}<span>${t('lyricsSearch')}</span></button></div>`; return; }
  if (st.status === 'offline') { el.innerHTML = `<div class="ly-msg">${icon('globe', 30)}<p>${t('lyricsOffline')}</p><button class="btn xs" data-a="ly-retry">${t('lyricsRetry')}</button></div>`; return; }
  if (st.status === 'disabled') { el.innerHTML = `<div class="ly-msg">${icon('lyrics', 30)}<p>${t('lyricsDisabled')}</p></div>`; return; }
  if (st.status !== 'ok') { el.innerHTML = ''; return; }
  const src = `<div class="ly-src">${t('lyricsSource')}: ${esc({ lrc: '.lrc', tag: 'ID3/Vorbis' }[st.source] || st.source)}</div>`;
  if (st.synced) {
    el.innerHTML = `<div class="ly-scroll"><div class="ly-pad"></div>${st.synced.map((l) => `<p class="ly-line" data-t="${l.time.toFixed(2)}">${esc(l.text) || '<span class="ly-note">♪</span>'}</p>`).join('')}<div class="ly-pad"></div></div>${src}${tools}`;
    lastLine = -2;
    tick();
  } else {
    el.innerHTML = `<div class="ly-scroll plain">${st.plain.split(/\n/).map((l) => `<p class="ly-line">${esc(l) || '&nbsp;'}</p>`).join('')}</div>${src}${tools}`;
  }
}

function tick() {
  const tm = player.currentTime;
  // letra sincronizada
  if (lyricsState.status === 'ok' && lyricsState.synced) {
    const i = activeLine(lyricsState.synced, tm);
    if (i !== lastLine) {
      const el = $('#lyrics');
      const lines = el.querySelectorAll('.ly-line');
      lines.forEach((l, k) => { l.classList.toggle('on', k === i); l.classList.toggle('past', k < i); });
      const cur = lines[i];
      const scroller = el.querySelector('.ly-scroll');
      if (cur && scroller && !el.userScrolled?.()) {
        const top = cur.offsetTop - scroller.clientHeight * 0.38;
        scroller.scrollTo({ top, behavior: Math.abs(i - lastLine) > 3 ? 'auto' : 'smooth' });
      }
      lastLine = i;
    }
  }
  // subtítulos
  if (subs.cues.length) {
    const c = subs.cues.find((x) => tm >= x.start && tm <= x.end);
    const txt = c ? c.text : '';
    const box = $('#subs');
    if (box.dataset.txt !== txt) { box.dataset.txt = txt; box.innerHTML = txt ? `<span>${esc(txt).replace(/\n/g, '<br>').replace(/&lt;(\/?[ibu])&gt;/g, '<$1>')}</span>` : ''; }
  }
}

// ------------------------------------------------------------------ portada / información
export async function updateNowPlaying(probe) {
  const tr = player.track;
  $('#npTitle').textContent = tr ? trackLabel(tr) : t('nothingPlaying');
  $('#npArtist').textContent = tr ? [tr.artist || (tr.remote ? t('stream') : t('unknownArtist')), tr.album].filter(Boolean).join(' — ') : t('pickSomething');
  const p = probe || player.probe;
  const badges = [];
  if (tr) {
    const ext = (tr.src.split(/[?#]/)[0].match(/\.([a-z0-9]+)$/i)?.[1] || '').toUpperCase();
    if (tr.remote) badges.push(t('stream'));
    else if (ext) badges.push(ext);
    if (p?.ok) {
      if (p.video) badges.push(`${p.video.codec.toUpperCase()}${p.video.height ? ' ' + p.video.height + 'p' : ''}`);
      if (p.audio?.[0]) badges.push(p.audio[0].codec.toUpperCase().replace('PCM_', 'PCM '));
      if (p.audio?.length > 1) badges.push(`${p.audio.length} ${t('audioTrack').toLowerCase()}s`);
    }
    if (player.tx) badges.push(`⟳ ${t('converting')}`);
  }
  $('#npBadges').innerHTML = [...new Set(badges)].map((b) => `<span>${esc(b)}</span>`).join('');
  const cover = await coverOf(tr);
  if (tr !== player.track) return;
  for (const img of document.querySelectorAll('#stage img.cover, .stage-bg img')) {
    if (cover) img.src = cover; else img.removeAttribute('src');
  }
  $('#stage').classList.toggle('has-cover', !!cover);
  $('.art-fallback').innerHTML = `<img src="./logo.svg" alt="" />`;
  $('#app').classList.toggle('stream', !!tr?.remote);
}

// ------------------------------------------------------------------ subtítulos y pistas
async function setSubtitle(id) {
  subs.active = id;
  $('#subs').textContent = '';
  $('#subs').dataset.txt = '';
  if (!id) { subs.cues = []; return; }
  const s = subs.list.find((x) => x.id === id);
  if (!s) return;
  if (!s.text && s.stream != null) s.text = await platform.extractSubtitle(player.track.src, s.stream);
  subs.cues = s.text ? parseSubs(s.text) : [];
  tick();
}

export function subtitleMenu(e) {
  const p = player.probe;
  const embedded = (p?.subtitles || []).filter((x) => ['subrip', 'ass', 'ssa', 'mov_text', 'webvtt', 'text'].includes(x.codec));
  for (const [i, s] of embedded.entries()) {
    if (!subs.list.some((x) => x.id === `emb${s.index}`)) subs.list.push({ id: `emb${s.index}`, label: `${t('subtitles')} ${i + 1}${s.lang ? ' (' + s.lang + ')' : ''}`, stream: s.index });
  }
  const r = e.target.closest('button').getBoundingClientRect();
  contextMenu(r.left, r.top - 8 - 40 * (subs.list.length + 1), [
    { label: t('off'), checked: !subs.active, action: () => setSubtitle(null) },
    ...subs.list.map((s) => ({ label: s.label, checked: subs.active === s.id, action: () => setSubtitle(s.id) }))
  ]);
}

export function audioTrackMenu(e) {
  const list = player.probe?.audio || [];
  const cur = player.tx?.audioTrack || 0;
  const r = e.target.closest('button').getBoundingClientRect();
  contextMenu(r.left, r.top - 8 - 40 * list.length, list.map((a, i) => ({
    label: `${i + 1}. ${a.codec.toUpperCase()}${a.lang ? ' · ' + a.lang : ''}${a.channels ? ' · ' + a.channels : ''}`,
    checked: i === cur,
    action: () => player.setAudioTrack(i)
  })));
}

// ------------------------------------------------------------------ visualizador
const bins = new Uint8Array(1024);
let rot = 0;
function drawLoop() {
  requestAnimationFrame(drawLoop);
  const playing = !player.paused && !!player.track;
  const app = $('#app');
  // giro del vinilo
  if (playing) rot = (rot + 0.55 * (player.speed || 1)) % 360;
  app.style.setProperty('--rot', `${rot}deg`);
  if (!S.settings.visualizer || document.hidden) return;
  const have = playing && audio.spectrum(bins);
  const skin = S.settings.skin;
  if (skin === 'estudio') drawBars($('#spectrum'), have);
  if (skin === 'aurora' && S.stageOpen && player.kind !== 'video') drawRing($('.ring-viz'), have);
  // pulso suave para el fondo
  if (have) {
    let sum = 0; for (let i = 2; i < 24; i++) sum += bins[i];
    app.style.setProperty('--beat', (sum / (22 * 255)).toFixed(3));
  }
}

function sizeCanvas(c) {
  const dpr = devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight;
  if (!w || !h) return null;
  if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return { g, w, h };
}

const bandEdges = (n) => [...Array(n + 1)].map((_, i) => Math.round(2 * Math.pow(400, i / n)));

function drawBars(c, have) {
  if (!c) return;
  const s = sizeCanvas(c); if (!s) return;
  const { g, w, h } = s;
  const n = Math.max(16, Math.min(64, Math.floor(w / 9)));
  const edges = bandEdges(n);
  const css = getComputedStyle(c);
  const grad = g.createLinearGradient(0, h, 0, 0);
  grad.addColorStop(0, css.getPropertyValue('--accent').trim() || '#3ee6ff');
  grad.addColorStop(1, css.getPropertyValue('--accent-2').trim() || '#ff5e8a');
  g.fillStyle = grad;
  const bw = w / n;
  for (let i = 0; i < n; i++) {
    let v = 0;
    if (have) { for (let k = edges[i]; k < Math.max(edges[i] + 1, edges[i + 1]); k++) v = Math.max(v, bins[k]); }
    const bh = Math.max(2, (v / 255) * (h - 4));
    g.globalAlpha = 0.9;
    g.fillRect(i * bw + 1.5, h - bh, bw - 3, bh);
    g.globalAlpha = 0.18;
    g.fillRect(i * bw + 1.5, h - bh - 3, bw - 3, 1.5);
  }
  g.globalAlpha = 1;
}

function drawRing(c, have) {
  if (!c) return;
  const s = sizeCanvas(c); if (!s) return;
  const { g, w, h } = s;
  const cx = w / 2, cy = h / 2;
  const r0 = Math.min(w, h) * 0.39;
  const n = 96;
  const edges = bandEdges(n);
  const css = getComputedStyle(c);
  const a1 = css.getPropertyValue('--accent').trim() || '#3ee6ff';
  const a2 = css.getPropertyValue('--accent-2').trim() || '#ff5e8a';
  g.lineCap = 'round';
  g.lineWidth = Math.max(2, (2 * Math.PI * r0) / n * 0.45);
  for (let i = 0; i < n; i++) {
    let v = 0;
    if (have) for (let k = edges[i]; k < Math.max(edges[i] + 1, edges[i + 1]); k++) v = Math.max(v, bins[k]);
    const len = 4 + (v / 255) * Math.min(w, h) * 0.1;
    const ang = (i / n) * Math.PI * 2 - Math.PI / 2;
    g.strokeStyle = i < n / 2 ? a1 : a2;
    g.globalAlpha = 0.35 + (v / 255) * 0.65;
    g.beginPath();
    g.moveTo(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0);
    g.lineTo(cx + Math.cos(ang) * (r0 + len), cy + Math.sin(ang) * (r0 + len));
    g.stroke();
  }
  g.globalAlpha = 1;
}


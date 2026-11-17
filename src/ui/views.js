// Vistas: biblioteca, listas, ajustes y cola — MultimediaMX — GPL-3.0-or-later
import { S, player, go, persist, pickFiles, pickFolder, scanDevice, importPlaylists, exportPlaylist, createPlaylist, playList, queueTracks,
  removeFromLibrary, trashTracks, playlistItemFromTrack, trackLabel, setSkin, coverOf, findBySrc, expandItems,
  searchDrives, cancelSearch, drivesState, pickIntoPlaylist, appendToPlaylist } from '../main.js';
import { platform } from '../core/platform.js';
import { t, setLang } from '../i18n/index.js';
import { icon } from './icons.js';
import { $, $$, esc, fmtTime, fmtTotal, toast, promptText, promptFields, confirmBox, contextMenu, openModal, VirtualList } from './dom.js';
import { renderEq } from './eq.js';
import { openM3UEditor } from './m3ueditor.js';

let vlist = null;
// logos de canales que no cargan: se quitan (sin código en línea, por la política de seguridad)
document.addEventListener('error', (e) => { if (e.target?.matches?.('img.logo')) e.target.remove(); }, true);
let currentRows = [];
const ROW_H = 54;
const isLibView = () => ['library', 'music', 'videos'].includes(S.view);

// selección múltiple en la biblioteca
const sel = { on: false, ids: new Set(), anchor: null };
function clearSel() { sel.on = false; sel.ids.clear(); sel.anchor = null; }

export function renderView() {
  vlist?.destroy(); vlist = null;
  const v = $('#view');
  v.scrollTop = 0;
  if (!isLibView()) clearSel();
  if (isLibView()) return renderLibrary(v);
  if (S.view === 'playlists') return renderPlaylists(v);
  if (S.view === 'playlist') return renderPlaylist(v);
  if (S.view === 'settings') return renderSettings(v);
  S.view = 'library';
  renderLibrary(v);
}

export function refreshView() {
  if (isLibView() && vlist) return fillLibrary();
  if (S.view === 'playlist') return vlist?.refresh();
  if (S.view === 'playlists') return renderPlaylists($('#view'));
}

// ------------------------------------------------------------------ biblioteca
function libraryRows() {
  const q = S.query.trim().toLowerCase();
  let rows = S.library;
  if (S.view === 'music') rows = rows.filter((x) => x.kind !== 'video');
  if (S.view === 'videos') rows = rows.filter((x) => x.kind === 'video');
  if (q) {
    const words = q.split(/\s+/);
    rows = rows.filter((x) => { const hay = `${x.title || ''} ${x.artist || ''} ${x.album || ''} ${x.src}`.toLowerCase(); return words.every((w) => hay.includes(w)); });
  }
  const sort = S.settings.sort || 'added';
  const cmp = {
    added: (a, b) => (b.addedAt || 0) - (a.addedAt || 0),
    title: (a, b) => trackLabel(a).localeCompare(trackLabel(b), undefined, { numeric: true, sensitivity: 'base' }),
    artist: (a, b) => (a.artist || '￿').localeCompare(b.artist || '￿', undefined, { sensitivity: 'base' }) || (a.album || '').localeCompare(b.album || '') || trackLabel(a).localeCompare(trackLabel(b), undefined, { numeric: true }),
    album: (a, b) => (a.album || '￿').localeCompare(b.album || '￿', undefined, { sensitivity: 'base' }) || trackLabel(a).localeCompare(trackLabel(b), undefined, { numeric: true }),
    duration: (a, b) => (b.duration || 0) - (a.duration || 0)
  }[sort];
  return [...rows].sort(cmp);
}

function renderLibrary(v) {
  const title = { library: t('library'), music: t('music'), videos: t('videos') }[S.view];
  const sort = S.settings.sort || 'added';
  v.innerHTML = `
    <div class="view-head">
      <div><h1>${title}</h1><p class="sub" id="libCount"></p></div>
      <div class="head-actions">
        <button class="btn primary" data-a="playAll">${icon('play', 16)}<span>${t('playAll')}</span></button>
        <button class="btn" data-a="shuffleAll">${icon('shuffle', 16)}<span>${t('shuffleAll')}</span></button>
        <button class="btn" data-a="select" title="${t('selectHint')}">${icon('select', 16)}<span>${t('select')}</span></button>
        <button class="btn ghost" data-a="files">${icon('file', 16)}<span>${t('addFiles')}</span></button>
        ${platform.canScanFolders ? `<button class="btn ghost" data-a="folder">${icon('folder', 16)}<span>${t('addFolder')}</span></button>` : ''}
        ${platform.canScanDrives ? `<button class="btn ghost" data-a="drives">${icon('drive', 16)}<span>${t('searchDrives')}</span></button>` : platform.canScanDevice ? `<button class="btn ghost" data-a="device">${icon('phone', 16)}<span>${t('scanDevice')}</span></button>` : ''}
        <button class="btn ghost" data-a="m3u">${icon('import', 16)}<span>${t('importM3U')}</span></button>
        <button class="btn ghost" data-a="url">${icon('globe', 16)}<span>${t('openUrl')}</span></button>
        <button class="btn ghost" data-a="write" title="${t('writeM3UHint')}">${icon('edit', 16)}<span>${t('writeM3U')}</span></button>
      </div>
    </div>
    <div class="scan-bar" id="scanBar" hidden></div>
    <div class="sel-bar" id="selBar" hidden></div>
    <div class="table-head">
      <span class="c-n">#</span>
      ${['title', 'artist', 'album', 'duration'].map((k) => `<button class="c-${k} sort ${sort === k ? 'on' : ''}" data-sort="${k}">${t(k)}</button>`).join('')}
      <span class="c-x"></span>
    </div>
    <div class="vlist" id="libList"></div>
    <div class="empty" id="libEmpty" hidden></div>`;
  vlist = new VirtualList($('#libList'), ROW_H, rowHtml);
  fillLibrary();

  v.querySelector('.head-actions').onclick = (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'playAll' && currentRows.length) playList(currentRows, 0, { shuffle: false });
    if (a === 'shuffleAll' && currentRows.length) playList(currentRows, 0, { shuffle: true });
    if (a === 'select') { sel.on ? clearSel() : (sel.on = true); updateSel(); }
    if (a === 'files') pickFiles();
    if (a === 'folder') pickFolder();
    if (a === 'device') scanDevice();
    if (a === 'drives') openDriveSearch();
    if (a === 'm3u') importPlaylists();
    if (a === 'write') openM3UEditor({ name: S.query ? S.query : '', tracks: currentRows });
    if (a === 'url') openUrl();
  };
  $('#selBar').onclick = (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    const chosen = selectedTracks();
    if (a === 'all') { if (allSelected()) sel.ids.clear(); else currentRows.forEach((x) => sel.ids.add(x.id)); updateSel(); }
    else if (a === 'close') { clearSel(); updateSel(); }
    else if (!chosen.length) return;
    else if (a === 'addpl') addToPlaylistMenu(e, chosen);
    else if (a === 'queue') queueTracks(chosen);
    else if (a === 'play') playList(chosen, 0, { shuffle: false });
    else if (a === 'remove') removeSelected();
    else if (a === 'trash') trashSelected();
  };
  $('#scanBar').onclick = (e) => { if (e.target.closest('[data-a=stop]')) cancelSearch(); };
  v.querySelector('.table-head').onclick = (e) => {
    const k = e.target.closest('[data-sort]')?.dataset.sort;
    if (!k) return;
    S.settings.sort = S.settings.sort === k ? 'added' : k;
    persist('settings');
    renderLibrary(v);
  };
  const list = $('#libList');
  list.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.row');
    if (row && !e.target.closest('button') && !sel.on) playList(currentRows, +row.dataset.i);
  });
  list.addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    const i = +row.dataset.i;
    const tr = currentRows[i];
    const b = e.target.closest('button');
    if (!b && (e.ctrlKey || e.metaKey)) { sel.on = true; toggleSel(tr, i); return; }
    if (!b && e.shiftKey && sel.anchor != null) { sel.on = true; selectRange(sel.anchor, i); return; }
    if (sel.on && (!b || b.dataset.a === 'chk')) { toggleSel(tr, i); return; }
    if (b?.dataset.a === 'play' || (!b && (matchMedia('(pointer: coarse)').matches || e.detail === 0))) playList(currentRows, i);
    else if (b?.dataset.a === 'add') addToPlaylistMenu(e, [tr]);
    else if (b?.dataset.a === 'more') trackMenu(e, tr, i);
  });
  list.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    e.preventDefault();
    trackMenu(e, currentRows[+row.dataset.i], +row.dataset.i);
  });
}

function fillLibrary() {
  currentRows = libraryRows();
  // la selección solo conserva lo que sigue existiendo
  if (sel.ids.size) { const live = new Set(S.library.map((x) => x.id)); for (const id of sel.ids) if (!live.has(id)) sel.ids.delete(id); }
  vlist.set(currentRows);
  const total = currentRows.reduce((a, x) => a + (x.duration || 0), 0);
  const cnt = $('#libCount');
  if (cnt) cnt.textContent = `${currentRows.length.toLocaleString()} ${currentRows.length === 1 ? t('track') : t('tracks')}${total ? ' · ' + fmtTotal(total) : ''}${S.scanning && !S.scanFound ? ' · ' + t('loadingMeta') : ''}`;
  const sb = $('#scanBar');
  if (sb) {
    sb.hidden = !S.scanning || !S.scanFound && !platform.canScanDrives;
    if (!sb.hidden) sb.innerHTML = `<span class="spin"></span><span>${t('scanning')}${S.scanFound ? ` · ${t('foundN', { n: S.scanFound.toLocaleString() })}` : ''}</span>${platform.name === 'desktop' ? `<button class="btn ghost xs" data-a="stop">${icon('stop', 14)}<span>${t('stop')}</span></button>` : ''}`;
  }
  updateSel(false);
  const empty = $('#libEmpty');
  if (empty) {
    empty.hidden = currentRows.length > 0;
    $('#libList').hidden = !currentRows.length;
    if (!currentRows.length) {
      empty.innerHTML = S.query
        ? `${icon('search', 44)}<h2>“${esc(S.query)}”</h2><p>—</p>`
        : `<img src="./logo.svg" width="96" height="96" alt="" /><h2>${t('emptyLibrary')}</h2><p>${t('emptyLibraryHint')}</p>
           <div class="empty-actions"><button class="btn primary" data-a="files">${icon('file', 16)}<span>${t('addFiles')}</span></button>
           ${platform.canScanFolders ? `<button class="btn" data-a="folder">${icon('folder', 16)}<span>${t('addFolder')}</span></button>` : ''}
           ${platform.canScanDrives ? `<button class="btn" data-a="drives">${icon('drive', 16)}<span>${t('searchDrives')}</span></button>` : platform.canScanDevice ? `<button class="btn" data-a="device">${icon('phone', 16)}<span>${t('scanDevice')}</span></button>` : ''}
           <button class="btn ghost" data-a="m3u">${icon('import', 16)}<span>${t('importM3U')}</span></button>
           <button class="btn ghost" data-a="write">${icon('edit', 16)}<span>${t('writeM3U')}</span></button></div>
           <p class="hint">${t('shortcuts')}</p>`;
      empty.onclick = (e) => { const a = e.target.closest('[data-a]')?.dataset.a; if (a === 'files') pickFiles(); if (a === 'folder') pickFolder(); if (a === 'device') scanDevice(); if (a === 'drives') openDriveSearch(); if (a === 'm3u') importPlaylists(); if (a === 'write') openM3UEditor(); };
    }
  }
}

function rowHtml(tr, i, top) {
  const cur = player.track && player.track.src === tr.src;
  const picked = sel.ids.has(tr.id);
  const num = sel.on
    ? `<button class="chk ${picked ? 'on' : ''}" data-a="chk" tabindex="-1" aria-label="${t('select')}">${picked ? icon('check', 14) : ''}</button>`
    : `<span class="num">${i + 1}</span><button class="row-play" data-a="play" title="${t('play')}" tabindex="-1">${icon(cur && !player.paused ? 'pause' : 'play', 16)}</button>${cur ? '<span class="eq-anim"><i></i><i></i><i></i></span>' : ''}`;
  return `<div class="row ${cur ? 'playing' : ''} ${picked ? 'selected' : ''} ${i % 2 ? 'odd' : ''}" tabindex="0" data-i="${i}" style="top:${top}px" aria-selected="${picked}">
    <span class="c-n">${num}</span>
    <span class="c-title"><span class="kind">${icon(tr.kind === 'video' ? 'video' : 'music', 16)}</span><span class="t2"><span class="ellip">${esc(trackLabel(tr))}</span><small class="ellip m-sub">${esc(tr.artist || '')}</small></span></span>
    <span class="c-artist ellip">${esc(tr.artist || (tr.remote ? t('stream') : ''))}</span>
    <span class="c-album ellip">${esc(tr.album || '')}</span>
    <span class="c-duration">${tr.duration ? fmtTime(tr.duration) : ''}</span>
    <span class="c-x"><button class="icon-btn xs" data-a="add" title="${t('addToPlaylist')}" tabindex="-1">${icon('plus', 16)}</button><button class="icon-btn xs" data-a="more" tabindex="-1">${icon('more', 16)}</button></span>
  </div>`;
}

// ---- selección
const selectedTracks = () => S.library.filter((x) => sel.ids.has(x.id));
const allSelected = () => currentRows.length > 0 && currentRows.every((x) => sel.ids.has(x.id));
function toggleSel(tr, i) {
  if (!tr) return;
  if (sel.ids.has(tr.id)) sel.ids.delete(tr.id); else sel.ids.add(tr.id);
  sel.anchor = i;
  updateSel();
}
function selectRange(a, b) {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  for (let k = lo; k <= hi; k++) if (currentRows[k]) sel.ids.add(currentRows[k].id);
  updateSel();
}
function updateSel(repaint = true) {
  const bar = $('#selBar');
  if (!bar) return;
  $('#view .head-actions [data-a=select]')?.classList.toggle('on', sel.on);
  $('#view').classList.toggle('selecting', sel.on);
  bar.hidden = !sel.on;
  if (sel.on) {
    const n = sel.ids.size;
    const dis = n ? '' : 'disabled';
    bar.innerHTML = `
      <button class="btn ghost sm" data-a="all">${icon('select', 16)}<span>${allSelected() ? t('selectNone') : t('selectAll')}</span></button>
      <strong class="sel-count">${t('selectedN', { n: n.toLocaleString() })}</strong>
      <span class="sel-actions">
        <button class="btn sm" data-a="play" ${dis}>${icon('play', 15)}<span>${t('play')}</span></button>
        <button class="btn sm" data-a="addpl" ${dis}>${icon('plus', 15)}<span>${t('addToPlaylist')}</span></button>
        <button class="btn sm" data-a="queue" ${dis}>${icon('queue', 15)}<span>${t('addToQueue')}</span></button>
        <button class="btn sm danger-btn" data-a="remove" ${dis}>${icon('close', 15)}<span>${t('removeFromLibrary')}</span></button>
        ${platform.canTrash ? `<button class="btn sm danger-btn" data-a="trash" ${dis}>${icon('trash', 15)}<span>${t('moveToTrash')}</span></button>` : ''}
      </span>
      <button class="icon-btn" data-a="close" title="${t('cancel')}">${icon('close', 18)}</button>`;
  }
  if (repaint) vlist?.refresh();
}
async function removeSelected(tracks = selectedTracks()) {
  if (!tracks.length) return;
  if (tracks.length > 1 && !await confirmBox(t('confirmRemoveN', { n: tracks.length.toLocaleString() }))) return;
  removeFromLibrary(tracks.map((x) => x.id));
  tracks.forEach((x) => sel.ids.delete(x.id));
  toast(t('removedN', { n: tracks.length.toLocaleString() }));
  updateSel();
}
async function trashSelected(tracks = selectedTracks()) {
  const local = tracks.filter((x) => !x.remote && !x.ephemeral);
  if (!local.length) { toast(t('nothingToTrash'), 3000); return; }
  if (!await confirmBox(t('confirmTrashN', { n: local.length.toLocaleString() }))) return;
  const r = await trashTracks(local);
  local.forEach((x) => { if (r.ok.includes(x.src)) sel.ids.delete(x.id); });
  toast(r.failed.length ? t('trashPartial', { ok: r.ok.length, failed: r.failed.length }) : t('trashedN', { n: r.ok.length.toLocaleString() }), 4000);
  updateSel();
}
// atajos: Ctrl/⌘+A seleccionar todo, Supr quitar, Esc salir de la selección
document.addEventListener('keydown', (e) => {
  if (!isLibView() || S.stageOpen || e.target.closest?.('input, textarea, select') || $('#modal.show')) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); sel.on = true; currentRows.forEach((x) => sel.ids.add(x.id)); updateSel(); }
  else if ((e.key === 'Delete' || (e.key === 'Backspace' && e.metaKey)) && sel.ids.size) { e.preventDefault(); if (e.shiftKey && platform.canTrash) trashSelected(); else removeSelected(); }
  else if (e.key === 'Escape' && sel.on) { e.stopPropagation(); clearSel(); updateSel(); }
}, true);

function trackMenu(e, tr, i) {
  if (sel.ids.size > 1 && sel.ids.has(tr.id)) {
    const chosen = selectedTracks();
    contextMenu(e.clientX, e.clientY, [
      { label: `${t('play')} (${chosen.length})`, icon: 'play', action: () => playList(chosen, 0, { shuffle: false }) },
      { label: t('addToQueue'), icon: 'queue', action: () => queueTracks(chosen) },
      { label: t('addToPlaylist'), icon: 'plus', action: () => addToPlaylistMenu(e, chosen) },
      '-',
      { label: `${t('removeFromLibrary')} (${chosen.length})`, icon: 'close', danger: true, action: () => removeSelected(chosen) },
      ...(platform.canTrash ? [{ label: `${t('moveToTrash')} (${chosen.length})`, icon: 'trash', danger: true, action: () => trashSelected(chosen) }] : [])
    ]);
    return;
  }
  contextMenu(e.clientX, e.clientY, [
    { label: t('play'), icon: 'play', action: () => playList(currentRows, i) },
    { label: t('playNext'), icon: 'next', action: () => queueTracks([tr], true) },
    { label: t('addToQueue'), icon: 'queue', action: () => queueTracks([tr]) },
    { label: t('addToPlaylist'), icon: 'plus', action: () => addToPlaylistMenu(e, [tr]) },
    { label: t('select'), icon: 'select', action: () => { sel.on = true; toggleSel(tr, i); } },
    '-',
    ...(platform.canRevealFiles && !tr.remote ? [{ label: t('reveal'), icon: 'folder', action: () => platform.reveal(tr.src) }] : []),
    { label: t('removeFromLibrary'), icon: 'close', danger: true, action: () => removeSelected([tr]) },
    ...(platform.canTrash && !tr.remote && !tr.ephemeral ? [{ label: t('moveToTrash'), icon: 'trash', danger: true, action: () => trashSelected([tr]) }] : [])
  ]);
}

// ------------------------------------------------------------------ buscar en unidades
export async function openDriveSearch() {
  const drives = await platform.listDrives().catch(() => []);
  drivesState.last = drives;
  const android = platform.name === 'android';
  const opts = [
    ...(android ? [{ path: '*mediastore', label: t('mediaIndex'), sub: t('mediaIndexHint'), ic: 'phone' }] : []),
    ...drives.map((d) => ({ path: d.path, label: d.label, sub: d.path, ic: d.type === 'folder' ? 'folder' : 'drive', removable: d.removable }))
  ];
  const roots = await openModal(`
    <h3>${icon('drive', 20)} ${t('searchDrives')}</h3>
    <p class="sub modal-hint">${t('searchDrivesHint')}</p>
    <div class="drive-list">${opts.length ? opts.map((o, k) => `
      <label class="drive-row"><input type="checkbox" data-k="${k}" checked /><span class="drive-ic">${icon(o.ic, 20)}</span>
        <span class="drive-txt"><strong class="ellip">${esc(o.label)}</strong><small class="ellip">${esc(o.sub)}</small></span>${o.removable ? `<em class="badge">${t('external')}</em>` : ''}</label>`).join('') : `<p class="sub">${t('noDrives')}</p>`}
    </div>
    <label class="switch"><input type="checkbox" data-auto ${S.settings.autoScan !== false ? 'checked' : ''}/><span></span>${t('autoScan')}</label>
    <div class="modal-actions">
      ${platform.canScanFolders ? `<button class="btn ghost" data-a="folder">${icon('folder', 16)}<span>${t('chooseFolder')}</span></button>` : ''}
      <button class="btn ghost" data-a="no">${t('cancel')}</button>
      <button class="btn primary" data-a="ok">${icon('search', 16)}<span>${t('searchNow')}</span></button>
    </div>`,
  (root, close) => {
    root.querySelector('.modal-card').classList.add('wide');
    const auto = $('[data-auto]', root);
    auto.onchange = () => { S.settings.autoScan = auto.checked; persist('settings'); if (!auto.checked) drivesState.known = null; };
    $('[data-a=ok]', root).onclick = () => close($$('.drive-row input:checked', root).map((i) => opts[+i.dataset.k].path));
    $('[data-a=no]', root).onclick = () => close(null);
    const f = $('[data-a=folder]', root);
    if (f) f.onclick = () => close('folder');
    $('[data-a=ok]', root).focus();
  });
  if (roots === 'folder') return pickFolder();
  if (roots?.length) searchDrives(roots);
}

export function addToPlaylistMenu(e, tracks) {
  const items = tracks.map(playlistItemFromTrack);
  contextMenu(e.clientX, e.clientY, [
    { label: `${t('newPlaylist')}…`, icon: 'plus', action: async () => {
      const name = await promptText(t('newPlaylistName'), '', t('newPlaylist'));
      if (!name) return;
      createPlaylist(name, items);
      toast(`${t('playlistCreated')}: ${name}`);
      refreshView();
    } },
    ...(S.playlists.length ? ['-'] : []),
    ...S.playlists.map((pl) => ({ label: pl.name, icon: 'list', action: () => appendToPlaylist(pl, items) }))
  ]);
}

function markPlaying() {
  $$('#view .pl-row').forEach((r) => r.classList.toggle('playing', !!player.track && r.dataset.src === player.track.src));
}

// ------------------------------------------------------------------ listas
function renderPlaylists(v) {
  v.innerHTML = `
    <div class="view-head">
      <div><h1>${t('playlists')}</h1><p class="sub">${S.playlists.length} · M3U / M3U8</p></div>
      <div class="head-actions">
        <button class="btn primary" data-a="new">${icon('plus', 16)}<span>${t('newPlaylist')}</span></button>
        <button class="btn" data-a="m3u">${icon('import', 16)}<span>${t('importM3U')}</span></button>
        <button class="btn" data-a="url">${icon('globe', 16)}<span>${t('openUrl')}</span></button>
        <button class="btn ghost" data-a="write">${icon('edit', 16)}<span>${t('writeM3U')}</span></button>
      </div>
    </div>
    ${S.playlists.length ? `<div class="pl-grid">${S.playlists.map((pl) => {
      const dur = pl.items.reduce((a, x) => a + (x.duration || 0), 0);
      const hue = [...pl.name].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
      return `<div class="pl-card" tabindex="0" data-id="${pl.id}" style="--h:${hue}">
        <div class="pl-art"><div class="pl-mosaic" data-id="${pl.id}"></div>${icon('list', 34)}<button class="pl-play" data-a="play" title="${t('play')}" tabindex="-1">${icon('play', 22)}</button>
          <button class="pl-del" data-a="del" title="${t('deletePlaylist')}" tabindex="-1">${icon('trash', 17)}</button></div>
        <div class="pl-name ellip">${esc(pl.name)}</div>
        <div class="pl-meta">${pl.items.length.toLocaleString()} ${pl.items.length === 1 ? t('track') : t('tracks')}${dur ? ' · ' + fmtTotal(dur) : ''}</div>
      </div>`;
    }).join('')}</div>` : `<div class="empty">${icon('list', 48)}<h2>${t('emptyPlaylists')}</h2><p>${t('emptyPlaylistsHint')}</p>
      <div class="empty-actions"><button class="btn primary" data-a="new">${icon('plus', 16)}<span>${t('newPlaylist')}</span></button><button class="btn" data-a="m3u">${icon('import', 16)}<span>${t('importM3U')}</span></button><button class="btn" data-a="url">${icon('globe', 16)}<span>${t('openUrl')}</span></button></div></div>`}`;
  v.onclick = async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    const card = e.target.closest('.pl-card');
    if (a === 'new') {
      const name = await promptText(t('newPlaylistName'), '', t('newPlaylist'));
      if (name) { const pl = createPlaylist(name); go('playlist', pl.id); }
    } else if (a === 'm3u') importPlaylists();
    else if (a === 'url') openUrl();
    else if (a === 'write') openM3UEditor();
    else if (card && a === 'del') {
      const pl = S.playlists.find((p) => p.id === card.dataset.id);
      if (pl && await confirmBox(t('confirmDelete', { name: pl.name }))) {
        S.playlists = S.playlists.filter((p) => p !== pl);
        persist('playlists');
        toast(`${t('deleted')}: ${pl.name}`);
        renderPlaylists(v);
      }
    } else if (card && a === 'play') { const pl = S.playlists.find((p) => p.id === card.dataset.id); if (pl?.items.length) playList(pl.items, 0); }
    else if (card) go('playlist', card.dataset.id);
  };
  // mosaico de portadas
  for (const el of $$('.pl-mosaic', v)) {
    const pl = S.playlists.find((p) => p.id === el.dataset.id);
    const firsts = (pl?.items || []).slice(0, 12).map((i) => findBySrc(i.src)).filter((x) => x?.hasCover).slice(0, 4);
    Promise.all(firsts.map(coverOf)).then((cs) => {
      const ok = cs.filter(Boolean);
      if (!ok.length) return;
      el.innerHTML = (ok.length >= 4 ? ok.slice(0, 4) : [ok[0]]).map((c) => `<img src="${c}" alt="" />`).join('');
      el.classList.toggle('four', ok.length >= 4);
      el.parentElement.classList.add('has-art');
    });
  }
}

const plFilter = { id: null, q: '', group: '' };

function renderPlaylist(v) {
  const pl = S.playlists.find((p) => p.id === S.playlistId);
  if (!pl) return go('playlists');
  if (plFilter.id !== pl.id) Object.assign(plFilter, { id: pl.id, q: '', group: '' });
  const dur = pl.items.reduce((a, x) => a + (x.duration || 0), 0);
  const groups = [...new Set(pl.items.map((i) => i.group).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const showFilter = groups.length > 1 || pl.items.length > 40;
  v.innerHTML = `
    <div class="view-head">
      <div class="with-back"><button class="icon-btn" data-a="back" title="${t('playlists')}">${icon('back', 20)}</button>
        <div><h1 class="ellip">${esc(pl.name)}</h1><p class="sub" id="plCount"></p></div></div>
      <div class="head-actions">
        <button class="btn primary" data-a="play" ${pl.items.length ? '' : 'disabled'}>${icon('play', 16)}<span>${t('play')}</span></button>
        <button class="btn" data-a="shuffle" ${pl.items.length ? '' : 'disabled'}>${icon('shuffle', 16)}<span>${t('shuffleAll')}</span></button>
        <button class="btn" data-a="addFiles" title="${t('dropFilesHint')}">${icon('file', 16)}<span>${t('addFiles')}</span></button>
        ${platform.canScanFolders ? `<button class="btn ghost" data-a="addFolder">${icon('folder', 16)}<span>${t('addFolder')}</span></button>` : ''}
        <button class="btn ghost" data-a="export">${icon('save', 16)}<span>${t('export')}</span></button>
        <button class="btn ghost" data-a="editM3U">${icon('edit', 16)}<span>${t('editAsM3U')}</span></button>
        <button class="icon-btn" data-a="rename" title="${t('rename')}">${icon('edit', 18)}</button>
        <button class="btn ghost danger-btn" data-a="delete">${icon('trash', 16)}<span>${t('deletePlaylist')}</span></button>
      </div>
    </div>
    ${showFilter ? `<div class="pl-filter">
      <label class="search sm">${icon('search', 16)}<input type="search" class="pl-q" placeholder="${esc(t('filterList'))}" value="${esc(plFilter.q)}" /></label>
      ${groups.length > 1 ? `<select class="field sm pl-group"><option value="">${t('allGroups')} (${groups.length})</option>${groups.map((g) => `<option value="${esc(g)}" ${plFilter.group === g ? 'selected' : ''}>${esc(g)}</option>`).join('')}</select>` : ''}
    </div>` : ''}
    ${pl.items.length ? '<div class="vlist pl-vlist" id="plList"></div>' : `<div class="empty drop-zone">${icon('import', 44)}<h2>${t('emptyPlaylist')}</h2><p>${t('emptyPlaylistHint')}</p>
      <div class="empty-actions"><button class="btn primary" data-a="addFiles">${icon('file', 16)}<span>${t('addFiles')}</span></button>
      ${platform.canScanFolders ? `<button class="btn" data-a="addFolder">${icon('folder', 16)}<span>${t('addFolder')}</span></button>` : ''}
      <button class="btn ghost" data-a="lib">${icon('library', 16)}<span>${t('library')}</span></button></div></div>`}`;

  let rows = [];
  const filtered = () => !!(plFilter.q.trim() || plFilter.group);
  const listToPlay = () => (filtered() ? rows.map((r) => r.it) : pl.items);
  const fill = () => {
    const q = plFilter.q.trim().toLowerCase();
    rows = [];
    pl.items.forEach((it, idx) => {
      if (plFilter.group && it.group !== plFilter.group) return;
      if (q && !`${it.title || ''} ${it.artist || ''} ${it.group || ''} ${it.src}`.toLowerCase().includes(q)) return;
      rows.push({ it, idx });
    });
    const c = $('#plCount', v);
    if (c) c.textContent = `${pl.items.length.toLocaleString()} ${pl.items.length === 1 ? t('track') : t('tracks')}${filtered() ? ` · ${t('shown')} ${rows.length.toLocaleString()}` : ''}${dur ? ' · ' + fmtTotal(dur) : ''}`;
    plList?.set(rows);
  };
  const el = $('#plList', v);
  const plList = el ? new VirtualList(el, ROW_H, (r, i, top) => {
    const it = r.it;
    return `<div class="pl-row ${it.missing ? 'missing' : ''} ${player.track?.src === it.src ? 'playing' : ''}" tabindex="0" data-i="${i}" data-idx="${r.idx}" data-src="${esc(it.src)}" style="top:${top}px" draggable="${filtered() ? 'false' : 'true'}">
        <span class="c-n"><span class="num">${r.idx + 1}</span><button class="row-play" data-a="playOne" tabindex="-1">${icon('play', 16)}</button><span class="eq-anim"><i></i><i></i><i></i></span></span>
        <span class="c-title"><span class="kind">${it.logo ? `<img class="logo" src="${esc(it.logo)}" alt="" loading="lazy" />` : icon(it.remote ? 'globe' : it.kind === 'video' ? 'video' : 'music', 16)}</span>
          <span class="ellip">${esc(it.title || trackLabel(it))}${it.missing ? ` <em>(${t('notFound')})</em>` : ''}</span></span>
        <span class="c-artist ellip">${esc(it.artist || (it.remote ? (it.group || t('stream')) : ''))}</span>
        <span class="c-duration">${it.duration ? fmtTime(it.duration) : it.remote ? '∞' : ''}</span>
        <span class="c-x"><button class="icon-btn xs" data-a="rm" title="${t('remove')}" tabindex="-1">${icon('close', 15)}</button></span>
      </div>`;
  }) : null;
  vlist = plList;
  fill();

  const qIn = $('.pl-q', v);
  if (qIn) qIn.oninput = () => { plFilter.q = qIn.value; fill(); };
  const gSel = $('.pl-group', v);
  if (gSel) gSel.onchange = () => { plFilter.group = gSel.value; fill(); };

  const playRow = (row) => playList(listToPlay(), filtered() ? +row.dataset.i : +row.dataset.idx);
  v.onclick = async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    const row = e.target.closest('.pl-row');
    if (a === 'back') go('playlists');
    else if (a === 'lib') go('library');
    else if (a === 'play') playList(listToPlay(), 0, { shuffle: false });
    else if (a === 'shuffle') playList(listToPlay(), 0, { shuffle: true });
    else if (a === 'export') exportPlaylist(pl);
    else if (a === 'addFiles') pickIntoPlaylist(pl);
    else if (a === 'addFolder') pickIntoPlaylist(pl, true);
    else if (a === 'editM3U') { if (await openM3UEditor({ playlist: pl })) renderPlaylist(v); }
    else if (a === 'rename') {
      const name = await promptText(t('rename'), pl.name);
      if (name) { pl.name = name; persist('playlists'); renderPlaylist(v); }
    } else if (a === 'delete') {
      if (await confirmBox(t('confirmDelete', { name: pl.name }))) {
        S.playlists = S.playlists.filter((p) => p !== pl); persist('playlists'); toast(t('deleted')); go('playlists');
      }
    } else if (row && a === 'rm') { pl.items.splice(+row.dataset.idx, 1); persist('playlists'); fill(); }
    else if (row && (a === 'playOne' || matchMedia('(pointer: coarse)').matches || e.detail === 0)) playRow(row);
  };
  v.ondblclick = (e) => { const row = e.target.closest('.pl-row'); if (row && !e.target.closest('button')) playRow(row); };
  // reordenar arrastrando (sin filtro activo)
  let from = null;
  v.ondragstart = (e) => { const r = e.target.closest('.pl-row'); if (r && !filtered()) { from = +r.dataset.idx; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(from)); } };
  v.ondragover = (e) => { const r = e.target.closest('.pl-row'); if (r && from != null) { e.preventDefault(); $$('.pl-row', v).forEach((x) => x.classList.toggle('drop-target', x === r)); } };
  v.ondrop = (e) => {
    const r = e.target.closest('.pl-row');
    if (r && from != null) {
      e.preventDefault(); e.stopPropagation();
      const to = +r.dataset.idx;
      const [x] = pl.items.splice(from, 1); pl.items.splice(to, 0, x);
      persist('playlists'); fill();
    }
    from = null;
  };
}

// ------------------------------------------------------------------ abrir URL
export async function openUrl() {
  const r = await promptFields(t('openUrlTitle'), [{ name: 'url', label: 'URL', value: '' }, { name: 'name', label: t('playlistName'), value: '' }], t('openUrlHint'));
  const url = r?.url?.trim();
  if (!url) return;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) { toast('URL: http://…  https://…', 3000); return; }
  const items = [{ src: url, remote: true, title: null, kind: 'video' }];
  await expandItems(items);
  let name = r.name?.trim();
  if (!name) { try { const u = new URL(url); name = items.length > 1 ? (u.host + u.pathname).replace(/\/$/, '') : u.host; } catch { name = t('newPlaylist'); } }
  if (items.length === 1 && !items[0].title) items[0].title = name;
  const pl = createPlaylist(name, items);
  go('playlist', pl.id);
  if (items.length === 1) playList(pl.items, 0);
}

// ------------------------------------------------------------------ cola
const Q_BEFORE = 30, Q_AFTER = 300;
export function renderQueue() {
  const el = $('#queuePage');
  if (!player.order.length) { el.innerHTML = `<div class="empty small">${icon('queue', 36)}<p>${t('emptyQueue')}</p></div>`; return; }
  // con colas enormes (listas IPTV) se muestra una ventana alrededor de la pista actual
  const from = Math.max(0, player.pos - Q_BEFORE);
  const to = Math.min(player.order.length, Math.max(player.pos, 0) + Q_AFTER);
  el.innerHTML = `<div class="q-head"><span>${player.order.length.toLocaleString()} ${t('items')}</span><button class="btn ghost xs" data-a="clear">${t('clear')}</button></div>
    <div class="q-list">${from > 0 ? `<div class="q-more">… ${from.toLocaleString()}</div>` : ''}${player.order.slice(from, to).map((qi, k) => {
      const op = from + k;
      const tr = player.queue[qi];
      return `<div class="q-row ${op === player.pos ? 'cur' : ''} ${op < player.pos ? 'past' : ''}" tabindex="0" data-op="${op}" data-qi="${qi}" draggable="true">
        <span class="q-n">${op === player.pos ? '<span class="eq-anim"><i></i><i></i><i></i></span>' : op + 1}</span>
        <span class="q-text"><span class="ellip">${esc(trackLabel(tr))}</span><small class="ellip">${esc(tr.artist || tr.group || '')}</small></span>
        <span class="q-d">${tr.duration ? fmtTime(tr.duration) : ''}</span>
        <button class="icon-btn xs" data-a="rm" tabindex="-1">${icon('close', 14)}</button></div>`;
    }).join('')}${to < player.order.length ? `<div class="q-more">… ${(player.order.length - to).toLocaleString()}</div>` : ''}</div>`;
  el.onclick = (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    const row = e.target.closest('.q-row');
    if (a === 'clear') player.clearQueue();
    else if (row && a === 'rm') player.removeFromQueue(+row.dataset.qi);
    else if (row) player.loadAt(+row.dataset.op, { play: true });
  };
  let dragFrom = null;
  el.ondragstart = (e) => { const r = e.target.closest('.q-row'); if (r) { dragFrom = +r.dataset.op; e.dataTransfer.setData('text/plain', 'q'); } };
  el.ondragover = (e) => { if (dragFrom != null && e.target.closest('.q-row')) e.preventDefault(); };
  el.ondrop = (e) => { const r = e.target.closest('.q-row'); if (r && dragFrom != null) { e.preventDefault(); e.stopPropagation(); player.moveInQueue(dragFrom, +r.dataset.op); } dragFrom = null; };
  el.querySelector('.cur')?.scrollIntoView({ block: 'nearest' });
}

// ------------------------------------------------------------------ ajustes
function renderSettings(v) {
  const st = S.settings;
  const skins = [
    ['aurora', t('skinAurora'), t('skinAuroraDesc')],
    ['vinilo', t('skinVinilo'), t('skinViniloDesc')],
    ['estudio', t('skinEstudio'), t('skinEstudioDesc')]
  ];
  v.innerHTML = `
    <div class="view-head"><div><h1>${t('settings')}</h1><p class="sub">MultimediaMX</p></div></div>
    <section class="set-card">
      <h2>${icon('palette', 20)} ${t('interface')}</h2>
      <p class="sub">${t('interfaceHint')}</p>
      <div class="skin-grid">${skins.map(([id, name, desc]) => `
        <button class="skin-card ${st.skin === id ? 'on' : ''}" data-skin="${id}">
          <div class="skin-prev prev-${id}"><i class="p-a"></i><i class="p-b"></i><i class="p-c"></i><i class="p-d"></i></div>
          <strong>${name}</strong><span>${desc}</span>${st.skin === id ? `<em>${icon('check', 14)}</em>` : ''}
        </button>`).join('')}</div>
    </section>
    <section class="set-card"><h2>${icon('eq', 20)} ${t('equalizer')}</h2><div id="eqSettings"></div></section>
    <section class="set-card">
      <h2>${icon('lyrics', 20)} ${t('lyrics')}</h2>
      <label class="switch"><input type="checkbox" data-k="lyrics.online" ${st.lyrics.online ? 'checked' : ''}/><span></span>${t('lyricsOnline')}</label>
      <label class="switch"><input type="checkbox" data-k="lyrics.autoOpen" ${st.lyrics.autoOpen ? 'checked' : ''}/><span></span>${t('lyricsAutoOpen')}</label>
      <div class="set-row"><span>${t('lyricsSize')}</span><div class="seg" data-k="lyrics.size">${[['s', t('small')], ['m', t('medium')], ['l', t('large')]].map(([k, l]) => `<button data-val="${k}" class="${st.lyrics.size === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>
    </section>
    <section class="set-card">
      <h2>${icon('play', 20)} ${t('playback')}</h2>
      <div class="set-row"><span>${t('speed')}</span><div class="seg" data-k="speed">${[0.5, 0.75, 1, 1.25, 1.5, 2].map((s) => `<button data-val="${s}" class="${st.speed === s ? 'on' : ''}">${s}×</button>`).join('')}</div></div>
      <label class="switch"><input type="checkbox" data-k="resume" ${st.resume ? 'checked' : ''}/><span></span>${t('resume')}</label>
      <label class="switch"><input type="checkbox" data-k="visualizer" ${st.visualizer ? 'checked' : ''}/><span></span>${t('visualizer')}</label>
    </section>
    <section class="set-card">
      <h2>${icon('tv', 20)} ${t('tvMode')}</h2>
      <p class="sub">${t('tvModeHint')}</p>
      <div class="seg" data-k="tvMode">${[['auto', t('tvAuto')], ['on', t('tvOn')], ['off', t('tvOff')]].map(([k, l]) => `<button data-val="${k}" class="${(st.tvMode || 'auto') === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    </section>
    ${platform.canScanDrives ? `<section class="set-card">
      <h2>${icon('drive', 20)} ${t('storageSection')}</h2>
      <p class="sub">${t('storageHint')}</p>
      <label class="switch"><input type="checkbox" data-k="autoScan" ${st.autoScan !== false ? 'checked' : ''}/><span></span>${t('autoScan')}</label>
      <div class="set-row"><button class="btn" data-a="drives">${icon('search', 16)}<span>${t('searchDrives')}…</span></button></div>
    </section>` : ''}
    <section class="set-card">
      <h2>${icon('list', 20)} ${t('playlistsSection')}</h2>
      <label class="switch"><input type="checkbox" data-k="relativePaths" ${st.relativePaths ? 'checked' : ''}/><span></span>${t('relativePaths')}</label>
    </section>
    <section class="set-card">
      <h2>${icon('globe', 20)} ${t('language')}</h2>
      <div class="seg" data-k="lang"><button data-val="es" class="${st.lang === 'es' ? 'on' : ''}">Español</button><button data-val="en" class="${st.lang === 'en' ? 'on' : ''}">English</button></div>
    </section>
    <section class="set-card about">
      <img src="./logo.svg" width="72" height="72" alt="" />
      <div>
        <h2>MultimediaMX</h2>
        <p>${t('aboutText')}</p>
        <p class="sub" id="aboutInfo"></p>
        <p>${t('developer')}: <strong>Santiago Miguel</strong> · 744 354 8848 · chago2850@gmail.com</p>
        <p class="sub">${t('license')}</p>
        <p><a href="#" data-url="https://github.com/chago2850-blip/MultimediaMX">${t('sourceCode')}: github.com/chago2850-blip/MultimediaMX</a> · <a href="#" data-url="https://www.gnu.org/licenses/gpl-3.0.html">GPL-3.0</a></p>
        <p class="sub">${t('shortcuts')}</p>
      </div>
    </section>`;
  renderEq($('#eqSettings'), { compact: false });
  platform.info().then((i) => { const el = $('#aboutInfo'); if (el) el.textContent = `${t('version')} ${i.version} · ${i.platform}${i.electron ? ' · Electron ' + i.electron : ''}${i.ffmpeg ? ' · FFmpeg' : ''}`; });

  v.onclick = (e) => {
    const skin = e.target.closest('[data-skin]')?.dataset.skin;
    if (skin) { setSkin(skin); return; }
    if (e.target.closest('[data-a=drives]')) { openDriveSearch(); return; }
    const a = e.target.closest('a[data-url]');
    if (a) { e.preventDefault(); platform.openExternal(a.dataset.url); return; }
    const segBtn = e.target.closest('.seg button');
    if (segBtn) {
      const k = segBtn.parentElement.dataset.k;
      const raw = segBtn.dataset.val;
      const val = k === 'speed' ? Number(raw) : raw;
      setPath(st, k, val);
      if (k === 'speed') player.setSpeed(val);
      if (k === 'lang') { setLang(val); location.reload(); return; }
      if (k === 'lyrics.size') $('#app').dataset.lyricsSize = val;
      if (k === 'tvMode') { persist('settings'); import('../main.js').then((m) => m.applyTvMode(S.device || {})); }
      persist('settings');
      const scroll = v.scrollTop;
      renderSettings(v);
      v.scrollTop = scroll;
      v.querySelector(`.seg[data-k="${k}"] button[data-val="${raw}"]`)?.focus({ preventScroll: true });
    }
  };
  v.onchange = (e) => {
    const k = e.target.dataset.k;
    if (!k || e.target.type !== 'checkbox') return;
    setPath(st, k, e.target.checked);
    persist('settings');
    if (k === 'lyrics.online') import('./nowplaying.js').then((m) => m.reloadLyrics());
    if (k === 'autoScan') drivesState.known = null;
  };
}

function setPath(obj, path, val) {
  const ks = path.split('.');
  let o = obj;
  for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]];
  o[ks[ks.length - 1]] = val;
}

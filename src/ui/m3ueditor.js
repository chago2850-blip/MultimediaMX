// Editor de listas M3U: escribir, pegar o editar una lista como texto
// MultimediaMX — Copyright (C) 2026 Santiago Miguel — GPL-3.0-or-later
import { S, persist, createPlaylist, findBySrc, go, trackLabel } from '../main.js';
import { platform, kindOf } from '../core/platform.js';
import { parseM3U, writeM3U, isUrl } from '../core/m3u.js';
import { t } from '../i18n/index.js';
import { icon } from './icons.js';
import { $, esc, toast, openModal } from './dom.js';

const EXAMPLE = '#EXTM3U\n#EXTINF:-1,Artista - Canción\n/ruta/a/cancion.mp3\n#EXTINF:-1 group-title="Radio",Mi radio favorita\nhttps://ejemplo.com/stream.mp3\n';

function toText(name, list) {
  return writeM3U(name, list.map((x) => ({ location: x.src, title: x.title || (isUrl(x.src) ? null : trackLabel(x)), artist: x.artist, duration: x.duration })));
}

async function toItems(text) {
  const parsed = parseM3U(text);
  const items = [];
  for (const it of parsed.items) {
    const src = it.location.replace(/^file:\/\//i, '');
    const known = findBySrc(src);
    const remote = isUrl(src);
    let missing = false;
    if (!remote && !known && platform.name === 'desktop') missing = !(await platform.exists(src));
    items.push({
      src, remote, missing,
      title: it.title || known?.title || null,
      artist: it.artist || known?.artist || null,
      duration: it.duration || known?.duration || null,
      kind: known?.kind || kindOf(src) || (remote && /\.m3u8|\/live|\.ts(\?|$)/i.test(src) ? 'video' : 'audio'),
      logo: it.attrs?.['tvg-logo'] || null,
      group: it.group || null
    });
  }
  return { name: parsed.name, items };
}

/**
 * Abre el editor.
 * @param {{ name?: string, tracks?: Array, playlist?: object }} opts
 *   tracks: pistas para rellenar (desde la Biblioteca) · playlist: lista existente a editar
 */
export function openM3UEditor({ name = '', tracks = [], playlist = null } = {}) {
  const startName = playlist?.name || name;
  const startText = playlist ? toText(playlist.name, playlist.items) : tracks.length ? toText(startName, tracks) : '#EXTM3U\n';
  return openModal(`
    <div class="m3u-editor">
      <h3>${icon('edit', 20)} ${playlist ? t('editAsM3U') : t('writeM3U')}</h3>
      <p class="sub">${t('m3uEditorHint')}</p>
      <label class="field-label">${t('playlistName')}<input class="field" name="name" value="${esc(startName)}" placeholder="${esc(t('newPlaylist'))}" /></label>
      <textarea class="field m3u-text" spellcheck="false" placeholder="${esc(EXAMPLE)}">${esc(startText)}</textarea>
      <div class="m3u-status"><span class="m3u-count"></span><button class="btn ghost xs" data-a="example">${t('m3uExample')}</button></div>
      <div class="modal-actions">
        <button class="btn ghost" data-a="no">${t('cancel')}</button>
        <button class="btn" data-a="export">${icon('save', 16)}<span>${t('exportFile')}</span></button>
        <button class="btn primary" data-a="ok">${icon('check', 16)}<span>${playlist ? t('save') : t('saveToPlaylists')}</span></button>
      </div>
    </div>`, (root, close) => {
    root.querySelector('.modal-card').classList.add('wide');
    const ta = $('.m3u-text', root);
    const nameIn = $('[name=name]', root);
    const count = () => {
      const n = parseM3U(ta.value).items.length;
      $('.m3u-count', root).textContent = `${n} ${n === 1 ? t('track') : t('tracks')}`;
    };
    ta.addEventListener('input', count);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') { e.preventDefault(); ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end'); }
      e.stopPropagation();
    });
    count();
    (startName ? ta : nameIn).focus();

    const finalName = (parsedName) => nameIn.value.trim() || parsedName || playlist?.name || t('newPlaylist');

    root.onclick = async (e) => {
      if (e.target === root) { close(null); return; }
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'no') close(null);
      else if (a === 'example') { ta.value = EXAMPLE; count(); ta.focus(); }
      else if (a === 'export') {
        const { name: pn, items } = await toItems(ta.value);
        if (!items.length) { toast(t('m3uEmpty')); return; }
        const where = await platform.savePlaylist(finalName(pn), items.map((i) => ({ location: i.src, title: i.title, artist: i.artist, duration: i.duration, remote: i.remote })), S.settings.relativePaths);
        if (where) toast(`${t('saved')}: ${where}`, 3500);
      } else if (a === 'ok') {
        const { name: pn, items } = await toItems(ta.value);
        if (!items.length) { toast(t('m3uEmpty')); return; }
        const n = finalName(pn);
        let pl = playlist;
        if (pl) { pl.name = n; pl.items = items; persist('playlists'); }
        else pl = createPlaylist(n, items);
        const missing = items.filter((i) => i.missing).length;
        toast(missing ? `${t('playlistCreated')}: ${n} · ${missing} ${t('notFound')}` : `${playlist ? t('saved') : t('playlistCreated')}: ${n}`, 3500);
        close(pl);
        go('playlist', pl.id);
      }
    };
  });
}

// Utilidades de interfaz — MultimediaMX — GPL-3.0-or-later
import { t } from '../i18n/index.js';
import { icon } from './icons.js';

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export function fmtTime(s) {
  if (!Number.isFinite(s) || s < 0) return '--:--';
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
}

export function fmtTotal(s) {
  if (!s) return '';
  if (s < 60) return `${Math.round(s)} s`;
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

let toastTimer = null;
export function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.innerHTML = esc(msg);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function modal(html, onMount) {
  return new Promise((resolve) => {
    const root = $('#modal');
    root.innerHTML = `<div class="modal-card" role="dialog" aria-modal="true">${html}</div>`;
    root.classList.add('show');
    const close = (v) => { root.classList.remove('show'); root.innerHTML = ''; document.removeEventListener('keydown', onKey, true); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } };
    document.addEventListener('keydown', onKey, true);
    root.onclick = (e) => { if (e.target === root) close(null); };
    onMount(root, close);
  });
}

export function promptText(title, value = '', placeholder = '') {
  return modal(`
    <h3>${esc(title)}</h3>
    <input class="field" type="text" value="${esc(value)}" placeholder="${esc(placeholder)}" />
    <div class="modal-actions"><button class="btn ghost" data-a="no">${t('cancel')}</button><button class="btn primary" data-a="ok">${t('ok')}</button></div>`,
  (root, close) => {
    const input = $('input', root);
    input.focus(); input.select();
    input.onkeydown = (e) => { if (e.key === 'Enter') close(input.value.trim() || null); };
    $('[data-a=ok]', root).onclick = () => close(input.value.trim() || null);
    $('[data-a=no]', root).onclick = () => close(null);
  });
}

export function promptFields(title, fields) {
  return modal(`
    <h3>${esc(title)}</h3>
    ${fields.map((f) => `<label class="field-label">${esc(f.label)}<input class="field" name="${f.name}" value="${esc(f.value || '')}" /></label>`).join('')}
    <div class="modal-actions"><button class="btn ghost" data-a="no">${t('cancel')}</button><button class="btn primary" data-a="ok">${t('ok')}</button></div>`,
  (root, close) => {
    const get = () => Object.fromEntries($$('input', root).map((i) => [i.name, i.value.trim()]));
    $('input', root).focus();
    $$('input', root).forEach((i) => { i.onkeydown = (e) => { if (e.key === 'Enter') close(get()); }; });
    $('[data-a=ok]', root).onclick = () => close(get());
    $('[data-a=no]', root).onclick = () => close(null);
  });
}

export function confirmBox(text) {
  return modal(`
    <p class="modal-text">${esc(text)}</p>
    <div class="modal-actions"><button class="btn ghost" data-a="no">${t('cancel')}</button><button class="btn danger" data-a="ok">${t('ok')}</button></div>`,
  (root, close) => {
    $('[data-a=ok]', root).onclick = () => close(true);
    $('[data-a=no]', root).onclick = () => close(false);
    $('[data-a=ok]', root).focus();
  });
}

/** Menú contextual. items: [{label, icon, action, danger, checked}] o '-' */
export function contextMenu(x, y, items) {
  closeMenu();
  const el = document.createElement('div');
  el.className = 'ctx-menu';
  el.innerHTML = items.map((it, i) => it === '-' ? '<hr/>' : `<button data-i="${i}" class="${it.danger ? 'danger' : ''}">${it.icon ? icon(it.icon, 16) : '<span class="ic-space"></span>'}<span>${esc(it.label)}</span>${it.checked ? icon('check', 14, 'tick') : ''}</button>`).join('');
  document.body.appendChild(el);
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
  el.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
  el.onclick = (e) => {
    const b = e.target.closest('button[data-i]');
    if (!b) return;
    closeMenu();
    items[+b.dataset.i].action?.();
  };
  setTimeout(() => {
    document.addEventListener('pointerdown', onAway, true);
    document.addEventListener('keydown', onEsc, true);
  });
}
function onAway(e) { if (!e.target.closest('.ctx-menu')) closeMenu(); }
function onEsc(e) { if (e.key === 'Escape') closeMenu(); }
export function closeMenu() {
  document.querySelectorAll('.ctx-menu').forEach((m) => m.remove());
  document.removeEventListener('pointerdown', onAway, true);
  document.removeEventListener('keydown', onEsc, true);
}

/** Lista virtual de altura fija para bibliotecas grandes. */
export class VirtualList {
  constructor(scroller, rowHeight, renderRow) {
    this.scroller = scroller;
    this.rowHeight = rowHeight;
    this.renderRow = renderRow;
    this.items = [];
    this.inner = document.createElement('div');
    this.inner.className = 'vlist-inner';
    scroller.appendChild(this.inner);
    this.onScroll = () => this.paint();
    scroller.addEventListener('scroll', this.onScroll, { passive: true });
    this.ro = new ResizeObserver(() => this.paint());
    this.ro.observe(scroller);
  }
  set(items) { this.items = items; this.inner.style.height = `${items.length * this.rowHeight}px`; this.last = null; this.paint(); }
  paint() {
    const h = this.scroller.clientHeight || 600;
    const top = Math.max(0, this.scroller.scrollTop - this.inner.offsetTop);
    const start = Math.max(0, Math.floor(top / this.rowHeight) - 8);
    const end = Math.min(this.items.length, Math.ceil((top + h) / this.rowHeight) + 8);
    const key = `${start}:${end}`;
    if (key === this.last) return;
    this.last = key;
    let html = '';
    for (let i = start; i < end; i++) html += this.renderRow(this.items[i], i, i * this.rowHeight);
    this.inner.innerHTML = html;
  }
  refresh() { this.last = null; this.paint(); }
  destroy() { this.scroller.removeEventListener('scroll', this.onScroll); this.ro.disconnect(); }
}

// Navegación con el control remoto (Android TV / Google TV) y teclado sin ratón
// Flechas: mover el foco al elemento más cercano · Enter/OK: activar · Atrás: cerrar o regresar
// MultimediaMX — Copyright (C) 2026 Santiago Miguel — GPL-3.0-or-later
import { $ } from './dom.js';

const FOCUSABLE = 'button:not([disabled]):not([tabindex="-1"]), [tabindex="0"], input:not([type=hidden]):not([tabindex="-1"]), select, textarea, a[href]';
const REGIONS = '#topbar, #main, #stage, #panel, #bar, .modal-card, .ctx-menu';
const DIRS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
let handlers = {};
let enabled = false;

export function isTV() { return enabled; }

/** Activa el modo TV. handlers: { back(), toggle(), next(), prev(), stop(), seek(delta), fullscreen(), isFullscreen() } */
document.addEventListener('focusout', (e) => e.target?.classList?.remove('editing'), true);

export function enableTV(h) {
  handlers = h;
  if (enabled) return;
  enabled = true;
  document.documentElement.classList.add('tv');
  document.addEventListener('keydown', onKey, true);
  // al cambiar de vista, el foco no se pierde
  new MutationObserver(() => { if (!document.activeElement || document.activeElement === document.body) queueMicrotask(restoreFocus); })
    .observe(document.body, { childList: true, subtree: true });
  setTimeout(restoreFocus, 300);
}

export function disableTV() {
  enabled = false;
  document.documentElement.classList.remove('tv');
  document.removeEventListener('keydown', onKey, true);
}

function restoreFocus() {
  if (!enabled) return;
  const a = document.activeElement;
  if (a && a !== document.body && a.isConnected && visible(a)) return;
  const list = candidates();
  const nav = $('#nav button.on');
  const target = (nav && list.includes(nav)) ? nav : list[0];
  target?.focus({ preventScroll: true });
}

/** Zona activa: un menú o diálogo abierto atrapa el foco. */
function scope() {
  return document.querySelector('.ctx-menu') || ($('#modal.show') ? $('#modal .modal-card') : null) || document;
}

function visible(el) {
  if (!el.isConnected) return false;
  if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true })) return false;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return false;
  if (r.right <= 0 || r.left >= innerWidth) return false; // cajones fuera de pantalla
  const app = $('#app');
  const sc = scope();
  if (sc === document) {
    if (app.classList.contains('video-fs')) return !!el.closest('#bar, #videoWrap');
    if (app.classList.contains('stage-open') && el.closest('#main') && app.dataset.skin !== 'vinilo') return false; // tapado por «Reproduciendo»
    if (!app.classList.contains('stage-open') && el.closest('#stage') && getComputedStyle($('#stage')).visibility === 'hidden') return false;
    if (!app.classList.contains('panel-open') && el.closest('#panel')) return false;
  }
  return true;
}

/** Lo que está oculto dentro de un área con desplazamiento solo se alcanza desde esa misma área. */
function clipOk(el, from, allowScroll = false) {
  const r = el.getBoundingClientRect();
  for (let p = el.parentElement; p && p !== document.body && p.id !== 'app'; p = p.parentElement) {
    const cs = getComputedStyle(p);
    const ov = cs.overflowY + cs.overflowX;
    if (!/(auto|scroll|hidden|clip)/.test(ov)) continue;
    const pr = p.getBoundingClientRect();
    const outside = r.bottom <= pr.top + 1 || r.top >= pr.bottom - 1 || r.right <= pr.left + 1 || r.left >= pr.right - 1;
    if (!outside) continue;
    if (!/(auto|scroll)/.test(ov)) return false;          // recortado sin desplazamiento: no se ve
    if (allowScroll || (from && p.contains(from))) continue; // se alcanza desplazando esa área
    return false;
  }
  return true;
}

/** Elementos navegables. Con from: los que se pueden alcanzar desde él. Con all: todos los visibles. */
export { navigate };
export function candidates(from = null, { all = false } = {}) {
  const list = [...scope().querySelectorAll(FOCUSABLE)].filter(visible);
  return list.filter((el) => clipOk(el, from, all));
}

/** Rectángulo de lo que se ve del elemento (recortado por sus contenedores). */
const rectOf = (el) => {
  const target = el.matches('input[type=checkbox]') ? el.closest('label') || el : el;
  const r = target.getBoundingClientRect();
  let { left, top, right, bottom } = r;
  for (let p = target.parentElement; p && p !== document.body; p = p.parentElement) {
    const cs = getComputedStyle(p);
    if (!/(auto|scroll|hidden|clip)/.test(cs.overflowY + cs.overflowX)) continue;
    const pr = p.getBoundingClientRect();
    left = Math.max(left, pr.left); top = Math.max(top, pr.top); right = Math.min(right, pr.right); bottom = Math.min(bottom, pr.bottom);
  }
  if (right - left < 2 || bottom - top < 2) return r; // totalmente oculto: se usa su posición real
  return { left, top, right, bottom, width: right - left, height: bottom - top };
};

/** Elemento más cercano en una dirección (algoritmo de navegación espacial). */
export function nextInDirection(from, dir, list = candidates(from)) {
  const a = rectOf(from);
  const ac = { x: a.left + a.width / 2, y: a.top + a.height / 2 };
  let best = null, bestScore = Infinity;
  for (const el of list) {
    if (el === from || el.contains(from) || from.contains(el)) continue;
    const r = rectOf(el);
    const c = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    let primary, cross, overlap;
    if (dir === 'down' || dir === 'up') {
      overlap = Math.min(a.right, r.right) - Math.max(a.left, r.left);
      const beyond = dir === 'down' ? r.top >= a.bottom - 4 : r.bottom <= a.top + 4;
      const ok = dir === 'down' ? (c.y > ac.y + 2 && r.bottom > a.bottom - 1) : (c.y < ac.y - 2 && r.top < a.top + 1);
      if (!ok || !(beyond || overlap > 0)) continue;
      primary = dir === 'down' ? Math.max(0, r.top - a.bottom) : Math.max(0, a.top - r.bottom);
      cross = overlap > 0 ? 0 : Math.min(Math.abs(r.left - a.right), Math.abs(a.left - r.right));
    } else {
      overlap = Math.min(a.bottom, r.bottom) - Math.max(a.top, r.top);
      const beyond = dir === 'right' ? r.left >= a.right - 4 : r.right <= a.left + 4;
      const ok = dir === 'right' ? (c.x > ac.x + 2 && r.right > a.right - 1) : (c.x < ac.x - 2 && r.left < a.left + 1);
      if (!ok || !(beyond || overlap > 0)) continue;
      primary = dir === 'right' ? Math.max(0, r.left - a.right) : Math.max(0, a.left - r.right);
      cross = overlap > 0 ? 0 : Math.min(Math.abs(r.top - a.bottom), Math.abs(a.top - r.bottom));
    }
    const centerOff = dir === 'down' || dir === 'up' ? Math.abs(c.x - ac.x) : Math.abs(c.y - ac.y);
    const score = primary + cross * 4 + (overlap > 0 ? 0 : 40) + centerOff * 0.05;
    if (score < bestScore) { bestScore = score; best = el; }
  }
  return best;
}

/** Área con desplazamiento más cercana que contiene al elemento (y que de verdad se desplaza). */
function scrollArea(el, vertical) {
  for (let p = el.parentElement; p && p.id !== 'app' && p !== document.body; p = p.parentElement) {
    const cs = getComputedStyle(p);
    const ov = vertical ? cs.overflowY : cs.overflowX;
    if (/(auto|scroll)/.test(ov) && (vertical ? p.scrollHeight > p.clientHeight + 2 : p.scrollWidth > p.clientWidth + 2)) return p;
  }
  return null;
}

/** Primero se avanza dentro del área donde está el foco; solo si ahí no hay nada se sale de ella. */
function navigate(from, dir) {
  const list = candidates(from);
  const area = scrollArea(from, dir === 'up' || dir === 'down');
  if (area) {
    const inside = nextInDirection(from, dir, list.filter((el) => area.contains(el)));
    if (inside) return inside;
  }
  // luego, dentro de la misma zona de la pantalla (menú, contenido, escenario, panel o barra)
  const region = from.closest(REGIONS);
  if (region) {
    const same = nextInDirection(from, dir, list.filter((el) => el.closest(REGIONS) === region));
    if (same) return same;
  }
  const best = nextInDirection(from, dir, list);
  if (best) return best;
  // entrar a un área con desplazamiento cuyo contenido aún no se ve (se desplaza al llegar)
  const f = rectOf(from);
  const extra = candidates(from, { all: true }).filter((el) => {
    if (list.includes(el)) return false;
    const ar = scrollArea(el, dir === 'up' || dir === 'down')?.getBoundingClientRect();
    if (!ar) return false;
    return dir === 'down' ? ar.top >= f.bottom - 6 : dir === 'up' ? ar.bottom <= f.top + 6 : dir === 'right' ? ar.left >= f.right - 6 : ar.right <= f.left + 6;
  });
  return nextInDirection(from, dir, extra);
}

function focusEl(el) {
  if (!el) return false;
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  return true;
}

/** Filas de listas virtuales: se avanza fila por fila aunque aún no estén dibujadas. */
function moveRow(row, dir) {
  const scroller = row.closest('.vlist');
  const vl = scroller?.__vlist;
  if (!vl) return false;
  const i = +row.dataset.i + (dir === 'down' ? 1 : -1);
  if (i < 0 || i >= vl.items.length) return false;
  const h = vl.rowHeight;
  const top = i * h;
  if (top < scroller.scrollTop) scroller.scrollTop = top;
  else if (top + h > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = top + h - scroller.clientHeight;
  vl.paint();
  const next = scroller.querySelector(`[data-i="${i}"]`);
  if (!next) return false;
  next.focus({ preventScroll: true });
  return true;
}

function caretAtEdge(el, dir) {
  try {
    const { selectionStart: s, selectionEnd: e, value } = el;
    if (s !== e) return false;
    if (dir === 'left' || dir === 'up') return s === 0;
    return e === value.length;
  } catch { return true; }
}

let fsUiTimer = null;
function showFsUi() {
  $('#app').classList.add('fs-ui');
  clearTimeout(fsUiTimer);
  fsUiTimer = setTimeout(() => $('#app').classList.remove('fs-ui'), 3500);
}

function onKey(e) {
  if (!enabled) return;
  const key = e.key;
  const a = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;

  // teclas multimedia del control remoto
  const media = { MediaPlayPause: 'toggle', MediaPlay: 'toggle', MediaPause: 'toggle', MediaTrackNext: 'next', MediaTrackPrevious: 'prev', MediaStop: 'stop' };
  if (media[key]) { e.preventDefault(); handlers[media[key]]?.(); return; }
  if (key === 'MediaFastForward' || key === 'MediaRewind') { e.preventDefault(); handlers.seek?.(key === 'MediaRewind' ? -10 : 10); return; }

  if (key === 'Escape' || key === 'GoBack' || key === 'BrowserBack' || key === 'Backspace' && !(a && a.matches('input, textarea'))) {
    if (a?.matches('input, textarea') && key !== 'Escape') return;
    if (a?.matches('.vslider.editing')) { e.preventDefault(); e.stopImmediatePropagation(); a.classList.remove('editing'); return; }
    e.preventDefault(); e.stopImmediatePropagation();
    handlers.back?.();
    setTimeout(restoreFocus, 50);
    return;
  }

  // video a pantalla completa: Izq/Der adelanta o retrocede, OK pausa, Arriba/Abajo muestra controles
  if (handlers.isFullscreen?.() && !(a && a.closest('#bar'))) {
    if (key === 'ArrowLeft' || key === 'ArrowRight') { e.preventDefault(); e.stopImmediatePropagation(); handlers.seek?.(key === 'ArrowLeft' ? -10 : 10); showFsUi(); return; }
    if (key === 'Enter' || key === ' ') { e.preventDefault(); e.stopImmediatePropagation(); handlers.toggle?.(); showFsUi(); return; }
    if (key === 'ArrowUp' || key === 'ArrowDown') { e.preventDefault(); e.stopImmediatePropagation(); showFsUi(); focusEl($('#bar [data-a=toggle]')); return; }
  }

  const dir = DIRS[key];
  if (dir) {
    if (!a) { e.preventDefault(); e.stopImmediatePropagation(); restoreFocus(); return; }
    // controles que usan las flechas por sí mismos
    if (a.matches('input[type=range]') && (dir === 'left' || dir === 'right')) return;
    // ecualizador: OK entra en modo edición (↑/↓ cambian el valor); fuera de él, las flechas navegan
    if (a.matches('.vslider.editing') && (dir === 'up' || dir === 'down')) return;
    if (a.matches('.vslider.editing')) a.classList.remove('editing');
    // textos: ←/→ mueven el cursor; ↑/↓ salen (en un área de texto, solo tras pulsar OK para escribir)
    if (a.matches('input[type=text], input[type=search], input:not([type])') && (dir === 'left' || dir === 'right') && !caretAtEdge(a, dir)) return;
    if (a.matches('textarea.editing')) { if (dir === 'left' || dir === 'right' || !caretAtEdge(a, dir)) return; a.classList.remove('editing'); }
    else if (a.matches('textarea') && (dir === 'left' || dir === 'right') && !caretAtEdge(a, dir)) return;
    if (a.matches('#seek') && (dir === 'left' || dir === 'right')) { e.preventDefault(); e.stopImmediatePropagation(); handlers.seek?.(dir === 'left' ? -10 : 10); return; }
    e.preventDefault(); e.stopImmediatePropagation();
    if (handlers.isFullscreen?.()) showFsUi();
    // filas: Arriba/Abajo de fila en fila; Derecha entra a sus botones
    const row = a.closest('.row, .pl-row');
    if (row && (dir === 'up' || dir === 'down') && moveRow(row, dir)) return;
    if (row && a === row && dir === 'right') { const b = row.querySelector('.c-x button'); if (b) { b.focus({ preventScroll: true }); return; } }
    if (row && a !== row && (dir === 'left' || dir === 'right')) {
      const btns = [...row.querySelectorAll('.c-x button')];
      const i = btns.indexOf(a) + (dir === 'right' ? 1 : -1);
      if (i < 0) { row.focus({ preventScroll: true }); return; }
      if (i < btns.length) { btns[i].focus({ preventScroll: true }); return; }
    }
    const from = row && a !== row ? row : a;
    focusEl(navigate(from, dir));
    return;
  }

  if (key === 'Enter' && a) {
    if (a.matches('textarea')) { if (!a.classList.contains('editing')) { e.preventDefault(); a.classList.add('editing'); } return; }
    if (a.matches('input[type=text], input[type=search], input:not([type]), select')) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (a.matches('#videoWrap')) { handlers.fullscreen?.(); return; }
    if (a.matches('.vslider')) { a.classList.toggle('editing'); return; }
    a.click();
  }
}

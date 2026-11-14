// Ecualizador gráfico de 10 bandas — MultimediaMX — GPL-3.0-or-later
import { S, persist } from '../main.js';
import { audio, PRESETS, EQ_LABELS, EQ_MIN, EQ_MAX } from '../core/audio.js';
import { t } from '../i18n/index.js';
import { icon } from './icons.js';
import { $, $$, esc, promptText, toast } from './dom.js';

const instances = new Set();

function eqState() { return S.settings.eq; }

function presetName(id) {
  if (PRESETS[id]) return t('preset_' + id);
  if (S.settings.customPresets[id]) return id;
  return t('preset_custom');
}

function apply(save = true) {
  audio.set({ ...eqState() });
  if (save) persist('settings');
  for (const inst of instances) inst.sync();
}

export function renderEq(root, { compact }) {
  const st = eqState();
  const presets = [...Object.keys(PRESETS), ...Object.keys(S.settings.customPresets)];
  root.innerHTML = `
    <div class="eq ${compact ? 'compact' : ''}">
      <div class="eq-top">
        <label class="switch"><input type="checkbox" class="eq-on" ${st.enabled ? 'checked' : ''}/><span></span>${t('eqEnabled')}</label>
        <div class="eq-presets">
          <select class="field sm eq-preset" aria-label="${t('preset')}">
            ${presets.map((p) => `<option value="${esc(p)}">${esc(presetName(p))}</option>`).join('')}
            <option value="custom" hidden>${t('preset_custom')}</option>
          </select>
          <button class="icon-btn sm eq-save" title="${t('savePreset')}">${icon('save', 17)}</button>
          <button class="icon-btn sm eq-reset" title="${t('reset')}">${icon('repeat', 17)}</button>
        </div>
      </div>
      <div class="eq-graph">
        <canvas class="eq-curve"></canvas>
        <div class="eq-bands">
          ${EQ_LABELS.map((l, i) => `
            <div class="band" data-b="${i}">
              <span class="db"></span>
              <div class="vslider" tabindex="0" role="slider" aria-label="${l} Hz" aria-valuemin="${EQ_MIN}" aria-valuemax="${EQ_MAX}"><div class="vtrack"><div class="vfill"></div></div><div class="vthumb"></div></div>
              <span class="hz">${l}</span>
            </div>`).join('')}
        </div>
      </div>
      <div class="eq-extra">
        <label class="hslider-row"><span>${t('preamp')}</span><input type="range" class="eq-pre" min="-12" max="12" step="0.5" /><output class="eq-pre-v"></output></label>
        <label class="hslider-row"><span>${t('balance')}</span><input type="range" class="eq-bal" min="-1" max="1" step="0.05" /><output class="eq-bal-v"></output></label>
      </div>
    </div>`;

  const el = root.firstElementChild;
  const canvas = $('.eq-curve', el);
  const inst = {
    sync() {
      const s = eqState();
      if (!el.isConnected) { instances.delete(inst); return; }
      el.classList.toggle('off', !s.enabled);
      $('.eq-on', el).checked = s.enabled;
      const sel = $('.eq-preset', el);
      sel.value = presets.includes(s.preset) ? s.preset : 'custom';
      $$('.band', el).forEach((b, i) => {
        const v = s.bands[i] || 0;
        const p = (v - EQ_MIN) / (EQ_MAX - EQ_MIN);
        $('.vthumb', b).style.bottom = `calc(${p * 100}% - 8px)`;
        const fill = $('.vfill', b);
        fill.style.bottom = v >= 0 ? '50%' : `${p * 100}%`;
        fill.style.height = `${Math.abs(p - 0.5) * 100}%`;
        $('.db', b).textContent = `${v > 0 ? '+' : ''}${v.toFixed(v % 1 ? 1 : 0)}`;
        $('.vslider', b).setAttribute('aria-valuenow', v);
      });
      const pre = $('.eq-pre', el); pre.value = s.preamp; $('.eq-pre-v', el).textContent = `${s.preamp > 0 ? '+' : ''}${s.preamp} dB`;
      pre.style.setProperty('--p', `${((s.preamp + 12) / 24) * 100}%`);
      const bal = $('.eq-bal', el); bal.value = s.balance || 0;
      const b = s.balance || 0;
      $('.eq-bal-v', el).textContent = Math.abs(b) < 0.03 ? 'C' : b < 0 ? `L ${Math.round(-b * 100)}` : `R ${Math.round(b * 100)}`;
      bal.style.setProperty('--p', `${((b + 1) / 2) * 100}%`);
      drawCurve(canvas, s);
    }
  };
  instances.add(inst);
  inst.sync();
  new ResizeObserver(() => drawCurve(canvas, eqState())).observe(canvas);

  $('.eq-on', el).onchange = (e) => { eqState().enabled = e.target.checked; apply(); };
  $('.eq-preset', el).onchange = (e) => {
    const id = e.target.value;
    const vals = PRESETS[id] || S.settings.customPresets[id];
    if (!vals) return;
    Object.assign(eqState(), { preset: id, bands: [...vals], enabled: true });
    apply();
  };
  $('.eq-reset', el).onclick = () => { Object.assign(eqState(), { preset: 'flat', bands: [...PRESETS.flat], preamp: 0, balance: 0 }); apply(); };
  $('.eq-save', el).onclick = async () => {
    const name = await promptText(t('presetName'), '', t('preset_custom'));
    if (!name) return;
    S.settings.customPresets[name] = [...eqState().bands];
    eqState().preset = name;
    persist('settings');
    renderAll();
    toast(`${t('savePreset')}: ${name}`);
  };
  $('.eq-pre', el).oninput = (e) => { eqState().preamp = +e.target.value; apply(); };
  $('.eq-bal', el).oninput = (e) => { eqState().balance = +e.target.value; apply(); };

  // deslizadores verticales propios
  $$('.band', el).forEach((band) => {
    const i = +band.dataset.b;
    const slider = $('.vslider', band);
    const setFrom = (clientY) => {
      const r = $('.vtrack', band).getBoundingClientRect();
      let p = 1 - (clientY - r.top) / r.height;
      p = Math.min(1, Math.max(0, p));
      let v = Math.round((EQ_MIN + p * (EQ_MAX - EQ_MIN)) * 2) / 2;
      if (Math.abs(v) < 0.5) v = 0;
      setBand(i, v);
    };
    slider.addEventListener('pointerdown', (e) => { slider.setPointerCapture(e.pointerId); setFrom(e.clientY); slider.classList.add('drag'); });
    slider.addEventListener('pointermove', (e) => { if (slider.hasPointerCapture(e.pointerId)) setFrom(e.clientY); });
    slider.addEventListener('pointerup', () => slider.classList.remove('drag'));
    slider.addEventListener('dblclick', () => setBand(i, 0));
    slider.addEventListener('wheel', (e) => { e.preventDefault(); setBand(i, (eqState().bands[i] || 0) + (e.deltaY < 0 ? 0.5 : -0.5)); }, { passive: false });
    slider.addEventListener('keydown', (e) => {
      const v = eqState().bands[i] || 0;
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); setBand(i, v + 0.5); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); setBand(i, v - 0.5); }
    });
  });
}

function setBand(i, v) {
  const s = eqState();
  s.bands[i] = Math.max(EQ_MIN, Math.min(EQ_MAX, v));
  s.preset = 'custom';
  s.enabled = true;
  apply();
}

function renderAll() {
  for (const inst of [...instances]) instances.delete(inst);
  const a = $('#eqPage'); if (a) renderEq(a, { compact: true });
  const b = $('#eqSettings'); if (b) renderEq(b, { compact: false });
}

// Curva suave (Catmull-Rom) a través de los puntos de cada banda
function drawCurve(canvas, s) {
  const dpr = devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  g.clearRect(0, 0, w, h);
  const css = getComputedStyle(canvas);
  const accent = css.getPropertyValue('--accent').trim() || '#8b5cf6';
  const accent2 = css.getPropertyValue('--accent-2').trim() || accent;
  const line = css.getPropertyValue('--line').trim() || 'rgba(255,255,255,.12)';
  // líneas guía
  g.strokeStyle = line; g.lineWidth = 1;
  for (const db of [-12, -6, 0, 6, 12]) {
    const y = h / 2 - (db / EQ_MAX) * (h / 2 - 6);
    g.setLineDash(db === 0 ? [] : [3, 4]);
    g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
  }
  g.setLineDash([]);
  const n = s.bands.length;
  const pts = s.bands.map((v, i) => [((i + 0.5) / n) * w, h / 2 - ((s.enabled ? v : 0) / EQ_MAX) * (h / 2 - 6)]);
  const all = [[0, pts[0][1]], ...pts, [w, pts[n - 1][1]]];
  const path = new Path2D();
  path.moveTo(all[0][0], all[0][1]);
  for (let i = 0; i < all.length - 1; i++) {
    const p0 = all[i - 1] || all[i], p1 = all[i], p2 = all[i + 1], p3 = all[i + 2] || p2;
    path.bezierCurveTo(p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6, p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1]);
  }
  const grad = g.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, accent); grad.addColorStop(1, accent2);
  const fill = new Path2D(path);
  fill.lineTo(w, h / 2); fill.lineTo(0, h / 2); fill.closePath();
  g.globalAlpha = 0.16; g.fillStyle = grad; g.fill(fill);
  g.globalAlpha = 1; g.strokeStyle = grad; g.lineWidth = 2.5; g.stroke(path);
}

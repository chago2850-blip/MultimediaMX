// Motor de audio: ecualizador de 10 bandas, preamplificador, balance y analizador
// MultimediaMX — Copyright (C) 2026 Santiago Miguel — GPL-3.0-or-later

export const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
export const EQ_LABELS = ['31', '62', '125', '250', '500', '1K', '2K', '4K', '8K', '16K'];
export const EQ_MIN = -12;
export const EQ_MAX = 12;

export const PRESETS = {
  flat:        [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  rock:        [5, 4, 3, 1, -1, -1, 1, 3, 4, 5],
  pop:         [-1, 1, 3, 4, 3, 0, -1, -1, 1, 2],
  jazz:        [3, 2, 1, 2, -1, -1, 0, 1, 2, 3],
  classical:   [4, 3, 2, 1, -1, -1, 0, 2, 3, 4],
  electronic:  [5, 4, 1, 0, -2, 2, 1, 1, 4, 5],
  hiphop:      [6, 5, 2, 3, -1, -1, 1, 0, 2, 3],
  bass:        [8, 6, 4, 2, 0, 0, 0, 0, 0, 0],
  treble:      [0, 0, 0, 0, 0, 1, 3, 5, 6, 7],
  vocal:       [-2, -3, -2, 1, 4, 4, 3, 1, 0, -2],
  acoustic:    [4, 4, 3, 1, 2, 2, 3, 3, 2, 1],
  latin:       [3, 2, 0, 0, -1, -1, -1, 0, 3, 4],
  loudness:    [6, 4, 0, 0, -2, 0, -1, -2, 4, 2],
  cinema:      [4, 3, 1, 0, -1, 1, 3, 3, 2, 1]
};

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.sources = new WeakMap();
    this.filters = [];
    this.state = { enabled: true, preamp: 0, bands: Array(10).fill(0), balance: 0 };
  }

  ensure() {
    if (this.ctx) return this.ctx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    const ctx = this.ctx = new Ctx({ latencyHint: 'playback' });
    this.input = ctx.createGain();
    this.pre = ctx.createGain();
    this.filters = EQ_FREQS.map((f, i) => {
      const b = ctx.createBiquadFilter();
      b.type = i === 0 ? 'lowshelf' : i === EQ_FREQS.length - 1 ? 'highshelf' : 'peaking';
      b.frequency.value = f;
      b.Q.value = 1.1;
      return b;
    });
    this.pan = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.8;
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.12;
    this.input.connect(this.pre);
    let node = this.pre;
    for (const f of this.filters) { node.connect(f); node = f; }
    node.connect(this.pan);
    this.pan.connect(this.limiter);
    this.limiter.connect(this.analyser);
    this.analyser.connect(ctx.destination);
    this.apply();
    return ctx;
  }

  /** Conecta un elemento <audio>/<video> al grafo (solo una vez por elemento). */
  attach(el) {
    if (!this.ensure()) return false;
    if (this.sources.has(el)) return true;
    try {
      const src = this.ctx.createMediaElementSource(el);
      src.connect(this.input);
      this.sources.set(el, src);
      return true;
    } catch {
      return false;
    }
  }

  resume() { if (this.ctx?.state === 'suspended') this.ctx.resume().catch(() => {}); }

  set(state) {
    Object.assign(this.state, state);
    this.apply();
  }

  apply() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const on = this.state.enabled;
    this.filters.forEach((f, i) => f.gain.setTargetAtTime(on ? this.state.bands[i] || 0 : 0, t, 0.02));
    // Reduce la ganancia previa cuando hay refuerzos, para evitar saturación
    const maxBoost = on ? Math.max(0, ...this.state.bands) : 0;
    const pre = (on ? this.state.preamp : 0) - maxBoost * 0.5;
    this.pre.gain.setTargetAtTime(Math.pow(10, pre / 20), t, 0.02);
    if (this.pan.pan) this.pan.pan.setTargetAtTime(this.state.balance || 0, t, 0.02);
  }

  /** Respuesta en frecuencia combinada (dB) para dibujar la curva. */
  response(freqs) {
    if (!this.ctx) return null;
    const f = new Float32Array(freqs);
    const total = new Float32Array(freqs.length);
    const mag = new Float32Array(freqs.length);
    const ph = new Float32Array(freqs.length);
    for (const b of this.filters) {
      b.getFrequencyResponse(f, mag, ph);
      for (let i = 0; i < mag.length; i++) total[i] += 20 * Math.log10(mag[i] || 1e-6);
    }
    return total;
  }

  spectrum(arr) {
    if (!this.analyser) return false;
    this.analyser.getByteFrequencyData(arr);
    return true;
  }
}

export const audio = new AudioEngine();

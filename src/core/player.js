// Motor de reproducción: cola, aleatorio, repetición, conversión al vuelo y búsqueda
// MultimediaMX — Copyright (C) 2026 Santiago Miguel — GPL-3.0-or-later
import { platform, kindOf } from './platform.js';
import { isUrl } from './m3u.js';
import { audio } from './audio.js';

export class Player extends EventTarget {
  constructor(el) {
    super();
    this.el = el;           // <video> único, conectado al ecualizador
    // segundo elemento para transmisiones sin CORS en Android/navegador (no pasa por el ecualizador)
    this.direct = document.createElement('video');
    this.direct.preload = 'auto';
    this.direct.playsInline = true;
    this.direct.className = 'direct';
    el.after(this.direct);
    this.active = el;
    this.queue = [];        // pistas
    this.order = [];        // índices de reproducción (aleatorio)
    this.pos = -1;
    this.track = null;
    this.offset = 0;        // inicio del segmento convertido
    this.duration = 0;
    this.tx = null;         // datos de conversión activa
    this.shuffle = false;
    this.repeat = 'off';
    this.loadToken = 0;
    this.volume = 0.8;
    this.muted = false;
    this.speed = 1;
    for (const m of [this.el, this.direct]) this.bind(m);
  }

  bind(m) {
    const fire = (type, detail) => { if (m === this.active) this.dispatchEvent(new CustomEvent(type, { detail })); };
    m.addEventListener('timeupdate', () => fire('time'));
    m.addEventListener('play', () => { audio.resume(); fire('state'); });
    m.addEventListener('pause', () => fire('state'));
    m.addEventListener('waiting', () => fire('buffering', true));
    m.addEventListener('playing', () => fire('buffering', false));
    m.addEventListener('loadedmetadata', () => {
      if (m !== this.active) return;
      if (!this.tx && Number.isFinite(m.duration)) this.duration = m.duration;
      fire('meta');
    });
    m.addEventListener('durationchange', () => { if (m === this.active && !this.tx && Number.isFinite(m.duration)) { this.duration = m.duration; fire('time'); } });
    m.addEventListener('ended', () => { if (m === this.active) this.onEnded(); });
    m.addEventListener('error', () => { if (m === this.active && m.getAttribute('src')) this.onError(); });
  }

  get currentTime() { return this.offset + (this.active.currentTime || 0); }
  get paused() { return this.active.paused; }
  get isVideo() { return this.track && this.kind === 'video'; }

  setQueue(tracks, startIndex = 0, { play = true } = {}) {
    this.queue = tracks.slice();
    this.buildOrder(startIndex);
    this.dispatchEvent(new Event('queue'));
    if (this.queue.length) return this.loadAt(this.pos, { play });
  }

  enqueue(tracks, { next = false } = {}) {
    const startLen = this.queue.length;
    this.queue.push(...tracks);
    const newIdx = tracks.map((_, i) => startLen + i);
    if (next && this.pos >= 0) this.order.splice(this.pos + 1, 0, ...newIdx);
    else this.order.push(...newIdx);
    this.dispatchEvent(new Event('queue'));
    if (!this.track) return this.loadAt(this.order.indexOf(startLen), { play: true });
  }

  removeFromQueue(qi) {
    const op = this.order.indexOf(qi);
    if (op < 0) return;
    const wasCurrent = op === this.pos;
    this.queue.splice(qi, 1);
    this.order.splice(op, 1);
    this.order = this.order.map((i) => (i > qi ? i - 1 : i));
    if (op < this.pos) this.pos--;
    this.dispatchEvent(new Event('queue'));
    if (wasCurrent) {
      if (this.order.length) this.loadAt(Math.min(this.pos, this.order.length - 1), { play: !this.paused });
      else this.stop();
    }
  }

  moveInQueue(fromOp, toOp) {
    const [x] = this.order.splice(fromOp, 1);
    this.order.splice(toOp, 0, x);
    if (this.pos === fromOp) this.pos = toOp;
    else if (fromOp < this.pos && toOp >= this.pos) this.pos--;
    else if (fromOp > this.pos && toOp <= this.pos) this.pos++;
    this.dispatchEvent(new Event('queue'));
  }

  clearQueue() { this.stop(); this.queue = []; this.order = []; this.pos = -1; this.dispatchEvent(new Event('queue')); }

  buildOrder(startIndex) {
    const n = this.queue.length;
    const idx = [...Array(n).keys()];
    if (this.shuffle) {
      idx.splice(startIndex, 1);
      for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
      idx.unshift(startIndex);
      this.order = n ? idx : [];
      this.pos = 0;
    } else {
      this.order = idx;
      this.pos = startIndex;
    }
  }

  setShuffle(v) {
    this.shuffle = v;
    if (!this.queue.length) return;
    const cur = this.order[this.pos] ?? 0;
    this.buildOrder(cur);
    if (!v) this.pos = cur;
    this.dispatchEvent(new Event('queue'));
  }

  playQueueIndex(qi) { const op = this.order.indexOf(qi); if (op >= 0) return this.loadAt(op, { play: true }); }

  async loadAt(op, { play = true, at = 0 } = {}) {
    if (op < 0 || op >= this.order.length) return;
    this.pos = op;
    const track = this.queue[this.order[op]];
    const token = ++this.loadToken;
    this.track = track;
    this.tx = null;
    this.offset = 0;
    this.duration = track.duration || 0;
    this.kind = track.kind || kindOf(track.src) || 'audio';
    this.fellBack = false;
    this.dispatchEvent(new CustomEvent('track', { detail: track }));
    this.dispatchEvent(new CustomEvent('buffering', { detail: true }));

    const remote = isUrl(track.src);
    let probe = null;
    if (!remote && platform.canTranscode) {
      probe = await platform.probe(track.src);
      if (token !== this.loadToken) return;
      if (probe?.ok) {
        if (probe.duration) { this.duration = probe.duration; if (!track.duration) track.duration = probe.duration; }
        this.kind = probe.video ? 'video' : 'audio';
      }
    }
    this.probe = probe;
    const decision = probe?.decision || { mode: 'native', audioOnly: this.kind !== 'video' };
    if (decision.mode === 'transcode') this.tx = { ...decision, audioTrack: 0 };

    // Android/navegador: las transmisiones remotas sin CORS se reproducen sin pasar por el ecualizador
    const useDirect = remote && !platform.canTranscode;
    await this.attachSource(useDirect ? this.direct : this.el, at, play, token);
    this.dispatchEvent(new CustomEvent('loaded', { detail: { track, probe } }));
  }

  async attachSource(media, at, play, token) {
    const track = this.track;
    if (this.active !== media) { this.active.pause(); this.active.removeAttribute('src'); this.active.load(); }
    this.active = media;
    this.el.classList.toggle('inactive', media !== this.el);
    this.direct.classList.toggle('inactive', media !== this.direct);
    if (media === this.el) audio.attach(this.el);
    const remote = isUrl(track.src);
    media.crossOrigin = remote && media === this.direct ? null : 'anonymous';
    let url;
    if (this.tx) {
      this.offset = at;
      url = await platform.sourceUrl({ input: track.src, transcode: true, ss: at, ...this.tx });
    } else {
      url = await platform.sourceUrl({ input: track.src, transcode: false });
    }
    if (token !== this.loadToken) return;
    if (!url) { this.dispatchEvent(new CustomEvent('error', { detail: 'missing' })); return; }
    media.src = url;
    media.volume = this.volume;
    media.muted = this.muted;
    media.playbackRate = this.speed;
    media.preservesPitch = true;
    if (!this.tx && at > 0) {
      const seekOnce = () => { media.currentTime = at; };
      media.addEventListener('loadedmetadata', seekOnce, { once: true });
    }
    if (play) media.play().catch((e) => { if (e?.name === 'NotAllowedError') this.dispatchEvent(new Event('state')); });
  }

  async onError() {
    const err = this.active.error;
    // Si falla lo nativo en escritorio, se reintenta convirtiendo con FFmpeg
    if (platform.canTranscode && !this.tx && !this.fellBack && this.track) {
      this.fellBack = true;
      this.tx = { mode: 'transcode', audioOnly: this.kind !== 'video', vcopy: false, acopy: false, audioTrack: 0 };
      const at = this.active.currentTime || 0;
      await this.attachSource(this.el, at, true, this.loadToken);
      return;
    }
    this.dispatchEvent(new CustomEvent('error', { detail: err?.code === 4 ? 'unsupported' : 'failed' }));
    // salta a la siguiente después de un momento
    setTimeout(() => { if (this.active.error && this.hasNext()) this.next(); }, 1800);
  }

  onEnded() {
    if (this.repeat === 'one') { this.seek(0); this.play(); return; }
    if (this.hasNext()) this.next();
    else if (this.repeat === 'all' && this.order.length) this.loadAt(0, { play: true });
    else this.dispatchEvent(new Event('state'));
  }

  hasNext() { return this.pos < this.order.length - 1; }
  play() { audio.resume(); if (!this.track && this.order.length) return this.loadAt(Math.max(0, this.pos)); return this.active.play().catch(() => {}); }
  pause() { this.active.pause(); }
  toggle() { return this.paused ? this.play() : this.pause(); }
  stop() { this.active.pause(); this.active.removeAttribute('src'); this.active.load(); this.track = null; this.tx = null; this.dispatchEvent(new CustomEvent('track', { detail: null })); }

  next() {
    if (this.hasNext()) return this.loadAt(this.pos + 1);
    if (this.repeat === 'all' && this.order.length) return this.loadAt(0);
  }

  prev() {
    if (this.currentTime > 4 || this.pos <= 0) return this.seek(0);
    return this.loadAt(this.pos - 1);
  }

  async seek(t) {
    if (!this.track) return;
    t = Math.max(0, Math.min(t, (this.duration || Infinity) - 0.25));
    if (this.tx) {
      const playing = !this.paused || this.active.ended;
      this.dispatchEvent(new CustomEvent('buffering', { detail: true }));
      await this.attachSource(this.el, t, playing, this.loadToken);
      this.dispatchEvent(new Event('time'));
    } else if (Number.isFinite(t)) {
      this.active.currentTime = t;
    }
  }

  async setAudioTrack(i) {
    if (!platform.canTranscode || !this.track) return;
    const at = this.currentTime;
    this.tx = { mode: 'transcode', audioOnly: this.kind !== 'video', vcopy: this.probe?.video?.codec === 'h264', acopy: false, audioTrack: i };
    await this.attachSource(this.el, at, true, this.loadToken);
  }

  setVolume(v) { this.volume = v; this.el.volume = v; this.direct.volume = v; }
  setMuted(m) { this.muted = m; this.el.muted = m; this.direct.muted = m; }
  setSpeed(s) { this.speed = s; this.el.playbackRate = s; this.direct.playbackRate = s; }
}

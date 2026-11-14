// Detección de códecs y conversión al vuelo con FFmpeg
// MultimediaMX — Copyright (C) 2026 Santiago Miguel — GPL-3.0-or-later
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);

export function ffmpegPath() {
  let p = null;
  try { p = require('ffmpeg-static'); } catch { /* sin binario empaquetado */ }
  if (p) p = p.replace('app.asar', 'app.asar.unpacked');
  if (p && fs.existsSync(p)) return p;
  return 'ffmpeg'; // el del sistema, si existe
}

export const AUDIO_EXT = ['mp3', 'flac', 'ogg', 'oga', 'opus', 'm4a', 'm4b', 'aac', 'wav', 'wma', 'ape', 'aif', 'aiff', 'aifc', 'alac', 'mka', 'ac3', 'eac3', 'dts', 'wv', 'tta', 'mpc', 'amr', 'au', 'snd', 'caf', 'spx', 'mp2', 'mid', 'midi', 'dsf', 'dff', 'weba'];
export const VIDEO_EXT = ['mp4', 'm4v', 'mkv', 'webm', 'avi', 'mov', 'qt', 'wmv', 'asf', 'flv', 'f4v', 'mpg', 'mpeg', 'mpe', 'm2v', 'ts', 'm2ts', 'mts', 'vob', '3gp', '3g2', 'ogv', 'rm', 'rmvb', 'divx', 'xvid', 'dv', 'mxf', 'nut', 'y4m', 'hevc', 'h264', 'h265'];
export const PLAYLIST_EXT = ['m3u', 'm3u8'];

export const extOf = (p) => (String(p).split(/[?#]/)[0].match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
export const isMediaFile = (p) => { const e = extOf(p); return AUDIO_EXT.includes(e) || VIDEO_EXT.includes(e); };

// Lo que Chromium/Electron decodifica sin ayuda
const NATIVE_CONTAINERS = ['mov,mp4,m4a,3gp,3g2,mj2', 'matroska,webm', 'ogg', 'mp3', 'wav', 'flac', 'aac'];
const NATIVE_VIDEO = ['h264', 'vp8', 'vp9', 'av1', 'theora'];
const NATIVE_AUDIO = ['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le', 'pcm_u8'];
if (process.platform === 'darwin' || process.platform === 'win32') NATIVE_VIDEO.push('hevc');

const probeCache = new Map();

/** Lee la información de un archivo o URL con `ffmpeg -i` (sin ffprobe). */
export function probe(input) {
  if (probeCache.has(input)) return Promise.resolve(probeCache.get(input));
  return new Promise((resolve) => {
    let err = '';
    let done = false;
    const proc = spawn(ffmpegPath(), ['-hide_banner', '-nostdin', '-i', input], { windowsHide: true });
    const finish = () => {
      if (done) return; done = true;
      const info = parseProbe(err);
      if (info.format) probeCache.set(input, info);
      resolve(info);
    };
    proc.stderr.on('data', (d) => { err += d; if (err.length > 200000) proc.kill(); });
    proc.on('error', () => resolve({ ok: false, error: 'ffmpeg-missing' }));
    proc.on('close', finish);
    setTimeout(() => { try { proc.kill(); } catch {} finish(); }, 15000);
  });
}

export function parseProbe(text) {
  const info = { ok: true, format: null, duration: null, video: null, audio: [], subtitles: [] };
  const fmt = text.match(/Input #0, (.+?), from/);
  if (fmt) info.format = fmt[1];
  const dur = text.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (dur) info.duration = (+dur[1]) * 3600 + (+dur[2]) * 60 + (+dur[3]);
  const re = /Stream #0:(\d+)(?:\[[^\]]*\])?(?:\(([^)]*)\))?: (Video|Audio|Subtitle): ([^\n]+)/g;
  let m;
  while ((m = re.exec(text))) {
    const [, index, lang, kind, rest] = m;
    const codec = rest.split(/[ ,(]/)[0];
    if (kind === 'Video') {
      if (/attached pic/.test(rest)) continue; // portada incrustada, no es video
      const size = rest.match(/, (\d{2,5})x(\d{2,5})/);
      if (!info.video) info.video = { index: +index, codec, width: size ? +size[1] : null, height: size ? +size[2] : null };
    } else if (kind === 'Audio') {
      const ch = rest.match(/(mono|stereo|5\.1|7\.1|\d+ channels)/);
      info.audio.push({ index: +index, codec, lang: lang || null, channels: ch ? ch[1] : null });
    } else {
      info.subtitles.push({ index: +index, codec, lang: lang || null, title: null });
    }
  }
  if (!info.format) info.ok = false;
  return info;
}

/**
 * Decide cómo reproducir: de forma nativa o convertido al vuelo.
 * @returns {{ mode:'native'|'transcode', vcopy?:boolean, acopy?:boolean, audioOnly:boolean }}
 */
export function decide(info) {
  const audioOnly = !info.video;
  const a = info.audio[0]?.codec || null;
  const v = info.video?.codec || null;
  const containerOk = NATIVE_CONTAINERS.includes(info.format);
  const vOk = !v || NATIVE_VIDEO.includes(v);
  const aOk = !a || NATIVE_AUDIO.includes(a);
  if (containerOk && vOk && aOk) return { mode: 'native', audioOnly };
  return { mode: 'transcode', audioOnly, vcopy: v === 'h264', acopy: a === 'aac' };
}

/** Construye los argumentos de FFmpeg para convertir a MP4 fragmentado (transmitible). */
export function transcodeArgs(input, { ss = 0, audioOnly = false, vcopy = false, acopy = false, audioTrack = 0 } = {}) {
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error'];
  if (ss > 0) args.push('-ss', String(ss));
  args.push('-i', input);
  if (audioOnly) {
    args.push('-vn', '-map', `0:a:${audioTrack}?`);
  } else {
    args.push('-map', '0:v:0', '-map', `0:a:${audioTrack}?`);
    if (vcopy) args.push('-c:v', 'copy');
    else args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2');
  }
  if (acopy) args.push('-c:a', 'copy');
  else args.push('-c:a', 'aac', '-b:a', audioOnly ? '320k' : '256k', '-ac', '2');
  args.push('-sn', '-dn', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', 'pipe:1');
  return args;
}

/** Extrae una pista de subtítulos de texto como WebVTT. */
export function extractSubtitle(input, streamIndex) {
  return new Promise((resolve) => {
    let out = '';
    const proc = spawn(ffmpegPath(), ['-hide_banner', '-nostdin', '-loglevel', 'error', '-i', input, '-map', `0:${streamIndex}`, '-f', 'webvtt', 'pipe:1'], { windowsHide: true });
    proc.stdout.on('data', (d) => { out += d; });
    proc.on('error', () => resolve(null));
    proc.on('close', (code) => resolve(code === 0 ? out : null));
  });
}

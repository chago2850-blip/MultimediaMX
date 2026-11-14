import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLRC, guessQuery, findLyrics, activeLine, parseSubs } from '../src/core/lyrics.js';

test('LRC con varias marcas, desfase y palabras', () => {
  const l = parseLRC('[ar:X]\n[offset:+500]\n[00:01.00][00:10.50]Hola <00:01.20>mundo\n[01:02.3]Adiós\nsin marca');
  assert.deepEqual(l.map((x) => [x.time, x.text]), [[0.5, 'Hola mundo'], [10, 'Hola mundo'], [61.8, 'Adiós']]);
  assert.equal(parseLRC('texto plano'), null);
  assert.equal(activeLine(l, 0.2), -1);
  assert.equal(activeLine(l, 11), 1);
});

test('limpia títulos de videos y separa artista', () => {
  assert.deepEqual(guessQuery({ src: '/v/01 - Maná - Rayando el Sol (Video Oficial) [HD].mp4' }), { artist: 'Maná', title: 'Rayando el Sol', album: '', duration: 0 });
  assert.equal(guessQuery({ title: 'Despacito (feat. Daddy Yankee)', artist: 'Luis Fonsi, Daddy Yankee' }).artist, 'Luis Fonsi');
  assert.equal(guessQuery({ title: 'Despacito (feat. Daddy Yankee)', artist: 'Luis Fonsi' }).title, 'Despacito');
});

test('busca en LRCLIB y prefiere letra sincronizada', async () => {
  const calls = [];
  const http = async (url) => {
    calls.push(url);
    if (url.includes('/api/get')) return { ok: false, status: 404, text: '{}' };
    if (url.includes('/api/search')) return { ok: true, status: 200, text: JSON.stringify([
      { plainLyrics: 'solo texto', duration: 200 },
      { syncedLyrics: '[00:01.00]uno\n[00:02.00]dos', plainLyrics: 'uno\ndos', duration: 181 }
    ]) };
    return { ok: false };
  };
  const r = await findLyrics({ title: 'Canción', artist: 'Artista', duration: 180 }, { http, online: true });
  assert.equal(r.source, 'LRCLIB');
  assert.equal(r.synced.length, 2);
  assert.ok(calls[0].startsWith('https://lrclib.net/api/get?'));
});

test('recurre a lyrics.ovh y respeta el modo sin conexión', async () => {
  const http = async (url) => url.includes('lyrics.ovh') ? { ok: true, text: JSON.stringify({ lyrics: 'linea 1\r\nlinea 2' }) } : { ok: true, text: '[]' };
  const r = await findLyrics({ title: 'B', artist: 'A' }, { http, online: true });
  assert.equal(r.source, 'lyrics.ovh');
  assert.equal(r.plain, 'linea 1\nlinea 2');
  const off = await findLyrics({ title: 'C', artist: 'A' }, { http, online: false });
  assert.equal(off, null);
  const lrc = await findLyrics({ title: 'C' }, { http, sidecarLrc: '[00:00.50]x', online: false });
  assert.equal(lrc.source, 'lrc');
});

test('subtítulos SRT y VTT', () => {
  const c = parseSubs('1\r\n00:00:01,000 --> 00:00:02,500\r\n<i>Hola</i>\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\n{\\an8}Arriba\r\n');
  assert.deepEqual(c.map((x) => [x.start, x.end, x.text]), [[1, 2.5, '<i>Hola</i>'], [3, 4, 'Arriba']]);
  const v = parseSubs('WEBVTT\n\n00:01.000 --> 00:02.000 align:middle\nVTT');
  assert.equal(v[0].text, 'VTT');
});

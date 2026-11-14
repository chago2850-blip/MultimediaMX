import test from 'node:test';
import assert from 'node:assert/strict';
import { parseM3U, writeM3U, isUrl } from '../src/core/m3u.js';

test('lee M3U extendida con atributos, comas y grupos', () => {
  const r = parseM3U('\uFEFF#EXTM3U\n#PLAYLIST:Mi lista\n#EXTINF:20,Artista - Título\na.mp3\n#EXTINF:-1 tvg-logo="x.png" group-title="Radio, FM",Radio, con coma\nhttp://x/s\nb.avi\n');
  assert.equal(r.name, 'Mi lista');
  assert.equal(r.items.length, 3);
  assert.deepEqual([r.items[0].artist, r.items[0].title, r.items[0].duration], ['Artista', 'Título', 20]);
  assert.equal(r.items[1].title, 'Radio, con coma');
  assert.equal(r.items[1].group, 'Radio, FM');
  assert.equal(r.items[1].duration, null);
  assert.equal(r.items[2].group, null);
  assert.equal(r.items[2].title, null);
});

test('lee M3U simple sin cabecera y con CRLF', () => {
  const r = parseM3U('C:\\Musica\\a.mp3\r\n\r\n/home/u/b.flac\r\n');
  assert.deepEqual(r.items.map((i) => i.location), ['C:\\Musica\\a.mp3', '/home/u/b.flac']);
});

test('escribe y vuelve a leer', () => {
  const txt = writeM3U('Fiesta', [{ location: 'x.mp3', artist: 'A', title: 'B', duration: 61.4 }, { location: 'http://r/s', title: 'Radio' }]);
  const r = parseM3U(txt);
  assert.equal(r.name, 'Fiesta');
  assert.equal(r.items[0].duration, 61);
  assert.equal(r.items[1].duration, null);
  assert.equal(r.items[1].title, 'Radio');
});

test('distingue URLs de rutas', () => {
  assert.ok(isUrl('https://a/b.mp3'));
  assert.ok(isUrl('rtsp://cam/1'));
  assert.ok(!isUrl('file:///a.mp3'));
  assert.ok(!isUrl('C:\\a.mp3'));
});

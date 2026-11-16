import test from 'node:test';
import assert from 'node:assert/strict';
import { expandRemoteLists, inspectUrl, remoteSteps, looksUnknown, needsInspection, isHlsText } from '../src/core/remote.js';

const LIST = '#EXTM3U\n#EXTINF:-1 tvg-logo="https://x/l.png" group-title="Noticias",Canal 1\nhttps://cdn.example/c1/index.m3u8\n#EXTINF:-1 group-title="Radio",Radio 1\nhttp://radio.example:8000/stream\n#EXTINF:-1,Relativo\n../vod/peli.mp4\n';

test('enlace corto (bit.ly) que redirige a una lista sin extensión se despliega', async () => {
  const peek = async (url) => {
    assert.equal(url, 'http://bit.ly/LISTA-1');
    return { ok: true, status: 200, contentType: 'application/octet-stream', finalUrl: 'https://panel.example/get.php?u=a&p=b', text: LIST };
  };
  const items = [{ src: 'http://bit.ly/LISTA-1', remote: true }];
  const n = await expandRemoteLists(items, peek);
  assert.equal(n, 1);
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((i) => i.title), ['Canal 1', 'Radio 1', 'Relativo']);
  assert.equal(items[0].hls, true);
  assert.equal(items[0].logo, 'https://x/l.png');
  assert.equal(items[1].kind, 'audio');
  assert.equal(items[2].src, 'https://panel.example/vod/peli.mp4'); // relativo a la URL final
  assert.ok(items.every((i) => i.checked));
});

test('distingue HLS, MPEG-TS y transmisiones binarias', async () => {
  const hls = await inspectUrl('http://a.example/x', async () => ({ ok: true, contentType: 'text/plain', text: '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\nseg1.ts\n' }));
  assert.equal(hls.type, 'hls');
  const ts = await inspectUrl('http://a.example/live/u/p/1', async () => ({ ok: true, contentType: 'video/mp2t', text: null, binary: true }));
  assert.equal(ts.type, 'ts');
  const radio = await inspectUrl('http://a.example/radio', async () => ({ ok: true, contentType: 'audio/mpeg', text: null, binary: true }));
  assert.equal(radio.type, 'media');
  assert.equal(await inspectUrl('http://a.example/caido', async () => ({ ok: false, status: 404 })), null);
});

test('una transmisión no se toma por lista y queda revisada', async () => {
  const items = [{ src: 'http://a.example/live/u/p/77', remote: true }];
  await expandRemoteLists(items, async () => ({ ok: true, contentType: 'video/mp2t', binary: true }));
  assert.equal(items.length, 1);
  assert.equal(items[0].ts, true);
  assert.equal(needsInspection(items[0]), false);
});

test('orden de métodos de reproducción', () => {
  assert.deepEqual(remoteSteps({ src: 'https://a/b/index.m3u8' }), ['hls', 'native']);
  assert.deepEqual(remoteSteps({ src: 'http://a/live/1.ts' }), ['mpegts', 'native', 'hls']);
  assert.deepEqual(remoteSteps({ src: 'http://a/radio.mp3' }), ['native']);
  assert.deepEqual(remoteSteps({ src: 'http://a/live/u/p/5' }), ['native', 'hls', 'mpegts']);
  assert.ok(looksUnknown('http://bit.ly/PREMIUM-x'));
  assert.ok(!looksUnknown('http://a/b.mp3'));
  assert.ok(isHlsText('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhi.m3u8'));
  assert.ok(!isHlsText(LIST));
});

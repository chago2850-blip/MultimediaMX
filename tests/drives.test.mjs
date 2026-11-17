import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findMedia, shouldSkipDir, listDrives, MIN_AUDIO_BYTES } from '../electron/drives.mjs';

test('se omiten carpetas del sistema en la raíz, pero no las del usuario', () => {
  assert.equal(shouldSkipDir('Windows', 0), true);
  assert.equal(shouldSkipDir('$RECYCLE.BIN', 0), true);
  assert.equal(shouldSkipDir('System Volume Information', 0), true);
  assert.equal(shouldSkipDir('.Trashes', 0), true);
  assert.equal(shouldSkipDir('node_modules', 5), true);
  assert.equal(shouldSkipDir('Música', 0), false);
  assert.equal(shouldSkipDir('Videos', 1), false);
  assert.equal(shouldSkipDir('system', 4), false); // «System» de un disco de música, dentro de carpetas del usuario
});

test('findMedia encuentra audio y video en subcarpetas y descarta sonidos diminutos', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-'));
  const big = Buffer.alloc(MIN_AUDIO_BYTES + 10);
  fs.mkdirSync(path.join(root, 'Música', 'Álbum'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Windows'), { recursive: true });
  fs.mkdirSync(path.join(root, '.oculta'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Música', 'Álbum', '01 Canción.mp3'), big);
  fs.writeFileSync(path.join(root, 'Música', 'clic.wav'), Buffer.alloc(100));
  fs.writeFileSync(path.join(root, 'película.mkv'), Buffer.alloc(10));
  fs.writeFileSync(path.join(root, 'notas.txt'), 'x');
  fs.writeFileSync(path.join(root, 'Windows', 'tada.mp3'), big);
  fs.writeFileSync(path.join(root, '.oculta', 'x.mp3'), big);
  let progress = 0;
  const found = await findMedia([root], { onProgress: (n) => { progress = n; } });
  assert.deepEqual(found.map((p) => path.relative(root, p)).sort(), [path.join('Música', 'Álbum', '01 Canción.mp3'), 'película.mkv'].sort());
  assert.equal(progress, 2);
  fs.rmSync(root, { recursive: true, force: true });
});

test('findMedia se puede cancelar', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-'));
  fs.writeFileSync(path.join(root, 'a.mp4'), 'x');
  const found = await findMedia([root], { signal: { cancelled: true } });
  assert.equal(found.length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('listDrives devuelve rutas existentes', () => {
  for (const d of listDrives()) {
    assert.ok(d.path && d.label);
    assert.ok(fs.existsSync(d.path));
  }
});

// Genera los iconos de escritorio y Android a partir de public/logo.svg
// MultimediaMX — GPL-3.0-or-later
import { Resvg } from '@resvg/resvg-js';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const svg = fs.readFileSync(path.join(root, 'public/logo.svg'), 'utf8');

const png = (size) => new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
const write = (p, buf) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf); };

// Linux + general
for (const s of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) write(path.join(root, `build/icons/${s}x${s}.png`), png(s));
write(path.join(root, 'build/icon.png'), png(1024));
write(path.join(root, 'public/icon-192.png'), png(192));
write(path.join(root, 'public/icon-512.png'), png(512));

// Windows .ico (entradas PNG embebidas)
{
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const imgs = sizes.map(png);
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((s, i) => {
    const e = 6 + i * 16;
    header.writeUInt8(s >= 256 ? 0 : s, e); header.writeUInt8(s >= 256 ? 0 : s, e + 1);
    header.writeUInt8(0, e + 2); header.writeUInt8(0, e + 3);
    header.writeUInt16LE(1, e + 4); header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(imgs[i].length, e + 8); header.writeUInt32LE(offset, e + 12);
    offset += imgs[i].length;
  });
  write(path.join(root, 'build/icon.ico'), Buffer.concat([header, ...imgs]));
}

// macOS .icns
{
  const types = [['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024], ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512]];
  const chunks = types.map(([t, s]) => {
    const data = png(s);
    const h = Buffer.alloc(8); h.write(t, 0, 'ascii'); h.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([h, data]);
  });
  const body = Buffer.concat(chunks);
  const h = Buffer.alloc(8); h.write('icns', 0, 'ascii'); h.writeUInt32BE(body.length + 8, 4);
  write(path.join(root, 'build/icon.icns'), Buffer.concat([h, body]));
}

// Android (si existe el proyecto)
const res = path.join(root, 'android/app/src/main/res');
if (fs.existsSync(res)) {
  const dens = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
  for (const [d, s] of Object.entries(dens)) {
    for (const name of ['ic_launcher.png', 'ic_launcher_round.png']) write(path.join(res, `mipmap-${d}`, name), png(s));
    // primer plano adaptable: el logo ocupa ~66% del lienzo de 108dp
    const fg = Math.round(s * 108 / 48);
    const inner = new Resvg(svg, { fitTo: { mode: 'width', value: Math.round(fg * 0.72) } }).render();
    const wrap = `<svg xmlns="http://www.w3.org/2000/svg" width="${fg}" height="${fg}"><image href="data:image/png;base64,${Buffer.from(inner.asPng()).toString('base64')}" x="${(fg - inner.width) / 2}" y="${(fg - inner.height) / 2}" width="${inner.width}" height="${inner.height}"/></svg>`;
    write(path.join(res, `mipmap-${d}`, 'ic_launcher_foreground.png'), new Resvg(wrap).render().asPng());
  }
  const bg = path.join(res, 'values/ic_launcher_background.xml');
  if (fs.existsSync(bg)) fs.writeFileSync(bg, '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#0A0818</color>\n</resources>\n');
}
// Pantallas de inicio de Android: logo centrado sobre fondo oscuro
if (fs.existsSync(res)) {
  for (const dir of fs.readdirSync(res)) {
    const f = path.join(res, dir, 'splash.png');
    if (!fs.existsSync(f)) continue;
    const buf = fs.readFileSync(f);
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    const size = Math.round(Math.min(w, h) * 0.32);
    const logo = Buffer.from(png(size)).toString('base64');
    const wrap = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#0b0a18"/><image href="data:image/png;base64,${logo}" x="${(w - size) / 2}" y="${(h - size) / 2}" width="${size}" height="${size}"/></svg>`;
    fs.writeFileSync(f, new Resvg(wrap).render().asPng());
  }
}
// Banner de Android TV / Google TV (320×180 dp → 640×360 px en xhdpi)
{
  const tvRes = path.join(root, 'android/app/src/tv/res/drawable-xhdpi');
  if (fs.existsSync(path.dirname(tvRes))) {
    const logo = Buffer.from(png(196)).toString('base64');
    const banner = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1b1640"/><stop offset="1" stop-color="#0a0818"/></linearGradient>
        <radialGradient id="r" cx="0.25" cy="0.5" r="0.6"><stop offset="0" stop-color="#8b5cf6" stop-opacity="0.45"/><stop offset="1" stop-color="#8b5cf6" stop-opacity="0"/></radialGradient>
        <linearGradient id="t" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#3ee6ff"/><stop offset="1" stop-color="#ff5e8a"/></linearGradient>
      </defs>
      <rect width="640" height="360" fill="url(#g)"/><rect width="640" height="360" fill="url(#r)"/>
      <image href="data:image/png;base64,${logo}" x="34" y="82" width="196" height="196"/>
      <text x="250" y="190" font-family="DejaVu Sans, Arial, sans-serif" font-size="40" font-weight="700" fill="#eeedff">Multimedia<tspan fill="url(#t)">MX</tspan></text>
      <text x="252" y="236" font-family="DejaVu Sans, Arial, sans-serif" font-size="26" fill="#9a97c6" letter-spacing="6">TV</text>
    </svg>`;
    fs.mkdirSync(tvRes, { recursive: true });
    fs.writeFileSync(path.join(tvRes, 'banner.png'), new Resvg(banner, { font: { loadSystemFonts: true } }).render().asPng());
  }
}
console.log('Iconos generados.');

// Genera le icone della PWA senza dipendenze: public/icon.svg e i PNG da 192 e 512 px, dallo stesso disegno.
// Disegno "Subway": cartello nero con il filo bianco e i tre bollini N · Y · C nei colori delle linee.
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const BG = '#111111';
const STRIPE = { y: 150, h: 12, color: '#ffffff' };
const R = 62;      // raggio dei bollini
const CY = 282;    // centro verticale dei bollini
const SW = 15;     // spessore del tratto delle lettere
// Ogni lettera è fatta di segmenti (x1, y1, x2, y2) o di un arco (cx, cy, r, da, a in gradi), relativi al centro del bollino.
const DOTS = [
  { cx: 124, fill: '#fccc0a', ink: '#111111', segs: [[-20, 31, -20, -31], [-20, -31, 20, 31], [20, 31, 20, -31]] },
  { cx: 256, fill: '#ee352e', ink: '#111111', segs: [[-22, -31, 0, 2], [22, -31, 0, 2], [0, 2, 0, 31]] },
  { cx: 388, fill: '#0039a6', ink: '#ffffff', arc: [3, 0, 27, 50, 310] },
];

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const rad = (deg) => (deg * Math.PI) / 180;
const arcEnds = ([cx, cy, r, a0, a1]) => [a0, a1].map((a) => [cx + r * Math.cos(rad(a)), cy + r * Math.sin(rad(a))]);

// ---------- SVG ----------
const svgLetter = (d) => {
  const attrs = `fill="none" stroke="${d.ink}" stroke-width="${SW}" stroke-linecap="round" stroke-linejoin="round"`;
  if (d.arc) {
    const [[x0, y0], [x1, y1]] = arcEnds(d.arc);
    const f = (n) => Number(n.toFixed(2));
    return `<path ${attrs} d="M${f(d.cx + x0)} ${f(CY + y0)}A${d.arc[2]} ${d.arc[2]} 0 1 1 ${f(d.cx + x1)} ${f(CY + y1)}"/>`;
  }
  return `<path ${attrs} d="${d.segs.map(([a, b, c, e]) => `M${d.cx + a} ${CY + b}L${d.cx + c} ${CY + e}`).join('')}"/>`;
};
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="${BG}"/><rect y="${STRIPE.y}" width="512" height="${STRIPE.h}" fill="${STRIPE.color}"/>${
  DOTS.map((d) => `<circle cx="${d.cx}" cy="${CY}" r="${R}" fill="${d.fill}"/>${svgLetter(d)}`).join('')}</svg>\n`;
fs.writeFileSync(path.join(__dirname, '..', 'public', 'icon.svg'), svg);

// ---------- PNG ----------
const distSeg = (px, py, [x1, y1, x2, y2]) => {
  const dx = x2 - x1, dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - x1 - t * dx, py - y1 - t * dy);
};
const inArc = (px, py, arc) => {
  const [cx, cy, r, a0, a1] = arc;
  const ang = ((Math.atan2(py - cy, px - cx) * 180) / Math.PI + 360) % 360;
  if (ang >= a0 && ang <= a1) return Math.abs(Math.hypot(px - cx, py - cy) - r) <= SW / 2;
  return arcEnds(arc).some(([ex, ey]) => Math.hypot(px - ex, py - ey) <= SW / 2);
};
// colore del punto (x, y) nel disegno a 512 px
function colorAt(x, y) {
  for (const d of DOTS) {
    const px = x - d.cx, py = y - CY;
    if (Math.hypot(px, py) > R) continue;
    const on = d.arc ? inArc(px, py, d.arc) : d.segs.some((s) => distSeg(px, py, s) <= SW / 2);
    return on ? d.ink : d.fill;
  }
  return y >= STRIPE.y && y < STRIPE.y + STRIPE.h ? STRIPE.color : BG;
}
const cache = new Map();
const rgbOf = (hex) => cache.get(hex) || (cache.set(hex, rgb(hex)), cache.get(hex));

const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(d.length);
  const body = Buffer.concat([Buffer.from(t), d]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, c]);
};
const SS = 4; // campioni per lato in ogni pixel, per bordi morbidi
for (const size of [192, 512]) {
  const k = 512 / size;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const sum = [0, 0, 0];
    for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) {
      const c = rgbOf(colorAt((x + (i + 0.5) / SS) * k, (y + (j + 0.5) / SS) * k));
      sum[0] += c[0]; sum[1] += c[1]; sum[2] += c[2];
    }
    raw.set(sum.map((v) => Math.round(v / (SS * SS))), y * (size * 3 + 1) + 1 + x * 3);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr.set([8, 2, 0, 0, 0], 8);
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  fs.writeFileSync(path.join(__dirname, '..', 'public', `icon-${size}.png`), png);
}
console.log('Icone rigenerate: public/icon.svg, icon-192.png, icon-512.png');

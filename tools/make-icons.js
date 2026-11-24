// Genera le icone PNG della PWA (stesso disegno di public/icon.svg) senza dipendenze.
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const RECTS = [[96, 250, 56, 150], [164, 190, 56, 210], [232, 150, 48, 250], [250, 96, 12, 60], [292, 220, 56, 180], [360, 270, 56, 130]];
const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(d.length);
  const body = Buffer.concat([Buffer.from(t), d]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, c]);
};
for (const size of [192, 512]) {
  const k = size / 512;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const on = RECTS.some(([rx, ry, w, h]) => x >= rx * k && x < (rx + w) * k && y >= ry * k && y < (ry + h) * k);
    raw.set(on ? [0xf5, 0xb8, 0x00] : [0x10, 0x1c, 0x36], y * (size * 3 + 1) + 1 + x * 3);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr.set([8, 2, 0, 0, 0], 8);
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  fs.writeFileSync(path.join(__dirname, '..', 'public', `icon-${size}.png`), png);
}

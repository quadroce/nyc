// Crea un foglio HTML con tutte le foto delle schede, per controllarle a vista.
// Uso: node tools/photo-sheet.js <file di uscita.html>
const fs = require('fs');
const path = require('path');
const seed = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'seed.json'), 'utf8'));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cells = seed.pois.filter((p) => p.photoUrl).map((p, i) => `<figure><img src="${esc(p.photoUrl)}" loading="eager"><figcaption>${i + 1}. ${esc(p.id.replace(/^p-/, ''))}<br>${esc(p.name)}</figcaption></figure>`).join('');
fs.writeFileSync(process.argv[2], `<!doctype html><meta charset="utf-8"><style>body{margin:8px;font:11px system-ui;display:grid;grid-template-columns:repeat(6,1fr);gap:6px}figure{margin:0}img{width:100%;height:110px;object-fit:cover;background:#ccc}figcaption{line-height:1.15}</style>${cells}`);

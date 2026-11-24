// Controlla data/seed.json prima della pubblicazione: se trova un errore esce con codice 1,
// così la pubblicazione si ferma e resta online la versione precedente.
// Uso: node tools/check-seed.js [--stamp]   (--stamp scrive anche data/build.json con la data di pubblicazione)
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'data', 'seed.json');
const errors = [];
let seed;
try { seed = JSON.parse(fs.readFileSync(file, 'utf8')); }
catch (e) { console.error(`data/seed.json non è un JSON valido: ${e.message}`); process.exit(1); }

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ENUM = {
  type: ['ritrovo', 'visita', 'pasto', 'spostamento'],
  status: ['prenotato', 'proposto', 'da_confermare', 'facoltativo'],
  audience: ['tutti', 'facoltativo', 'sottogruppo'],
  category: ['film', 'marvel', 'pop', 'curiosita', 'storia', 'natale', 'ragazzi'],
  linkType: ['set_verificato', 'ispirazione', 'ambientazione', 'luogo_storico', 'curiosita'],
};
const err = (where, msg) => errors.push(`${where}: ${msg}`);
const text = (o, k, where, max) => { if (o[k] != null && (typeof o[k] !== 'string' || o[k].length > max)) err(where, `"${k}" deve essere un testo di al massimo ${max} caratteri`); };
const coord = (o, where) => { for (const k of ['lat', 'lng']) if (o[k] != null && typeof o[k] !== 'number') err(where, `"${k}" deve essere un numero oppure null`); };

const t = seed.trip || {};
if (!DATE.test(t.start || '') || !DATE.test(t.end || '') || t.start > t.end) err('trip', 'servono "start" e "end" nel formato AAAA-MM-GG');
if (!t.hotel || !t.hotel.name || !t.hotel.address) err('trip.hotel', 'servono "name" e "address"');
if (!seed.config || !Array.isArray(seed.config.excludedTypes) || !Array.isArray(seed.config.foodFallback)) err('config', 'servono le liste "excludedTypes" e "foodFallback"');
if (!Array.isArray(seed.activities) || !Array.isArray(seed.pois)) err('seed', 'servono le liste "activities" e "pois"');

const ids = new Set();
for (const a of seed.activities || []) {
  const where = `attività "${a.id || a.title || '?'}"`;
  if (!a.id || !/^[\w-]{1,40}$/.test(a.id)) err(where, '"id" mancante o con caratteri non ammessi (solo lettere, cifre, - e _)');
  if (ids.has(a.id)) err(where, '"id" ripetuto');
  ids.add(a.id);
  if (!a.title) err(where, 'manca "title"');
  if (!DATE.test(a.date || '')) err(where, '"date" deve essere AAAA-MM-GG');
  else if (a.date < t.start || a.date > t.end) err(where, `"date" ${a.date} è fuori dal viaggio (${t.start} … ${t.end}): non comparirebbe in nessun giorno`);
  for (const k of ['time', 'endTime', 'meetTime']) if (a[k] && !TIME.test(a[k])) err(where, `"${k}" deve essere HH:MM (ora di New York) oppure vuoto`);
  for (const k of ['type', 'status', 'audience']) if (!ENUM[k].includes(a[k])) err(where, `"${k}" deve essere uno tra: ${ENUM[k].join(', ')}`);
  if (a.voucherUrl && !/^https:\/\/\S+$/.test(a.voucherUrl)) err(where, '"voucherUrl" deve iniziare con https://');
  text(a, 'title', where, 140); text(a, 'description', where, 2000); text(a, 'transportNote', where, 600); text(a, 'meetPlace', where, 200);
  coord(a, where);
}
const pids = new Set();
for (const p of seed.pois || []) {
  const where = `curiosità "${p.id || p.name || '?'}"`;
  if (!p.id || pids.has(p.id)) err(where, '"id" mancante o ripetuto');
  pids.add(p.id);
  if (!p.name) err(where, 'manca "name"');
  for (const k of ['category', 'linkType']) if (!ENUM[k].includes(p[k])) err(where, `"${k}" deve essere uno tra: ${ENUM[k].join(', ')}`);
  if (p.linkedActivityId && !ids.has(p.linkedActivityId)) err(where, `"linkedActivityId" punta a un'attività che non esiste: ${p.linkedActivityId}`);
  if (typeof p.published !== 'boolean') err(where, '"published" deve essere true o false');
  text(p, 'context', where, 2000);
  coord(p, where);
}

if (errors.length) {
  console.error(`data/seed.json ha ${errors.length} ${errors.length === 1 ? 'errore' : 'errori'}:\n- ` + errors.join('\n- '));
  process.exit(1);
}
console.log(`data/seed.json è valido: ${seed.activities.length} attività, ${seed.pois.length} curiosità.`);
if (process.argv.includes('--stamp')) {
  fs.writeFileSync(path.join(__dirname, '..', 'data', 'build.json'), JSON.stringify({ builtAt: new Date().toISOString() }));
}

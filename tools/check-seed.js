// Controlla data/seed.json prima della pubblicazione: se trova un errore esce con codice 1,
// così la pubblicazione si ferma e resta online la versione precedente.
// Uso: node tools/check-seed.js [--stamp]   (--stamp scrive anche data/build.json con la data di pubblicazione)
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'data', 'seed.json');

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ENUM = {
  type: ['ritrovo', 'visita', 'pasto', 'spostamento'],
  status: ['prenotato', 'proposto', 'da_confermare', 'facoltativo', 'annullato'],
  audience: ['tutti', 'facoltativo', 'sottogruppo'],
  category: ['film', 'marvel', 'pop', 'curiosita', 'storia', 'natale', 'ragazzi'],
  linkType: ['set_verificato', 'ispirazione', 'ambientazione', 'luogo_storico', 'curiosita'],
};
// Restituisce l'elenco degli errori (vuoto se il programma è valido). Lo usa anche il server prima di salvare su GitHub.
function validate(seed) {
const errors = [];
if (!seed || typeof seed !== 'object') return ['il programma deve essere un oggetto JSON'];
const err = (where, msg) => errors.push(`${where}: ${msg}`);
const text = (o, k, where, max) => { if (o[k] != null && (typeof o[k] !== 'string' || o[k].length > max)) err(where, `"${k}" deve essere un testo di al massimo ${max} caratteri`); };
const coord = (o, where) => { for (const k of ['lat', 'lng']) if (o[k] != null && typeof o[k] !== 'number') err(where, `"${k}" deve essere un numero oppure null`); };

const t = seed.trip || {};
if (!DATE.test(t.start || '') || !DATE.test(t.end || '') || t.start > t.end) err('trip', 'servono "start" e "end" nel formato AAAA-MM-GG');
if (!t.hotel || !t.hotel.name || !t.hotel.address) err('trip.hotel', 'servono "name" e "address"');
if (!seed.config || !Array.isArray(seed.config.excludedTypes) || !Array.isArray(seed.config.foodFallback)) err('config', 'servono le liste "excludedTypes" e "foodFallback"');
if (!Array.isArray(seed.activities) || !Array.isArray(seed.pois)) err('seed', 'servono le liste "activities" e "pois"');

// lista «Cosa portare»: gruppi con titolo e voci; l'id di ogni voce resta stabile perché le spunte sui telefoni lo usano come chiave
const packing = (seed.config || {}).packing;
if (packing != null) {
  if (!Array.isArray(packing)) err('config.packing', 'deve essere una lista di gruppi');
  else {
    const seen = new Set();
    for (const g of packing) {
      const where = `cosa portare, gruppo "${(g && g.title) || '?'}"`;
      if (!g || typeof g.title !== 'string' || !g.title || g.title.length > 60) { err(where, 'serve "title" (al massimo 60 caratteri)'); continue; }
      if (!Array.isArray(g.items)) { err(where, 'serve la lista "items"'); continue; }
      for (const it of g.items) {
        const w = `${where}, voce "${(it && (it.id || it.text)) || '?'}"`;
        if (!it || typeof it !== 'object') { err(w, 'ogni voce deve avere "id" e "text"'); continue; }
        if (!/^[a-z0-9-]{1,60}$/.test(it.id || '')) err(w, '"id" mancante o con caratteri non ammessi (solo minuscole, cifre e -)');
        else if (seen.has(it.id)) err(w, '"id" ripetuto');
        else seen.add(it.id);
        if (typeof it.text !== 'string' || !it.text || it.text.length > 140) err(w, 'serve "text" (al massimo 140 caratteri)');
        text(it, 'note', w, 400);
      }
    }
  }
}

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
  if (p.photoUrl && (!/^https:\/\/(upload|thumb)\.wikimedia\.org\//.test(p.photoUrl) || !p.photoCredit)) err(where, 'la foto deve venire da Wikimedia (upload o thumb.wikimedia.org) e avere "photoCredit" (autore e licenza)');
  coord(p, where);
}
return errors;
}
module.exports = { validate, ENUM };
if (require.main !== module) return;

let seed;
try { seed = JSON.parse(fs.readFileSync(file, 'utf8')); }
catch (e) { console.error(`data/seed.json non è un JSON valido: ${e.message}`); process.exit(1); }
const errors = validate(seed);
if (errors.length) {
  console.error(`data/seed.json ha ${errors.length} ${errors.length === 1 ? 'errore' : 'errori'}:\n- ` + errors.join('\n- '));
  process.exit(1);
}
console.log(`data/seed.json è valido: ${seed.activities.length} attività, ${seed.pois.length} curiosità.`);
if (process.argv.includes('--stamp')) {
  fs.writeFileSync(path.join(__dirname, '..', 'data', 'build.json'), JSON.stringify({ builtAt: new Date().toISOString() }));
}

'use strict';
// NYC in compagnia — server senza dipendenze (Node >= 20).
// Serve la PWA, custodisce il programma, verifica il codice admin e fa da proxy a Google Places.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* .env facoltativo */ }

const PUB = path.join(ROOT, 'public');
const DATA = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const PORT = Number(process.env.PORT) || 3000;
const PLACES_KEY = process.env.GOOGLE_PLACES_API_KEY || '';
const PLACES_DAILY_BUDGET = Number(process.env.PLACES_DAILY_BUDGET) || 150;
const SESSION_MS = (Number(process.env.ADMIN_SESSION_MINUTES) || 120) * 60 * 1000;
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

const F = {
  seed: path.join(ROOT, 'data', 'seed.json'),
  state: path.join(DATA, 'state.json'),
  snapshots: path.join(DATA, 'snapshots.json'),
  admins: path.join(DATA, 'admins.json'),
  usage: path.join(DATA, 'places-usage.json'),
};

// ---------- archiviazione ----------
const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
};
const clone = (v) => JSON.parse(JSON.stringify(v));

let state = readJson(F.state, null);
if (!state) {
  const seed = readJson(F.seed, null);
  if (!seed) { console.error('Manca data/seed.json'); process.exit(1); }
  state = { version: 1, updatedAt: new Date().toISOString(), changes: [], ...seed };
  writeJson(F.state, state);
}
let snapshots = readJson(F.snapshots, []);
let admins = readJson(F.admins, []);

// ---------- amministratori ----------
const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const hashCode = (code, salt) => crypto.scryptSync(normCode(code), Buffer.from(salt, 'hex'), 32).toString('hex');
const newCode = () => {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // senza caratteri ambigui
  const b = crypto.randomBytes(12);
  let s = '';
  for (let i = 0; i < 12; i++) s += abc[b[i] % abc.length] + (i % 4 === 3 && i < 11 ? '-' : '');
  return s;
};
const setAdmin = (name) => {
  const code = newCode();
  const salt = crypto.randomBytes(16).toString('hex');
  const rec = { name, salt, hash: hashCode(code, salt), createdAt: new Date().toISOString() };
  admins = admins.filter((a) => a.name.toLowerCase() !== name.toLowerCase()).concat(rec);
  writeJson(F.admins, admins);
  return code;
};
const findAdminByCode = (code) => {
  admins = readJson(F.admins, []); // riletto: i codici si aggiungono o revocano da riga di comando a server acceso
  let found = null;
  for (const a of admins) { // confronta sempre con tutti: tempo indipendente dall'esito
    const h = Buffer.from(hashCode(code, a.salt), 'hex');
    if (crypto.timingSafeEqual(h, Buffer.from(a.hash, 'hex'))) found = a;
  }
  return found;
};

// CLI: node server.js admin add|revoke|list [nome]
if (process.argv[2] === 'admin') {
  const [, , , cmd, ...rest] = process.argv;
  const name = rest.join(' ').trim();
  if (cmd === 'add' && name) {
    const code = setAdmin(name);
    console.log(`Codice amministratore per "${name}" (mostrato una sola volta, non viene salvato in chiaro):\n\n   ${code}\n`);
  } else if (cmd === 'revoke' && name) {
    const before = admins.length;
    admins = admins.filter((a) => a.name.toLowerCase() !== name.toLowerCase());
    writeJson(F.admins, admins);
    console.log(before === admins.length ? `Nessun amministratore "${name}".` : `Codice di "${name}" revocato. Le sue sessioni aperte smettono subito di funzionare.`);
  } else if (cmd === 'list') {
    console.log(admins.length ? admins.map((a) => `- ${a.name} (dal ${a.createdAt.slice(0, 10)})`).join('\n') : 'Nessun amministratore.');
  } else {
    console.log('Uso: node server.js admin add <nome> | revoke <nome> | list');
  }
  process.exit(0);
}

const sessions = new Map(); // token -> { name, exp }
const loginFails = new Map(); // ip -> [timestamps]
const FAIL_WINDOW = 15 * 60 * 1000;
const FAIL_MAX = 5;
const recentFails = (ip) => {
  const list = (loginFails.get(ip) || []).filter((t) => Date.now() - t < FAIL_WINDOW);
  loginFails.set(ip, list);
  return list;
};
const sessionOf = (req) => {
  const m = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '');
  if (!m) return null;
  const s = sessions.get(m[1]);
  if (!s) return null;
  admins = readJson(F.admins, admins);
  if (s.exp < Date.now() || !admins.some((a) => a.name === s.name)) { sessions.delete(m[1]); return null; }
  return { ...s, token: m[1] };
};

// ---------- validazione ----------
const ENUMS = {
  type: ['ritrovo', 'visita', 'pasto', 'spostamento'],
  status: ['prenotato', 'proposto', 'da_confermare', 'facoltativo'],
  audience: ['tutti', 'facoltativo', 'sottogruppo'],
  category: ['film', 'marvel', 'storia', 'natale', 'ragazzi'],
  linkType: ['set_verificato', 'ispirazione', 'ambientazione', 'luogo_storico'],
};
const SCHEMA = {
  activity: {
    title: { t: 'str', max: 140, req: true },
    date: { t: 'date', req: true },
    time: { t: 'time' }, endTime: { t: 'time' }, meetTime: { t: 'time' },
    meetPlace: { t: 'str', max: 200 },
    type: { t: 'enum', v: ENUMS.type, req: true },
    status: { t: 'enum', v: ENUMS.status, req: true },
    audience: { t: 'enum', v: ENUMS.audience, req: true },
    audienceNote: { t: 'str', max: 140 },
    placeName: { t: 'str', max: 140 }, address: { t: 'str', max: 200 },
    lat: { t: 'num', min: -90, max: 90 }, lng: { t: 'num', min: -180, max: 180 },
    coordsVerified: { t: 'bool' }, placeId: { t: 'str', max: 200 },
    description: { t: 'str', max: 2000 }, transportNote: { t: 'str', max: 600 },
    voucherUrl: { t: 'url' }, sourceRef: { t: 'str', max: 300 },
    order: { t: 'num', min: 0, max: 999 },
  },
  poi: {
    name: { t: 'str', max: 140, req: true },
    category: { t: 'enum', v: ENUMS.category, req: true },
    linkType: { t: 'enum', v: ENUMS.linkType, req: true },
    work: { t: 'str', max: 140 },
    address: { t: 'str', max: 200 }, zone: { t: 'str', max: 80 },
    lat: { t: 'num', min: -90, max: 90 }, lng: { t: 'num', min: -180, max: 180 },
    coordsVerified: { t: 'bool' }, placeId: { t: 'str', max: 200 },
    radius: { t: 'num', min: 50, max: 2000 },
    context: { t: 'str', max: 2000 }, note: { t: 'str', max: 600 },
    source: { t: 'str', max: 300 }, lastVerified: { t: 'date' },
    published: { t: 'bool' }, alertsEnabled: { t: 'bool' },
    linkedActivityId: { t: 'str', max: 40 },
  },
};
class Bad extends Error { constructor(msg, code = 400) { super(msg); this.code = code; } }

function clean(kind, input, partial) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Bad('Dati non validi.');
  const out = {};
  for (const [k, d] of Object.entries(SCHEMA[kind])) {
    if (!(k in input)) {
      if (!partial && d.req) throw new Bad(`Campo obbligatorio mancante: ${k}`);
      continue;
    }
    let v = input[k];
    const empty = v === null || v === undefined || v === '';
    if (empty) {
      if (d.req) throw new Bad(`Il campo ${k} non può essere vuoto.`);
      out[k] = d.t === 'num' ? null : d.t === 'bool' ? false : '';
      continue;
    }
    switch (d.t) {
      case 'str':
        if (typeof v !== 'string') throw new Bad(`Campo ${k} non valido.`);
        v = v.trim();
        if (v.length > d.max) throw new Bad(`Campo ${k} troppo lungo (max ${d.max}).`);
        break;
      case 'date':
        if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v + 'T00:00:00Z'))) throw new Bad(`Data non valida in ${k}.`);
        break;
      case 'time':
        if (typeof v !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw new Bad(`Orario non valido in ${k} (formato HH:MM).`);
        break;
      case 'enum':
        if (!d.v.includes(v)) throw new Bad(`Valore non ammesso in ${k}.`);
        break;
      case 'num':
        v = Number(v);
        if (!Number.isFinite(v) || v < d.min || v > d.max) throw new Bad(`Numero non valido in ${k}.`);
        break;
      case 'bool':
        v = v === true || v === 'true';
        break;
      case 'url':
        if (typeof v !== 'string' || v.length > 500 || !/^https:\/\/[^\s]+$/i.test(v.trim())) throw new Bad(`Il link in ${k} deve iniziare con https://`);
        v = v.trim();
        break;
    }
    out[k] = v;
  }
  return out;
}

function cleanConfig(input) {
  const out = {};
  if (!input || typeof input !== 'object') throw new Bad('Dati non validi.');
  if ('excludedTypes' in input) {
    if (!Array.isArray(input.excludedTypes) || input.excludedTypes.length > 40) throw new Bad('Lista cucine escluse non valida.');
    out.excludedTypes = [...new Set(input.excludedTypes.map((s) => String(s).trim().toLowerCase()).filter(Boolean))];
    if (out.excludedTypes.some((s) => !/^[a-z_]{3,60}$/.test(s))) throw new Bad('I tipi esclusi usano i nomi Google Places (es. italian_restaurant).');
  }
  if ('foodFallback' in input) {
    if (!Array.isArray(input.foodFallback) || input.foodFallback.length > 30) throw new Bad('Lista di emergenza non valida.');
    out.foodFallback = input.foodFallback.map((r) => ({
      name: String(r.name || '').trim().slice(0, 140),
      address: String(r.address || '').trim().slice(0, 200),
      note: String(r.note || '').trim().slice(0, 300),
    })).filter((r) => r.name);
  }
  if ('infoNotes' in input) {
    if (typeof input.infoNotes !== 'string' || input.infoNotes.length > 4000) throw new Bad('Note troppo lunghe.');
    out.infoNotes = input.infoNotes.trim();
  }
  return out;
}

// ---------- modifiche, cronologia, versioni ----------
function diffList(entity, before, after, schema) {
  const entries = [];
  const prev = new Map(before.map((x) => [x.id, x]));
  const next = new Map(after.map((x) => [x.id, x]));
  for (const [id, n] of next) {
    const p = prev.get(id);
    const title = n.title || n.name;
    if (!p) { entries.push({ entity, entityId: id, title, action: 'create', date: n.date, fields: [] }); continue; }
    const fields = [];
    for (const k of Object.keys(schema)) {
      const a = p[k] ?? '', b = n[k] ?? '';
      if (a !== b) fields.push({ f: k, before: a, after: b });
    }
    if (fields.length) entries.push({ entity, entityId: id, title, action: 'update', date: n.date, fields });
  }
  for (const [id, p] of prev) {
    if (!next.has(id)) entries.push({ entity, entityId: id, title: p.title || p.name, action: 'delete', date: p.date, fields: [] });
  }
  return entries;
}
function diffState(prev, next) {
  const entries = [
    ...diffList('activity', prev.activities, next.activities, SCHEMA.activity),
    ...diffList('poi', prev.pois, next.pois, SCHEMA.poi),
  ];
  const fields = [];
  for (const k of ['excludedTypes', 'foodFallback', 'infoNotes']) {
    const a = JSON.stringify(prev.config[k] ?? null), b = JSON.stringify(next.config[k] ?? null);
    if (a !== b) fields.push({ f: k, before: a, after: b });
  }
  if (fields.length) entries.push({ entity: 'config', entityId: 'config', title: 'Impostazioni', action: 'update', fields });
  return entries;
}
const editable = (s) => ({ activities: s.activities, pois: s.pois, config: s.config });

function mutate(author, fn) {
  const prev = clone(editable(state));
  const next = clone(prev);
  fn(next);
  const entries = diffState(prev, next);
  if (!entries.length) return false;
  const at = new Date().toISOString();
  const v = state.version + 1;
  for (const e of entries) {
    e.v = v; e.at = at; e.author = author;
    if (e.action !== 'delete' && e.entity !== 'config') {
      const item = (e.entity === 'activity' ? next.activities : next.pois).find((x) => x.id === e.entityId);
      if (item) item.updatedAt = at;
    }
  }
  snapshots.push({ version: state.version, at, data: prev });
  snapshots = snapshots.slice(-40);
  state = { ...state, ...next, version: v, updatedAt: at, changes: state.changes.concat(entries).slice(-300) };
  writeJson(F.snapshots, snapshots);
  writeJson(F.state, state);
  return true;
}

const publicData = (isAdmin) => ({
  version: state.version,
  updatedAt: state.updatedAt,
  trip: state.trip,
  activities: state.activities,
  pois: isAdmin ? state.pois : state.pois.filter((p) => p.published),
  config: state.config,
  // ai lettori servono solo i cambi di programma; le bozze POI restano riservate agli admin
  changes: (isAdmin ? state.changes : state.changes.filter((c) => c.entity === 'activity')).slice(-80),
  foodSearch: Boolean(PLACES_KEY),
});

// ---------- TrovaCibo (proxy Google Places, API "New") ----------
const FOOD_CATS = {
  tutte: ['american_restaurant', 'hamburger_restaurant', 'barbecue_restaurant', 'sandwich_shop', 'diner', 'deli', 'steak_house', 'fast_food_restaurant', 'breakfast_restaurant', 'mexican_restaurant'],
  diner: ['diner', 'american_restaurant', 'breakfast_restaurant'],
  burger: ['hamburger_restaurant'],
  bbq: ['barbecue_restaurant', 'steak_house'],
  sandwich: ['sandwich_shop', 'deli'],
  street: ['fast_food_restaurant', 'food_court'],
};
const PLACES_FIELDS = [
  'id', 'displayName', 'formattedAddress', 'location', 'primaryType', 'types', 'priceLevel',
  'currentOpeningHours.openNow', 'googleMapsUri', 'goodForChildren', 'goodForGroups', 'reservable', 'nationalPhoneNumber',
].map((f) => 'places.' + f).join(',');
const foodCache = new Map(); // solo in memoria e a breve durata: nessun archivio permanente di dati Google
const foodHits = new Map(); // ip -> [timestamps]

async function placesNearby(lat, lng, radius, includedTypes, excludedTypes) {
  const body = {
    includedTypes, excludedTypes, maxResultCount: 20, rankPreference: 'DISTANCE', languageCode: 'it',
    locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius } },
  };
  const res = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': PLACES_KEY, 'X-Goog-FieldMask': PLACES_FIELDS },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) { const e = new Error('places ' + res.status); e.status = res.status; throw e; }
  return (await res.json()).places || [];
}

async function foodSearch(q, ip) {
  if (!PLACES_KEY) throw new Bad('Ricerca ristoranti non configurata sul server.', 503);
  const lat = Number(q.get('lat')), lng = Number(q.get('lng'));
  const radius = Math.min(3000, Math.max(200, Number(q.get('radius')) || 600));
  const cat = FOOD_CATS[q.get('cat')] ? q.get('cat') : 'tutte';
  // solo area di New York: il server non è un proxy generico
  if (!(lat > 40.45 && lat < 41.0 && lng > -74.3 && lng < -73.65)) throw new Bad('La ricerca funziona solo nell\'area di New York.', 422);

  const hits = (foodHits.get(ip) || []).filter((t) => Date.now() - t < 60000);
  if (hits.length >= 8) throw new Bad('Troppe ricerche ravvicinate: riprova tra un minuto.', 429);
  hits.push(Date.now()); foodHits.set(ip, hits);

  const excluded = state.config.excludedTypes || [];
  const key = [lat.toFixed(3), lng.toFixed(3), radius, cat, excluded.join('+')].join('|');
  const hit = foodCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.payload;

  const today = new Date().toISOString().slice(0, 10);
  let usage = readJson(F.usage, { date: today, count: 0 });
  if (usage.date !== today) usage = { date: today, count: 0 };
  if (usage.count >= PLACES_DAILY_BUDGET) throw new Bad('Limite giornaliero di ricerche raggiunto. Usa le opzioni salvate dal gruppo.', 429);
  usage.count++; writeJson(F.usage, usage);

  let places;
  try {
    places = await placesNearby(lat, lng, radius, FOOD_CATS[cat], excluded);
  } catch (e) {
    if (e.status !== 400) throw new Bad('Google Places non risponde: riprova o usa le opzioni salvate.', 502);
    // un nome di tipo non riconosciuto invalida l'intera richiesta: riprova in forma minima e filtra qui
    usage.count++; writeJson(F.usage, usage);
    try { places = await placesNearby(lat, lng, radius, ['restaurant'], []); }
    catch { throw new Bad('Google Places ha rifiutato la richiesta: controlla chiave e tipi configurati.', 502); }
  }
  const results = places
    .filter((p) => !(p.types || []).some((t) => excluded.includes(t)))
    .map((p) => ({
      id: p.id, name: p.displayName?.text || '', address: p.formattedAddress || '',
      lat: p.location?.latitude, lng: p.location?.longitude,
      primaryType: p.primaryType || '', types: (p.types || []).slice(0, 12),
      priceLevel: p.priceLevel || '', openNow: p.currentOpeningHours?.openNow ?? null,
      mapsUri: p.googleMapsUri || '', goodForChildren: p.goodForChildren ?? null,
      goodForGroups: p.goodForGroups ?? null, reservable: p.reservable ?? null,
      phone: p.nationalPhoneNumber || '',
    }));
  const payload = { results, at: new Date().toISOString() };
  foodCache.set(key, { at: Date.now(), payload });
  if (foodCache.size > 200) foodCache.delete(foodCache.keys().next().value);
  return payload;
}

// ---------- HTTP ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};
const SEC = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};
const send = (res, code, body, headers = {}) => {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  const buf = isObj ? JSON.stringify(body) : body;
  res.writeHead(code, { ...SEC, 'Content-Type': isObj ? MIME['.json'] : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(buf);
};
const readBody = (req) => new Promise((resolve, reject) => {
  let size = 0; const chunks = [];
  req.on('data', (c) => { size += c.length; if (size > 64 * 1024) { reject(new Bad('Richiesta troppo grande.', 413)); req.destroy(); } else chunks.push(c); });
  req.on('end', () => {
    if (!chunks.length) return resolve({});
    try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Bad('JSON non valido.')); }
  });
  req.on('error', reject);
});
const ipOf = (req) => (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?';
const newId = (p) => p + '-' + crypto.randomBytes(4).toString('hex');

async function api(req, res, url) {
  const p = url.pathname;
  const m = req.method;
  const sess = sessionOf(req);
  const needAdmin = () => { if (!sess) throw new Bad('Sessione amministratore scaduta o assente.', 401); return sess; };

  if (m === 'GET' && p === '/api/data') return send(res, 200, { ...publicData(Boolean(sess)), admin: sess ? { name: sess.name, exp: sess.exp } : null });

  if (m === 'GET' && p === '/api/food') return send(res, 200, await foodSearch(url.searchParams, ipOf(req)));

  if (m === 'POST' && p === '/api/admin/login') {
    const ip = ipOf(req);
    const fails = recentFails(ip);
    if (fails.length >= FAIL_MAX) throw new Bad('Troppi tentativi: riprova tra 15 minuti.', 429);
    const { code } = await readBody(req);
    const a = normCode(code).length >= 8 ? findAdminByCode(code) : null;
    if (!a) { fails.push(Date.now()); throw new Bad('Codice non valido.', 401); }
    const token = crypto.randomBytes(32).toString('hex');
    const exp = Date.now() + SESSION_MS;
    sessions.set(token, { name: a.name, exp });
    return send(res, 200, { token, name: a.name, exp });
  }
  if (m === 'POST' && p === '/api/admin/logout') { if (sess) sessions.delete(sess.token); return send(res, 200, { ok: true }); }
  if (m === 'POST' && p === '/api/admin/rotate') {
    const s = needAdmin();
    const code = setAdmin(s.name);
    for (const [t, v] of sessions) if (v.name === s.name && t !== s.token) sessions.delete(t);
    return send(res, 200, { code });
  }
  if (m === 'GET' && p === '/api/admin/history') {
    needAdmin();
    return send(res, 200, { changes: state.changes.slice(-150), snapshots: snapshots.map((s) => s.version), admins: admins.map((a) => a.name) });
  }
  if (m === 'POST' && p === '/api/admin/restore') {
    const s = needAdmin();
    const { version } = await readBody(req);
    const snap = snapshots.find((x) => x.version === Number(version));
    if (!snap) throw new Bad('Versione non più disponibile nella cronologia.', 404);
    mutate(s.name, (next) => Object.assign(next, clone(snap.data)));
    return send(res, 200, { ok: true, version: state.version });
  }
  if (m === 'PUT' && p === '/api/config') {
    const s = needAdmin();
    const patch = cleanConfig(await readBody(req));
    mutate(s.name, (next) => Object.assign(next.config, patch));
    return send(res, 200, { ok: true, version: state.version });
  }

  const r = /^\/api\/(activities|pois)(?:\/([\w-]{1,40}))?$/.exec(p);
  if (r) {
    const s = needAdmin();
    const kind = r[1] === 'activities' ? 'activity' : 'poi';
    const id = r[2];
    if (m === 'POST' && !id) {
      const item = { id: newId(kind === 'activity' ? 'a' : 'p'), ...clean(kind, await readBody(req), false) };
      mutate(s.name, (next) => next[r[1]].push(item));
      return send(res, 201, { ok: true, id: item.id, version: state.version });
    }
    if (!id || !state[r[1]].some((x) => x.id === id)) throw new Bad('Elemento non trovato.', 404);
    if (m === 'PUT') {
      const patch = clean(kind, await readBody(req), true);
      mutate(s.name, (next) => Object.assign(next[r[1]].find((x) => x.id === id), patch));
      return send(res, 200, { ok: true, version: state.version });
    }
    if (m === 'DELETE') {
      mutate(s.name, (next) => {
        next[r[1]] = next[r[1]].filter((x) => x.id !== id);
        if (kind === 'activity') next.pois.forEach((x) => { if (x.linkedActivityId === id) x.linkedActivityId = ''; });
      });
      return send(res, 200, { ok: true, version: state.version });
    }
  }
  throw new Bad('Non trovato.', 404);
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUB, rel));
  if (!file.startsWith(PUB + path.sep)) return send(res, 403, 'Vietato');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Non trovato');
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { ...SEC, 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return send(res, 400, 'Richiesta non valida'); }
  if (url.pathname.startsWith('/api/')) {
    try { await api(req, res, url); }
    catch (e) {
      if (e instanceof Bad) return send(res, e.code, { error: e.message });
      console.error(e);
      send(res, 500, { error: 'Errore interno.' });
    }
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Metodo non ammesso');
  serveStatic(req, res, url);
});

server.listen(PORT, () => {
  console.log(`NYC in compagnia: http://localhost:${PORT}  (dati in ${DATA})`);
  if (!admins.length) console.log('Nessun amministratore configurato. Crea il primo con:  node server.js admin add Francesco');
  if (!PLACES_KEY) console.log('GOOGLE_PLACES_API_KEY assente: TrovaCibo mostra solo le opzioni salvate dal gruppo.');
});

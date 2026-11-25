'use strict';
// NYC in compagnia — server senza dipendenze (Node >= 20).
// Serve la PWA, custodisce il programma, verifica il codice admin e fa da proxy a Google Places.
// Archivio: Supabase (tabella chiave/valore) o Redis via REST se configurati; oppure GitHub (ogni salvataggio
// è un commit di data/seed.json, che fa ripartire la pubblicazione); altrimenti file in data/.
// Su un hosting senza disco scrivibile e senza archivio parte in sola lettura dal seed.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* .env facoltativo */ }

const SEED = require('./data/seed.json');
const { validate: validateSeed } = require('./tools/check-seed.js');
let BUILT_AT = null; // scritto da tools/check-seed.js durante la pubblicazione
try { BUILT_AT = require('./data/build.json').builtAt || null; } catch { /* in locale non c'è */ }
const DATA = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const PORT = Number(process.env.PORT) || 3000;
const PLACES_KEY = process.env.GOOGLE_PLACES_API_KEY || '';
const PLACES_DAILY_BUDGET = Number(process.env.PLACES_DAILY_BUDGET) || 150;
const SESSION_MS = (Number(process.env.ADMIN_SESSION_MINUTES) || 120) * 60 * 1000;
const TRUST_PROXY = process.env.TRUST_PROXY === '1' || Boolean(process.env.VERCEL);
const KV_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const KV_PREFIX = process.env.KV_PREFIX || 'nyc:';
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '';
const SB_TABLE = /^[a-z_][a-z0-9_]{0,62}$/.test(process.env.SUPABASE_TABLE || '') ? process.env.SUPABASE_TABLE : 'nyc_kv';
// GitHub come archivio: servono un token con permesso di scrittura sui contenuti del repository e il nome "proprietario/repo".
const GH_TOKEN = process.env.GITHUB_TOKEN || '';
const GH_REPO = /^[\w.-]+\/[\w.-]+$/.test(process.env.GITHUB_REPO || '') ? process.env.GITHUB_REPO : '';
const GH_BRANCH = /^[\w./-]{1,100}$/.test(process.env.GITHUB_BRANCH || '') ? process.env.GITHUB_BRANCH : 'main';
const GH_API = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
const GH_FILE = 'data/seed.json';
// PIN unico degli organizzatori: solo nelle variabili d'ambiente, mai nel repository.
const ADMIN_PIN = String(process.env.ADMIN_PIN || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const ADMIN_NAME = String(process.env.ADMIN_NAME || 'Organizzatori').trim().slice(0, 40) || 'Organizzatori';
const PIN_OK = ADMIN_PIN.length >= 6;

// File serviti: elenco esplicito, così ogni hosting li include nel pacchetto e non esistono percorsi arbitrari.
const STATIC = {
  '/index.html': path.join(__dirname, 'public', 'index.html'),
  '/app.js': path.join(__dirname, 'public', 'app.js'),
  '/styles.css': path.join(__dirname, 'public', 'styles.css'),
  '/sw.js': path.join(__dirname, 'public', 'sw.js'),
  '/manifest.webmanifest': path.join(__dirname, 'public', 'manifest.webmanifest'),
  '/icon.svg': path.join(__dirname, 'public', 'icon.svg'),
  '/icon-192.png': path.join(__dirname, 'public', 'icon-192.png'),
  '/icon-512.png': path.join(__dirname, 'public', 'icon-512.png'),
};

// ---------- archiviazione ----------
const clone = (v) => JSON.parse(JSON.stringify(v));
const fileOf = (key) => path.join(DATA, key + '.json');
let backend = SB_URL && SB_KEY ? 'supabase' : KV_URL && KV_TOKEN ? 'kv' : GH_TOKEN && GH_REPO ? 'github' : 'file'; // 'supabase' | 'kv' | 'github' | 'file' | 'memory' (sola lettura)
const backendName = () => ({ supabase: `Supabase, tabella ${SB_TABLE}`, kv: 'Redis', github: `GitHub, ${GH_REPO} (${GH_BRANCH})`, file: DATA, memory: 'nessuno (sola lettura)' }[backend]);
// Con 'memory' e 'github' il programma che tutti leggono è il seed pubblicato; il resto (tentativi falliti, consumi) vive solo in memoria.
const fromSeed = () => backend === 'memory' || backend === 'github';
const memory = new Map();

async function kv(cmd) {
  const res = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
    signal: AbortSignal.timeout(8000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(`Archivio Redis: ${json.error || res.status}`);
  return json.result;
}
// Supabase: una riga per chiave nella tabella SB_TABLE (vedi supabase/schema.sql), letta e scritta via REST con la chiave di servizio.
async function sb(method, query, body) {
  const res = await fetch(`${SB_URL}/rest/v1/${SB_TABLE}${query}`, {
    method,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Archivio Supabase: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return method === 'GET' ? res.json() : null;
}
const store = {
  async get(key, fallback) {
    if (backend === 'supabase') { const rows = await sb('GET', `?key=eq.${encodeURIComponent(key)}&select=value`); return rows.length ? rows[0].value : fallback; }
    if (backend === 'kv') { const v = await kv(['GET', KV_PREFIX + key]); return v == null ? fallback : JSON.parse(v); }
    if (fromSeed()) return memory.has(key) ? memory.get(key) : fallback;
    try { return JSON.parse(fs.readFileSync(fileOf(key), 'utf8')); } catch { return fallback; }
  },
  async set(key, value) {
    if (backend === 'supabase') return void await sb('POST', '?on_conflict=key', { key, value, updated_at: new Date().toISOString() });
    if (backend === 'kv') return void await kv(['SET', KV_PREFIX + key, JSON.stringify(value)]);
    if (fromSeed()) return void memory.set(key, value);
    fs.mkdirSync(DATA, { recursive: true });
    const tmp = fileOf(key) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, fileOf(key));
  },
};
const readOnly = () => backend === 'memory';

let state = null;
let stateAt = 0;
let secret = '';
let ready = null;
function init() {
  return ready ||= (async () => {
    if (backend === 'file') {
      try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(path.join(DATA, '.probe'), ''); fs.unlinkSync(path.join(DATA, '.probe')); }
      catch { backend = 'memory'; console.log('Disco non scrivibile e nessun archivio Redis configurato: avvio in sola lettura dal seed.'); }
    }
    await loadState(true);
    // con GitHub non c'è dove salvare una chiave: si ricava dal token, che è già un segreto del server
    secret = process.env.SESSION_SECRET || (backend === 'github' ? crypto.createHmac('sha256', GH_TOKEN).update('nyc-session').digest('hex') : await store.get('secret', ''));
    if (!secret) { secret = crypto.randomBytes(32).toString('hex'); await store.set('secret', secret); }
  })().catch((e) => { ready = null; throw e; });
}
// Ogni istanza rilegge l'archivio (al più ogni 3 secondi): su un hosting serverless le istanze sono tante e senza memoria comune.
async function loadState(fresh) {
  if (!fresh && state && Date.now() - stateAt < 3000) return state;
  let s = await store.get('state', null);
  if (!s) {
    // senza archivio il programma è il file pubblicato: vale la data di pubblicazione, non quella di avvio dell'istanza
    s = { version: 1, updatedAt: fromSeed() ? BUILT_AT : new Date().toISOString(), changes: [], ...clone(SEED) };
    await store.set('state', s);
  }
  state = s; stateAt = Date.now();
  return state;
}

// ---------- archivio GitHub ----------
// Chi legge il sito vede il seed pubblicato. L'admin invece legge e scrive il file sul ramo: così vede subito
// ciò che ha salvato, anche nel minuto in cui la nuova pubblicazione è ancora in corso.
const ghProblem = (status) => status === 401 || status === 403 ? 'GitHub ha rifiutato il token: è scaduto o non ha il permesso di scrittura sul repository.'
  : status === 404 ? 'Repository, ramo o file non trovato su GitHub: controlla GITHUB_REPO e GITHUB_BRANCH.'
  : `GitHub non ha risposto come previsto (${status}). Riprova tra poco.`;
async function gh(method, rest, body, accept) {
  try {
    return await fetch(`${GH_API}/repos/${GH_REPO}/${rest}`, {
      method,
      headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: accept || 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'nyc-in-compagnia', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
  } catch { throw new Bad('GitHub non è raggiungibile in questo momento. Riprova tra poco.', 502); }
}
const blobSha = (buf) => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
const SEED_TEXT = JSON.stringify(SEED);
let ghCache = null; // { at, sha, seed }
async function ghLoad(fresh) {
  if (!fresh && ghCache && Date.now() - ghCache.at < 3000) return ghCache;
  const res = await gh('GET', `contents/${GH_FILE}?ref=${encodeURIComponent(GH_BRANCH)}`, null, 'application/vnd.github.raw+json');
  if (!res.ok) throw new Bad(ghProblem(res.status), 502);
  const buf = Buffer.from(await res.arrayBuffer());
  let seed;
  try { seed = JSON.parse(buf.toString('utf8')); } catch { throw new Bad('Il programma su GitHub non è un JSON valido: va corretto a mano nel repository.', 502); }
  const errors = validateSeed(seed);
  if (errors.length) throw new Bad(`Il programma su GitHub ha un errore da correggere a mano nel repository: ${errors[0]}`, 502);
  return ghCache = { at: Date.now(), sha: blobSha(buf), seed };
}
// Lo stato come lo vede l'admin, con "pending" finché il sito pubblicato non coincide con il file sul ramo.
const ghView = (c) => ({ state: { version: 1, updatedAt: BUILT_AT, changes: [], ...c.seed }, rev: c.sha.slice(0, 12), pending: JSON.stringify(c.seed) !== SEED_TEXT });
function commitMessage(entries) {
  const verb = { create: 'aggiunta', update: 'modificata', delete: 'eliminata' };
  const e = entries[0];
  const what = e.entity === 'config' ? 'impostazioni' : `${verb[e.action]} «${String(e.title || '').slice(0, 80)}»`;
  return `Admin: ${what}${entries.length > 1 ? ` e altre ${entries.length - 1} modifiche` : ''}`;
}
async function mutateGithub(fn) {
  for (let attempt = 0; ; attempt++) {
    const cur = await ghLoad(true);
    const prev = clone(editable(cur.seed));
    const next = clone(prev);
    fn(next);
    const entries = diffState(prev, next);
    if (!entries.length) return false;
    stamp(entries, next, new Date().toISOString());
    const seed = { ...cur.seed, ...next };
    // stesso controllo che fa la pubblicazione: un file sbagliato fermerebbe il deploy, quindi non viene nemmeno salvato
    const errors = validateSeed(seed);
    if (errors.length) throw new Bad(`Modifica non salvata: ${errors[0]}`);
    const buf = Buffer.from(JSON.stringify(seed, null, 2) + '\n', 'utf8');
    const res = await gh('PUT', `contents/${GH_FILE}`, { message: commitMessage(entries), content: buf.toString('base64'), sha: cur.sha, branch: GH_BRANCH });
    if (res.status === 409 && attempt === 0) continue; // il file è cambiato nel frattempo: si rilegge e si riapplica una volta
    if (res.status === 409) throw new Bad('Il programma è stato modificato da qualcun altro proprio ora: riprova.', 409);
    if (!res.ok) throw new Bad(ghProblem(res.status), 502);
    ghCache = { at: Date.now(), sha: blobSha(buf), seed };
    return true;
  }
}

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
const getAdmins = () => store.get('admins', []);
async function setAdmin(name) {
  const code = newCode();
  const salt = crypto.randomBytes(16).toString('hex');
  const rec = { name, salt, hash: hashCode(code, salt), createdAt: new Date().toISOString() };
  const admins = (await getAdmins()).filter((a) => a.name.toLowerCase() !== name.toLowerCase()).concat(rec);
  await store.set('admins', admins);
  return { code, rec };
}
async function findAdminByCode(code) {
  let found = null;
  for (const a of await getAdmins()) { // confronta sempre con tutti: tempo indipendente dall'esito
    const h = Buffer.from(hashCode(code, a.salt), 'hex');
    if (crypto.timingSafeEqual(h, Buffer.from(a.hash, 'hex'))) found = a;
  }
  return found;
}
// PIN unico: nessun archivio, vale ciò che c'è in ADMIN_PIN. L'impronta lega le sessioni al PIN: se cambia, decadono.
const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest();
const pinAdmin = () => (PIN_OK ? { name: ADMIN_NAME, pin: true, hash: crypto.createHmac('sha256', secret).update('pin:' + ADMIN_PIN).digest('hex') } : null);
const isPin = (code) => PIN_OK && crypto.timingSafeEqual(sha256(normCode(code)), sha256(ADMIN_PIN));

// Sessione = gettone firmato (nessuna memoria sul server). Decade alla scadenza, o se il codice viene cambiato o revocato.
const sign = (body) => crypto.createHmac('sha256', secret).update(body).digest('hex');
function newSession(a) {
  const exp = Date.now() + SESSION_MS;
  const body = Buffer.from(JSON.stringify({ n: a.name, e: exp, f: a.hash.slice(0, 16) })).toString('base64url');
  return { token: `${body}.${sign(body)}`, name: a.name, exp };
}
async function sessionOf(req) {
  const m = /^Bearer ([\w-]{10,400})\.([a-f0-9]{64})$/.exec(req.headers.authorization || '');
  if (!m || !crypto.timingSafeEqual(Buffer.from(sign(m[1])), Buffer.from(m[2]))) return null;
  let p;
  try { p = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')); } catch { return null; }
  if (!(p.e > Date.now())) return null;
  const pa = pinAdmin();
  if (pa && p.n === pa.name && p.f === pa.hash.slice(0, 16)) return { name: pa.name, exp: p.e, pin: true };
  const a = (await getAdmins()).find((x) => x.name === p.n && x.hash.slice(0, 16) === p.f);
  return a ? { name: a.name, exp: p.e } : null;
}

const FAIL_WINDOW = 15 * 60 * 1000;
const FAIL_MAX = 5;
async function recentFails(ip) {
  const all = await store.get('fails', {});
  for (const k of Object.keys(all)) { all[k] = all[k].filter((t) => Date.now() - t < FAIL_WINDOW); if (!all[k].length) delete all[k]; }
  return { all, list: all[ip] || [] };
}

// ---------- validazione ----------
const ENUMS = {
  type: ['ritrovo', 'visita', 'pasto', 'spostamento'],
  status: ['prenotato', 'proposto', 'da_confermare', 'facoltativo', 'annullato'],
  audience: ['tutti', 'facoltativo', 'sottogruppo'],
  category: ['film', 'marvel', 'pop', 'curiosita', 'storia', 'natale', 'ragazzi'],
  linkType: ['set_verificato', 'ispirazione', 'ambientazione', 'luogo_storico', 'curiosita'],
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
    videoQuery: { t: 'str', max: 140 },
    photoUrl: { t: 'url' }, photoCredit: { t: 'str', max: 200 }, photoPage: { t: 'url' },
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
  if ('packing' in input) {
    if (!Array.isArray(input.packing) || input.packing.length > 20) throw new Bad('Lista «Cosa portare» non valida.');
    const used = new Set();
    out.packing = input.packing.map((g) => ({
      title: String((g && g.title) || '').trim().slice(0, 60),
      items: (Array.isArray(g && g.items) ? g.items : []).slice(0, 60).map((it) => {
        const text = String((it && it.text) || '').trim().slice(0, 140);
        if (!text) return null;
        // l'id nasce dal testo: finché la voce non cambia, le spunte già messe sui telefoni restano
        let id = /^[a-z0-9-]{1,60}$/.test((it && it.id) || '') ? it.id
          : (text.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'voce');
        for (let n = 2; used.has(id); n++) id = id.replace(/-\d+$/, '').slice(0, 50) + '-' + n;
        used.add(id);
        const note = String((it && it.note) || '').trim().slice(0, 400);
        return note ? { id, text, note } : { id, text };
      }).filter(Boolean),
    })).filter((g) => g.title && g.items.length);
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
  for (const k of ['excludedTypes', 'foodFallback', 'infoNotes', 'packing']) {
    const a = JSON.stringify(prev.config[k] ?? null), b = JSON.stringify(next.config[k] ?? null);
    if (a !== b) fields.push({ f: k, before: a, after: b });
  }
  if (fields.length) entries.push({ entity: 'config', entityId: 'config', title: 'Impostazioni', action: 'update', fields });
  return entries;
}
const editable = (s) => ({ activities: s.activities, pois: s.pois, config: s.config });

function stamp(entries, next, at) {
  for (const e of entries) {
    if (e.action === 'delete' || e.entity === 'config') continue;
    const item = (e.entity === 'activity' ? next.activities : next.pois).find((x) => x.id === e.entityId);
    if (item) item.updatedAt = at;
  }
}
async function mutate(author, fn) {
  if (backend === 'github') return mutateGithub(fn);
  await loadState(true); // sempre dall'archivio: un altro admin (o un'altra istanza) può aver appena salvato
  const prev = clone(editable(state));
  const next = clone(prev);
  fn(next);
  const entries = diffState(prev, next);
  if (!entries.length) return false;
  const at = new Date().toISOString();
  const v = state.version + 1;
  for (const e of entries) { e.v = v; e.at = at; e.author = author; }
  stamp(entries, next, at);
  const snapshots = (await store.get('snapshots', [])).concat({ version: state.version, at, data: prev }).slice(-40);
  const saved = { ...state, ...next, version: v, updatedAt: at, changes: state.changes.concat(entries).slice(-300) };
  await store.set('snapshots', snapshots);
  await store.set('state', saved);
  state = saved; stateAt = Date.now();
  return true;
}

const publicData = (s, isAdmin) => ({
  version: s.version,
  updatedAt: s.updatedAt,
  trip: s.trip,
  activities: s.activities,
  pois: isAdmin ? s.pois : s.pois.filter((p) => p.published),
  config: s.config,
  // ai lettori servono solo i cambi di programma; le bozze POI restano riservate agli admin
  changes: (isAdmin ? s.changes : s.changes.filter((c) => c.entity === 'activity')).slice(-80),
  foodSearch: Boolean(PLACES_KEY),
  readOnly: fromSeed(), // il programma è il file pubblicato: i cambi «prima → dopo» li calcola il telefono
  canLogin: !readOnly(),
});

// ---------- TrovaCibo (proxy Google Places, API "New") ----------
// Aree consentite: il server non è un proxy generico, accetta solo coordinate dentro questi riquadri.
const FOOD_AREAS = [
  { id: 'nyc', name: 'New York', box: { latMin: 40.45, latMax: 41.0, lngMin: -74.3, lngMax: -73.65 }, useExcluded: true },
  { id: 'milano', name: 'Milano', box: { latMin: 45.35, latMax: 45.58, lngMin: 9.05, lngMax: 9.30 }, useExcluded: false },
];
const areaOf = (lat, lng) => FOOD_AREAS.find(({ box: b }) => lat > b.latMin && lat < b.latMax && lng > b.lngMin && lng < b.lngMax);
const FOOD_CATS_BY_AREA = {
  nyc: {
    tutte: ['american_restaurant', 'hamburger_restaurant', 'barbecue_restaurant', 'sandwich_shop', 'diner', 'deli', 'steak_house', 'fast_food_restaurant', 'breakfast_restaurant', 'mexican_restaurant'],
    diner: ['diner', 'american_restaurant', 'breakfast_restaurant'],
    burger: ['hamburger_restaurant'],
    bbq: ['barbecue_restaurant', 'steak_house'],
    sandwich: ['sandwich_shop', 'deli'],
    street: ['fast_food_restaurant', 'food_court'],
  },
  milano: {
    tutte: ['italian_restaurant', 'pizza_restaurant', 'hamburger_restaurant', 'sandwich_shop', 'deli', 'steak_house', 'fast_food_restaurant', 'breakfast_restaurant', 'bakery'],
    italiana: ['italian_restaurant'],
    pizza: ['pizza_restaurant'],
    burger: ['hamburger_restaurant'],
    sandwich: ['sandwich_shop', 'deli'],
    street: ['fast_food_restaurant', 'food_court'],
  },
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
  // solo aree consentite (New York, Milano): il server non è un proxy generico
  const area = areaOf(lat, lng);
  if (!area) throw new Bad('La ricerca funziona solo a New York e a Milano.', 422);
  const cats = FOOD_CATS_BY_AREA[area.id];
  const cat = cats[q.get('cat')] ? q.get('cat') : 'tutte';

  const hits = (foodHits.get(ip) || []).filter((t) => Date.now() - t < 60000);
  if (hits.length >= 8) throw new Bad('Troppe ricerche ravvicinate: riprova tra un minuto.', 429);
  hits.push(Date.now()); foodHits.set(ip, hits);

  const excluded = area.useExcluded ? state.config.excludedTypes || [] : []; // le cucine escluse valgono per New York: a Milano l'italiano è il punto
  const key = [area.id, lat.toFixed(3), lng.toFixed(3), radius, cat, excluded.join('+')].join('|');
  const hit = foodCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.payload;

  const today = new Date().toISOString().slice(0, 10);
  let usage = await store.get('usage', { date: today, count: 0 });
  if (usage.date !== today) usage = { date: today, count: 0 };
  if (usage.count >= PLACES_DAILY_BUDGET) throw new Bad('Limite giornaliero di ricerche raggiunto. Usa le opzioni salvate dal gruppo.', 429);
  usage.count++; await store.set('usage', usage);

  let places;
  try {
    places = await placesNearby(lat, lng, radius, cats[cat], excluded);
  } catch (e) {
    if (e.status !== 400) throw new Bad('Google Places non risponde: riprova o usa le opzioni salvate.', 502);
    // un nome di tipo non riconosciuto invalida l'intera richiesta: riprova in forma minima e filtra qui
    usage.count++; await store.set('usage', usage);
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
  '.svg': 'image/svg+xml', '.png': 'image/png',
};
const SEC = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https://upload.wikimedia.org https://thumb.wikimedia.org; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
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
const NO_STORE = 'Su questo server le modifiche non sono attive: manca un archivio (Supabase, Redis, GitHub o disco scrivibile).';

async function api(req, res, url) {
  const p = url.pathname;
  const m = req.method;
  await loadState();
  const sess = await sessionOf(req);
  const needAdmin = () => { if (!sess) throw new Bad('Sessione amministratore scaduta o assente.', 401); return sess; };

  if (m === 'GET' && p === '/api/data') {
    const admin = sess ? { name: sess.name, exp: sess.exp, pin: Boolean(sess.pin) } : null;
    if (!sess || backend !== 'github') return send(res, 200, { ...publicData(state, Boolean(sess)), admin });
    admin.historyUrl = `https://github.com/${GH_REPO}/commits/${GH_BRANCH}/${GH_FILE}`;
    try {
      const v = ghView(await ghLoad());
      return send(res, 200, { ...publicData(v.state, true), rev: v.rev, pending: v.pending, admin });
    } catch (e) {
      if (!(e instanceof Bad)) throw e;
      // GitHub non risponde: l'admin vede il programma pubblicato e il motivo, senza restare a schermo vuoto
      return send(res, 200, { ...publicData(state, true), storeError: e.message, admin });
    }
  }

  if (m === 'GET' && p === '/api/food') return send(res, 200, await foodSearch(url.searchParams, ipOf(req)));

  if (m === 'POST' && p === '/api/admin/login') {
    if (readOnly()) throw new Bad(NO_STORE, 503);
    const ip = ipOf(req);
    const { all, list } = await recentFails(ip);
    if (list.length >= FAIL_MAX) throw new Bad('Troppi tentativi: riprova tra 15 minuti.', 429);
    const { code } = await readBody(req);
    const a = isPin(code) ? pinAdmin() : normCode(code).length >= 8 ? await findAdminByCode(code) : null;
    if (!a) { all[ip] = list.concat(Date.now()); await store.set('fails', all); throw new Bad('Codice non valido.', 401); }
    return send(res, 200, newSession(a));
  }
  if (m === 'POST' && p === '/api/admin/logout') return send(res, 200, { ok: true }); // il gettone viene scartato dal telefono
  if (m === 'POST' && p === '/api/admin/rotate') {
    const s = needAdmin();
    if (s.pin) throw new Bad('Il PIN si cambia nella variabile ADMIN_PIN del server.');
    const { code, rec } = await setAdmin(s.name); // il vecchio codice e le vecchie sessioni decadono subito
    return send(res, 200, { code, ...newSession(rec) });
  }
  if (m === 'GET' && p === '/api/admin/history') {
    needAdmin();
    const snapshots = await store.get('snapshots', []);
    return send(res, 200, { changes: state.changes.slice(-150), snapshots: snapshots.map((s) => s.version), admins: (await getAdmins()).map((a) => a.name) });
  }
  if (m === 'POST' && p === '/api/admin/restore') {
    const s = needAdmin();
    const { version } = await readBody(req);
    const snap = (await store.get('snapshots', [])).find((x) => x.version === Number(version));
    if (!snap) throw new Bad('Versione non più disponibile nella cronologia.', 404);
    await mutate(s.name, (next) => Object.assign(next, clone(snap.data)));
    return send(res, 200, { ok: true, version: state.version });
  }
  if (m === 'PUT' && p === '/api/config') {
    const s = needAdmin();
    const patch = cleanConfig(await readBody(req));
    await mutate(s.name, (next) => Object.assign(next.config, patch));
    return send(res, 200, { ok: true, version: state.version });
  }

  const r = /^\/api\/(activities|pois)(?:\/([\w-]{1,40}))?$/.exec(p);
  if (r) {
    const s = needAdmin();
    const kind = r[1] === 'activities' ? 'activity' : 'poi';
    const id = r[2];
    if (m === 'POST' && !id) {
      const item = { id: newId(kind === 'activity' ? 'a' : 'p'), ...clean(kind, await readBody(req), false) };
      await mutate(s.name, (next) => next[r[1]].push(item));
      return send(res, 201, { ok: true, id: item.id, version: state.version });
    }
    const missing = () => new Bad('Elemento non trovato.', 404);
    if (!id) throw missing();
    if (m === 'PUT') {
      const patch = clean(kind, await readBody(req), true);
      await mutate(s.name, (next) => { const item = next[r[1]].find((x) => x.id === id); if (!item) throw missing(); Object.assign(item, patch); });
      return send(res, 200, { ok: true, version: state.version });
    }
    if (m === 'DELETE') {
      await mutate(s.name, (next) => {
        if (!next[r[1]].some((x) => x.id === id)) throw missing();
        next[r[1]] = next[r[1]].filter((x) => x.id !== id);
        if (kind === 'activity') next.pois.forEach((x) => { if (x.linkedActivityId === id) x.linkedActivityId = ''; });
      });
      return send(res, 200, { ok: true, version: state.version });
    }
  }
  throw new Bad('Non trovato.', 404);
}

function serveStatic(req, res, url) {
  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = STATIC[rel];
  if (!file) return send(res, 404, 'Non trovato');
  fs.readFile(file, (err, buf) => {
    if (err) {
      // se l'hosting serve public/ per conto suo, la pagina è comunque raggiungibile come /index.html
      if (url.pathname === '/') { res.writeHead(302, { ...SEC, Location: '/index.html' }); return res.end(); }
      return send(res, 404, 'Non trovato');
    }
    res.writeHead(200, { ...SEC, 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}

async function handle(req, res) {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return send(res, 400, 'Richiesta non valida'); }
  if (url.pathname.startsWith('/api/')) {
    try { await init(); await api(req, res, url); }
    catch (e) {
      if (e instanceof Bad) return send(res, e.code, { error: e.message });
      console.error(e);
      send(res, 500, { error: 'Errore interno.' });
    }
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Metodo non ammesso');
  serveStatic(req, res, url);
}

// CLI: node server.js admin add|revoke|list [nome]   (usa lo stesso archivio del server: file locali, oppure Supabase o Redis se configurati in .env)
async function cli() {
  const [, , , cmd, ...rest] = process.argv;
  const name = rest.join(' ').trim();
  await init();
  if (readOnly()) return console.log(NO_STORE);
  if (backend === 'github') return console.log('Con l\'archivio GitHub non ci sono codici per nome: si entra con il PIN impostato in ADMIN_PIN.');
  const admins = await getAdmins();
  if (cmd === 'add' && name) {
    const { code } = await setAdmin(name);
    console.log(`Codice amministratore per "${name}" (mostrato una sola volta, non viene salvato in chiaro):\n\n   ${code}\n\nArchivio: ${backendName()}`);
  } else if (cmd === 'revoke' && name) {
    const left = admins.filter((a) => a.name.toLowerCase() !== name.toLowerCase());
    await store.set('admins', left);
    console.log(left.length === admins.length ? `Nessun amministratore "${name}".` : `Codice di "${name}" revocato. Le sue sessioni aperte smettono subito di funzionare.`);
  } else if (cmd === 'list') {
    console.log(admins.length ? admins.map((a) => `- ${a.name} (dal ${a.createdAt.slice(0, 10)})`).join('\n') : 'Nessun amministratore.');
  } else {
    console.log('Uso: node server.js admin add <nome> | revoke <nome> | list');
  }
}

if (process.argv[2] === 'admin') {
  cli().catch((e) => { console.error(e.message); process.exitCode = 1; });
} else {
  http.createServer(handle).listen(PORT, () => {
    console.log(`NYC in compagnia: http://localhost:${PORT}  (archivio: ${backendName()})`);
    console.log(PIN_OK ? `Accesso admin con PIN attivo (firma delle modifiche: ${ADMIN_NAME}).` : process.env.ADMIN_PIN ? 'ADMIN_PIN ignorato: servono almeno 6 caratteri tra lettere e cifre.' : 'ADMIN_PIN assente: l\'accesso con PIN è spento.');
    if (!PLACES_KEY) console.log('GOOGLE_PLACES_API_KEY assente: TrovaCibo mostra solo le opzioni salvate dal gruppo.');
  });
}

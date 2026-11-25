// Prova l'area admin senza toccare nulla di vero: un finto GitHub in locale al posto di api.github.com,
// un PIN generato a caso a ogni esecuzione e una cartella temporanea per l'archivio su file.
// Uso: npm test
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PIN = String(crypto.randomInt(10000000, 99999999));
const TOKEN = 'token-di-prova-' + crypto.randomBytes(6).toString('hex');
const blobSha = (buf) => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

// ---------- finto GitHub ----------
const fake = { file: fs.readFileSync(path.join(ROOT, 'data', 'seed.json')), commits: [], beforePut: null, tokenOk: true };
if (fake.file.includes('\r\n')) fake.file = Buffer.from(fake.file.toString('utf8').replace(/\r\n/g, '\n')); // nel repository il file ha solo \n
const github = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const reply = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
    const url = new URL(req.url, 'http://x');
    if (req.headers.authorization !== `Bearer ${TOKEN}` || !fake.tokenOk) return reply(401, { message: 'Bad credentials' });
    if (url.pathname !== '/repos/prova/nyc/contents/data/seed.json') return reply(404, { message: 'Not Found' });
    if (req.method === 'GET') return reply(200, fake.file);
    if (req.method === 'PUT') {
      if (fake.beforePut) { const fn = fake.beforePut; fake.beforePut = null; fn(); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (body.sha !== blobSha(fake.file)) return reply(409, { message: 'data/seed.json does not match' });
      fake.file = Buffer.from(body.content, 'base64');
      fake.commits.push({ message: body.message, branch: body.branch });
      return reply(200, { content: { sha: blobSha(fake.file) } });
    }
    reply(405, {});
  });
});
const current = () => JSON.parse(fake.file.toString('utf8'));

// ---------- server in prova ----------
const children = [];
async function startServer(port, env) {
  const blank = Object.fromEntries(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'GITHUB_TOKEN', 'GITHUB_REPO', 'GITHUB_BRANCH', 'SESSION_SECRET', 'ADMIN_NAME', 'GOOGLE_PLACES_API_KEY', 'DATA_DIR', 'VERCEL', 'PLACES_API_URL'].map((k) => [k, '']));
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, ...blank, PORT: String(port), TRUST_PROXY: '1', ADMIN_PIN: PIN, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  children.push(child);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(base + '/api/data')).ok) break; } catch { /* non ancora partito */ }
    await new Promise((r) => setTimeout(r, 100));
    if (i === 79) throw new Error('il server di prova non parte');
  }
  return async (method, p, { token, body, ip = '10.0.0.1' } = {}) => {
    const res = await fetch(base + p, { method, headers: { 'X-Forwarded-For': ip, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
}
const freePort = () => new Promise((resolve) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

let api, token;
const ACT = 'a-0412-jfk';

test('GitHub: chi legge vede il seed pubblicato e può aprire il login', async () => {
  const { status, json } = await api('GET', '/api/data');
  assert.equal(status, 200);
  assert.equal(json.readOnly, true);
  assert.equal(json.canLogin, true);
  assert.equal(json.admin, null);
  assert.ok(!('pending' in json));
});
test('PIN sbagliato rifiutato; dopo 5 errori quell\'indirizzo resta bloccato', async () => {
  const wrong = PIN === '11111111' ? '22222222' : '11111111';
  for (let i = 0; i < 5; i++) assert.equal((await api('POST', '/api/admin/login', { body: { code: wrong }, ip: '10.9.9.9' })).status, 401);
  assert.equal((await api('POST', '/api/admin/login', { body: { code: PIN }, ip: '10.9.9.9' })).status, 429);
});
test('PIN giusto: sessione che scade, senza cambio codice', async () => {
  const { status, json } = await api('POST', '/api/admin/login', { body: { code: PIN } });
  assert.equal(status, 200);
  assert.equal(json.name, 'Organizzatori');
  assert.ok(json.exp > Date.now() && json.exp <= Date.now() + 121 * 60 * 1000);
  token = json.token;
  const d = (await api('GET', '/api/data', { token })).json;
  assert.equal(d.admin.pin, true);
  assert.equal(d.pending, false);
  assert.match(d.admin.historyUrl, /^https:\/\/github\.com\/prova\/nyc\/commits\/main\/data\/seed\.json$/);
  assert.equal((await api('POST', '/api/admin/rotate', { token })).status, 400);
});
test('senza sessione o con gettone alterato non si modifica nulla', async () => {
  assert.equal((await api('PUT', `/api/activities/${ACT}`, { body: { time: '19:30' } })).status, 401);
  const forged = token.replace(/.$/, (c) => (c === '0' ? '1' : '0'));
  assert.equal((await api('PUT', `/api/activities/${ACT}`, { token: forged, body: { time: '19:30' } })).status, 401);
  assert.equal(fake.commits.length, 0);
});
test('salvare un orario fa un commit valido; l\'admin lo vede subito, gli altri dopo la pubblicazione', async () => {
  const r = await api('PUT', `/api/activities/${ACT}`, { token, body: { time: '19:30' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(fake.commits.length, 1);
  assert.match(fake.commits[0].message, /^Admin: modificata «/);
  assert.equal(fake.commits[0].branch, 'main');
  const text = fake.file.toString('utf8');
  assert.ok(text.endsWith('}\n') && !text.includes('\r'));
  assert.equal(JSON.stringify(current(), null, 2) + '\n', text); // stesso formato del file a mano: i diff restano piccoli
  assert.equal(current().activities.find((a) => a.id === ACT).time, '19:30');
  assert.deepEqual(require('./check-seed.js').validate(current()), []);
  const mine = (await api('GET', '/api/data', { token })).json;
  assert.equal(mine.activities.find((a) => a.id === ACT).time, '19:30');
  assert.equal(mine.pending, true);
  const theirs = (await api('GET', '/api/data')).json;
  assert.notEqual(theirs.activities.find((a) => a.id === ACT).time, '19:30');
});
test('una modifica che fermerebbe la pubblicazione non viene salvata', async () => {
  const before = fake.commits.length;
  assert.equal((await api('PUT', `/api/activities/${ACT}`, { token, body: { date: '2026-12-20' } })).status, 400);
  assert.equal((await api('PUT', `/api/activities/${ACT}`, { token, body: { time: '9:30' } })).status, 400);
  assert.equal(fake.commits.length, before);
});
test('nuova tappa, tappa annullata, eliminazione', async () => {
  const made = await api('POST', '/api/activities', { token, body: { title: 'Brunch di prova', date: '2026-12-06', type: 'pasto', status: 'proposto', audience: 'tutti', time: '11:00' } });
  assert.equal(made.status, 201);
  assert.equal((await api('PUT', `/api/activities/${made.json.id}`, { token, body: { status: 'annullato' } })).status, 200);
  assert.equal(current().activities.find((a) => a.id === made.json.id).status, 'annullato');
  assert.equal((await api('DELETE', `/api/activities/${made.json.id}`, { token })).status, 200);
  assert.ok(!current().activities.some((a) => a.id === made.json.id));
});
test('curiosità, ristoranti proposti e note Info', async () => {
  const poi = current().pois[0];
  assert.equal((await api('PUT', `/api/pois/${poi.id}`, { token, body: { published: !poi.published } })).status, 200);
  assert.equal(current().pois[0].published, !poi.published);
  const r = await api('PUT', '/api/config', { token, body: { infoNotes: 'Nota di prova', foodFallback: [{ name: 'Posto di prova', address: '1 Test St', note: '' }] } });
  assert.equal(r.status, 200);
  assert.equal(current().config.infoNotes, 'Nota di prova');
  assert.equal(current().config.foodFallback.length, 1);
  assert.match(fake.commits.at(-1).message, /^Admin: impostazioni$/);
});
test('interruttore Milano: si salva nel seed e accetta solo vero o falso', async () => {
  assert.equal(current().config.milanoEnabled, true);
  assert.equal((await api('PUT', '/api/config', { token, body: { milanoEnabled: 'no' } })).status, 400);
  assert.equal((await api('PUT', '/api/config', { body: { milanoEnabled: false } })).status, 401);
  assert.equal((await api('PUT', '/api/config', { token, body: { milanoEnabled: false } })).status, 200);
  assert.equal(current().config.milanoEnabled, false);
  assert.equal(current().config.infoNotes, 'Nota di prova'); // le altre impostazioni restano
  assert.deepEqual(require('./check-seed.js').validate(current()), []);
  assert.ok(require('./check-seed.js').validate({ ...current(), config: { ...current().config, milanoEnabled: 'si' } }).length);
  // l'admin vede ancora la scheda di Milano (per modificarla); chi legge vede il seed pubblicato, dove Milano è ancora accesa
  assert.ok((await api('GET', '/api/data', { token })).json.pois.some((p) => p.zone === 'Milano'));
  assert.equal((await api('PUT', '/api/config', { token, body: { milanoEnabled: true } })).status, 200);
  assert.equal(current().config.milanoEnabled, true);
});
test('se il file cambia su GitHub nel frattempo, la modifica viene riapplicata senza perdere quella altrui', async () => {
  fake.beforePut = () => { const s = current(); s.activities[0].description = 'Cambiata da un\'altra sessione'; fake.file = Buffer.from(JSON.stringify(s, null, 2) + '\n'); };
  const r = await api('PUT', `/api/activities/${ACT}`, { token, body: { time: '20:00' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(current().activities[0].description, 'Cambiata da un\'altra sessione');
  assert.equal(current().activities.find((a) => a.id === ACT).time, '20:00');
});
test('token GitHub rifiutato: errore chiaro al salvataggio, il programma pubblicato resta leggibile', async () => {
  fake.tokenOk = false;
  await new Promise((r) => setTimeout(r, 3100)); // oltre la copia tenuta 3 secondi
  const r = await api('PUT', `/api/activities/${ACT}`, { token, body: { time: '21:00' } });
  assert.equal(r.status, 502);
  assert.match(r.json.error, /token/);
  const d = await api('GET', '/api/data', { token });
  assert.equal(d.status, 200);
  assert.match(d.json.storeError, /token/);
  assert.ok(d.json.activities.length > 0);
  fake.tokenOk = true;
});
test('archivio su file: stesso PIN, modifiche visibili subito a tutti', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nyc-test-'));
  try {
    const local = await startServer(await freePort(), { DATA_DIR: dir, GOOGLE_PLACES_API_KEY: 'chiave-finta', PLACES_API_URL: 'http://127.0.0.1:9/' });
    const pub = (await local('GET', '/api/data')).json;
    assert.equal(pub.readOnly, false);
    assert.equal(pub.canLogin, true);
    const s = await local('POST', '/api/admin/login', { body: { code: PIN } });
    assert.equal(s.status, 200);
    assert.equal((await local('PUT', `/api/activities/${ACT}`, { token: s.json.token, body: { time: '19:45' } })).status, 200);
    const after = (await local('GET', '/api/data')).json;
    assert.equal(after.activities.find((a) => a.id === ACT).time, '19:45');
    assert.equal(after.changes.at(-1).author, 'Organizzatori');
    assert.equal((await local('GET', '/api/admin/history', { token: s.json.token })).status, 200);
    // Milano accesa: scheda di prova visibile e ricerca ammessa (qui Places è un indirizzo finto che non risponde: 502, non 422)
    const milan = '/api/food?lat=45.5022&lng=9.1593', nyc = '/api/food?lat=40.7527&lng=-73.9772';
    assert.equal(after.config.milanoEnabled, true);
    assert.ok(after.pois.some((p) => p.zone === 'Milano'));
    assert.equal((await local('GET', milan)).status, 502);
    // Milano spenta: il server rifiuta la ricerca a Milano e non manda più le schede della zona a chi legge
    assert.equal((await local('PUT', '/api/config', { token: s.json.token, body: { milanoEnabled: false } })).status, 200);
    const off = (await local('GET', '/api/data')).json;
    assert.equal(off.config.milanoEnabled, false);
    assert.ok(!off.pois.some((p) => p.zone === 'Milano'));
    assert.ok(off.pois.length > 100);
    assert.ok((await local('GET', '/api/data', { token: s.json.token })).json.pois.some((p) => p.zone === 'Milano'));
    const refused = await local('GET', milan);
    assert.equal(refused.status, 422);
    assert.match(refused.json.error, /solo a New York\.$/);
    assert.equal((await local('GET', nyc)).status, 502);
  } finally { children.at(-1).kill(); await new Promise((r) => setTimeout(r, 200)); fs.rmSync(dir, { recursive: true, force: true }); }
});
test('senza ADMIN_PIN l\'accesso con PIN è spento', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nyc-test-'));
  try {
    const local = await startServer(await freePort(), { DATA_DIR: dir, ADMIN_PIN: '' });
    assert.equal((await local('POST', '/api/admin/login', { body: { code: PIN } })).status, 401);
    assert.equal((await local('POST', '/api/admin/login', { body: { code: '' } })).status, 401);
  } finally { children.at(-1).kill(); await new Promise((r) => setTimeout(r, 200)); fs.rmSync(dir, { recursive: true, force: true }); }
});
test('il sito dice cosa manca all\'area Admin: PIN con GitHub, oppure l\'archivio', async () => {
  assert.equal((await api('GET', '/api/data')).json.adminMissing, '');
  const noPin = await startServer(await freePort(), { GITHUB_API_URL: `http://127.0.0.1:${github.address().port}`, GITHUB_TOKEN: TOKEN, GITHUB_REPO: 'prova/nyc', ADMIN_PIN: '' });
  const d = (await noPin('GET', '/api/data')).json;
  assert.equal(d.canLogin, false);
  assert.equal(d.adminMissing, 'pin');
  children.at(-1).kill();
});

(async () => {
  await new Promise((r) => github.listen(0, '127.0.0.1', r));
  let failed = 0;
  try {
    api = await startServer(await freePort(), { GITHUB_API_URL: `http://127.0.0.1:${github.address().port}`, GITHUB_TOKEN: TOKEN, GITHUB_REPO: 'prova/nyc' });
    for (const [name, fn] of tests) {
      try { await fn(); console.log('ok   ' + name); }
      catch (e) { failed++; console.error('ERRORE ' + name + '\n' + (e.stack || e)); }
    }
  } finally {
    for (const c of children) c.kill();
    github.close();
  }
  console.log(failed ? `\n${failed} prove fallite su ${tests.length}.` : `\nTutte le ${tests.length} prove sono passate.`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); for (const c of children) c.kill(); process.exit(1); });

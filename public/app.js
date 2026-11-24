'use strict';
(() => {
  // ---------- utilità ----------
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const LS = {
    get(k, d) { try { const v = localStorage.getItem('nyc.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('nyc.' + k, JSON.stringify(v)); } catch { /* spazio esaurito o modalità privata */ } },
  };
  const toast = (msg) => {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 3200);
  };

  const STATUS_L = { prenotato: 'Prenotato', proposto: 'Proposto', da_confermare: 'Da confermare', facoltativo: 'Facoltativo' };
  const AUD_L = { tutti: 'Tutti', facoltativo: 'Facoltativa', sottogruppo: 'Sottogruppo' };
  const TYPE_L = { ritrovo: 'Ritrovo', visita: 'Visita', pasto: 'Pasto', spostamento: 'Spostamento' };
  const CAT_L = { film: 'Film e serie', marvel: 'Marvel', storia: 'Storia', natale: 'Natale', ragazzi: 'Per ragazzi' };
  const LINK_L = { set_verificato: 'Set verificato', ispirazione: 'Luogo che ha ispirato la storia', ambientazione: 'Ambientazione narrativa', luogo_storico: 'Luogo storico' };
  const FIELD_L = {
    meetTime: 'Ritrovo', meetPlace: 'Punto di ritrovo', time: 'Inizio', endTime: 'Fine', date: 'Giorno',
    placeName: 'Luogo', address: 'Indirizzo', status: 'Stato', title: 'Titolo', audience: 'Destinatari',
  };
  const KEY_FIELDS = Object.keys(FIELD_L);
  const ADMIN_FIELD_L = { ...FIELD_L, excludedTypes: 'Cucine escluse', foodFallback: 'Opzioni cibo di emergenza', infoNotes: 'Note del gruppo', description: 'Descrizione', transportNote: 'Trasporti', type: 'Tipo', audienceNote: 'Nota destinatari', published: 'Pubblicata', alertsEnabled: 'Segnalazione', coordsVerified: 'Coordinate verificate', context: 'Racconto', category: 'Categoria', linkType: 'Legame' };

  // ---------- stato ----------
  let data = LS.get('data', null);
  let fetchedAt = LS.get('fetchedAt', null);
  let net = navigator.onLine ? 'loading' : 'offline';
  let admin = (() => { try { return JSON.parse(sessionStorage.getItem('nyc.admin')); } catch { return null; } })();
  let interest = LS.get('interest', {});
  let poiSeen = LS.get('poiSeen', {});
  let hiddenCats = LS.get('hiddenCats', []);
  let onlyMine = LS.get('onlyMine', false);
  let muted = LS.get('muted', false);
  let geo = { pos: null, watch: null, err: '' };
  let near = []; // POI segnalati ora
  let food = { mode: 'pochi', origin: 'me', radius: 600, cat: 'tutte', open: true, price: true, kids: false, results: null, at: null, center: null, busy: false, err: '' };
  let adminLog = null;

  // ---------- ora di New York ----------
  const simParam = new URLSearchParams(location.search).get('ora');
  if (simParam && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(simParam)) sessionStorage.setItem('nyc.sim', simParam);
  const sim = () => sessionStorage.getItem('nyc.sim');
  const nyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  function nowNY() {
    const s = sim();
    if (s) return { date: s.slice(0, 10), time: s.slice(11, 16) };
    const p = Object.fromEntries(nyFmt.formatToParts(new Date()).map((x) => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
  }
  const asUTC = (date, time = '12:00') => new Date(`${date}T${time}:00Z`);
  const fmtDay = (date, opts = { weekday: 'long', day: 'numeric', month: 'long' }) => asUTC(date).toLocaleDateString('it-IT', { ...opts, timeZone: 'UTC' });
  const fmtInstant = (iso) => new Date(iso).toLocaleString('it-IT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const addDays = (date, n) => new Date(asUTC(date).getTime() + n * 864e5).toISOString().slice(0, 10);
  const tripDays = () => { const out = []; for (let d = data.trip.start; d <= data.trip.end; d = addDays(d, 1)) out.push(d); return out; };
  const minutesBetween = (d1, t1, d2, t2) => Math.round((asUTC(d2, t2) - asUTC(d1, t1)) / 60000);

  // ---------- programma ----------
  const startOf = (a) => a.meetTime || a.time || '';
  const sortActs = (list) => list.slice().sort((a, b) => a.date.localeCompare(b.date) || (startOf(a) || '99').localeCompare(startOf(b) || '99') || (a.order ?? 50) - (b.order ?? 50));
  const dayActs = (date) => sortActs(data.activities.filter((a) => a.date === date));
  const included = (a) => a.audience === 'tutti' || Boolean(interest[a.id]);
  const isUpcoming = (a, now) => a.date > now.date || (a.date === now.date && (!startOf(a) || startOf(a) >= now.time));
  const isMeeting = (a) => Boolean(a.meetTime || a.meetPlace || a.type === 'ritrovo');
  const fascia = (a) => { const t = startOf(a); return !t ? 'Orario da definire' : t < '12:00' ? 'Mattina' : t < '18:00' ? 'Pomeriggio' : 'Sera'; };
  function nextMeeting() {
    const now = nowNY();
    return sortActs(data.activities).find((a) => isMeeting(a) && included(a) && isUpcoming(a, now)) || null;
  }

  // ---------- cambi di programma ----------
  function pendingChanges() {
    const seen = LS.get('seenVersion', null);
    if (seen == null || !data) return [];
    return (data.changes || []).filter((c) => c.entity === 'activity' && c.v > seen);
  }
  const fmtVal = (f, v) => {
    if (v === '' || v == null) return '—';
    if (f === 'status') return STATUS_L[v] || v;
    if (f === 'audience') return AUD_L[v] || v;
    if (f === 'date') return fmtDay(v, { weekday: 'short', day: 'numeric', month: 'short' });
    return String(v);
  };
  // Raggruppa per attività: per ogni campo mostra il primo "prima" e l'ultimo "dopo".
  function changeGroups(list) {
    const groups = new Map();
    for (const c of list) {
      let g = groups.get(c.entityId);
      if (!g) groups.set(c.entityId, g = { id: c.entityId, title: c.title, date: c.date, created: false, deleted: false, fields: new Map(), other: false });
      g.title = c.title || g.title; g.at = c.at; g.author = c.author; g.date = c.date || g.date;
      if (c.action === 'create') { g.created = true; g.deleted = false; }
      if (c.action === 'delete') g.deleted = true;
      for (const f of c.fields || []) {
        if (!KEY_FIELDS.includes(f.f)) { g.other = true; continue; }
        const cur = g.fields.get(f.f);
        g.fields.set(f.f, { before: cur ? cur.before : f.before, after: f.after });
      }
    }
    return [...groups.values()].filter((g) => !(g.created && g.deleted));
  }
  function changesHtml() {
    const groups = changeGroups(pendingChanges());
    if (!groups.length) return '';
    const items = groups.map((g) => {
      let body;
      if (g.deleted) body = '<span class="chg">Annullata</span>';
      else if (g.created) body = '<span class="chg">Nuova attività</span>';
      else {
        const lines = KEY_FIELDS.filter((f) => g.fields.has(f) && g.fields.get(f).before !== g.fields.get(f).after)
          .map((f) => { const v = g.fields.get(f); return `<span class="chg">${FIELD_L[f]} <s>${esc(fmtVal(f, v.before))}</s> → ${esc(fmtVal(f, v.after))}</span>`; });
        body = lines.join('') || '<span class="chg">Dettagli aggiornati</span>';
      }
      const link = g.deleted ? '' : ` · <a href="#/programma/${esc(g.date)}/${esc(g.id)}">Apri la scheda</a>`;
      return `<li><b>${esc(g.title)}</b>${g.date ? ` · ${esc(fmtDay(g.date, { weekday: 'short', day: 'numeric', month: 'short' }))}` : ''}${body}
        <span class="who">Modificato da ${esc(g.author || 'admin')}, ${esc(fmtInstant(g.at))}${link}</span></li>`;
    }).join('');
    const off = net === 'offline' ? '<p class="note">Sei senza rete: potrebbe esistere una versione ancora più recente.</p>' : '';
    return `<section class="alert" aria-label="Cambio di programma"><h3>Cambio di programma</h3><ul>${items}</ul>${off}
      <div class="actions"><button class="btn primary small" data-act="seen">Ho visto</button></div></section>`;
  }

  // ---------- Maps e calendario ----------
  function locStr(o) {
    if (o.coordsVerified && o.lat != null && o.lng != null) return `${o.lat},${o.lng}`;
    const name = o.placeName || o.name || '';
    const s = [o.address && o.address.startsWith(name) ? '' : name, o.address].filter(Boolean).join(', '); // niente nome ripetuto
    return o.address || /\bNY\b|New York/i.test(s) ? s : s + ', New York, NY'; // un indirizzo completo non va ritoccato
  }
  const hasPlace = (o) => Boolean(o.address || o.placeName || o.name);
  const stopOf = (a) => (hasPlace(a) ? a : a.meetPlace ? { title: a.title, placeName: a.meetPlace, address: '' } : null);
  const mapsDir = (o) => 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(locStr(o)) + (o.placeId ? '&destination_place_id=' + encodeURIComponent(o.placeId) : '');
  const mapsPlace = (o) => 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(locStr(o)) + (o.placeId ? '&query_place_id=' + encodeURIComponent(o.placeId) : '');
  const extLink = (href, label, cls = 'btn') => `<a class="${cls}" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;

  function calTimes(a) {
    const t = a.time || a.meetTime;
    const compact = (d) => d.toISOString().replace(/[-:]/g, '').slice(0, 15);
    if (!t) return { allDay: true, start: a.date.replace(/-/g, ''), end: addDays(a.date, 1).replace(/-/g, '') };
    const s = asUTC(a.date, a.meetTime && a.meetTime < t ? a.meetTime : t);
    let e = a.endTime ? asUTC(a.date, a.endTime) : new Date(asUTC(a.date, t).getTime() + 90 * 60000);
    if (e <= s) e = new Date(e.getTime() + 864e5);
    return { allDay: false, start: compact(s), end: compact(e) };
  }
  const cardUrl = (a) => `${location.origin}/#/programma/${a.date}/${a.id}`;
  function calDetails(a) {
    return [a.meetTime ? `Ritrovo ore ${a.meetTime}${a.meetPlace ? ' — ' + a.meetPlace : ''}` : '', a.time ? `Inizio ore ${a.time}` : '', a.description,
      `Stato: ${STATUS_L[a.status]}`, `Scheda aggiornata: ${cardUrl(a)}`,
      'Copia personale: se il programma cambia, questo evento non si aggiorna da solo.'].filter(Boolean).join('\n');
  }
  function gcalUrl(a) {
    const t = calTimes(a);
    const q = new URLSearchParams({ action: 'TEMPLATE', text: a.title, dates: `${t.start}/${t.end}`, details: calDetails(a), location: [a.placeName, a.address].filter(Boolean).join(', ') || a.meetPlace || '' });
    if (!t.allDay) q.set('ctz', 'America/New_York');
    return 'https://calendar.google.com/calendar/render?' + q;
  }
  function icsFor(a) {
    const t = calTimes(a);
    const e = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
    const when = t.allDay ? [`DTSTART;VALUE=DATE:${t.start}`, `DTEND;VALUE=DATE:${t.end}`] : [`DTSTART;TZID=America/New_York:${t.start}`, `DTEND;TZID=America/New_York:${t.end}`];
    return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//NYC in compagnia//IT', 'CALSCALE:GREGORIAN',
      'BEGIN:VTIMEZONE', 'TZID:America/New_York',
      'BEGIN:STANDARD', 'DTSTART:19701101T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'TZNAME:EST', 'END:STANDARD',
      'BEGIN:DAYLIGHT', 'DTSTART:19700308T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'TZNAME:EDT', 'END:DAYLIGHT',
      'END:VTIMEZONE',
      'BEGIN:VEVENT', `UID:${a.id}-${stamp}@nyc-in-compagnia`, `DTSTAMP:${stamp}`, ...when,
      `SUMMARY:${e(a.title)}`, `LOCATION:${e([a.placeName, a.address].filter(Boolean).join(', ') || a.meetPlace)}`, `DESCRIPTION:${e(calDetails(a))}`,
      'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  }

  // ---------- posizione ----------
  function dist(a, b) {
    const R = 6371000, r = Math.PI / 180;
    const x = Math.sin((b.lat - a.lat) * r / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin((b.lng - a.lng) * r / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  const fmtDist = (m) => (m < 950 ? `≈ ${Math.round(m / 50) * 50 || 50} m` : `≈ ${(m / 1000).toFixed(1).replace('.', ',')} km`) + (m < 2500 ? ` · ${Math.max(1, Math.round(m / 75))} min a piedi` : '');
  const geoErr = (e) => e.code === 1 ? 'Permesso di posizione negato: puoi riattivarlo dalle impostazioni del browser.' : 'Posizione non disponibile in questo momento.';
  const getPos = () => new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error('Questo dispositivo non fornisce la posizione.'));
    navigator.geolocation.getCurrentPosition((p) => res({ lat: p.coords.latitude, lng: p.coords.longitude }), (e) => rej(new Error(geoErr(e))), { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
  });
  function startWatch() {
    if (!navigator.geolocation) { geo.err = 'Questo dispositivo non fornisce la posizione.'; return render(); }
    if (geo.watch != null) return;
    geo.err = '';
    geo.watch = navigator.geolocation.watchPosition((p) => {
      geo.pos = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, at: Date.now() };
      checkNear(); if (view().name === 'vicino' || near.length) render();
    }, (e) => { geo.err = geoErr(e); stopWatch(); }, { enableHighAccuracy: true, maximumAge: 20000 });
    render();
  }
  function stopWatch() {
    if (geo.watch != null) navigator.geolocation.clearWatch(geo.watch);
    geo.watch = null; render();
  }
  // Una segnalazione per luogo al giorno, al massimo tre alla volta, solo per schede con coordinate verificate.
  function checkNear() {
    if (muted || !geo.pos) return;
    const today = new Date().toISOString().slice(0, 10);
    const alerted = LS.get('alerted', {});
    for (const p of data.pois) {
      if (near.length >= 3) break;
      if (!p.published || !p.alertsEnabled || !p.coordsVerified || p.lat == null || poiSeen[p.id] || hiddenCats.includes(p.category)) continue;
      if (alerted[p.id] === today || near.includes(p.id)) continue;
      if (dist(geo.pos, p) <= (p.radius || 250)) { near.push(p.id); alerted[p.id] = today; }
    }
    LS.set('alerted', alerted);
  }
  function nearHtml() {
    const list = near.map((id) => data.pois.find((p) => p.id === id)).filter(Boolean);
    if (!list.length) return '';
    return `<section class="alert near"><h3>Sei vicino a…</h3><ul>${list.map((p) => `<li><b>${esc(p.name)}</b>${p.work ? ` · ${esc(p.work)}` : ''}
      <span class="who">${esc(CAT_L[p.category])} · ${esc(fmtDist(dist(geo.pos, p)))} · <a href="#/vicino/${esc(p.id)}">Leggi la scheda</a></span></li>`).join('')}</ul>
      <div class="actions"><button class="btn small" data-act="near-ok">Ok</button><button class="btn small" data-act="mute">Silenzia</button></div></section>`;
  }

  // ---------- rete ----------
  async function api(path, opts = {}) {
    const headers = { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(admin ? { Authorization: 'Bearer ' + admin.token } : {}) };
    const res = await fetch(path, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined, cache: 'no-store' });
    const json = await res.json().catch(() => ({}));
    if (res.status === 401 && admin && path !== '/api/admin/login') { setAdmin(null); toast('Sessione amministratore scaduta.'); }
    if (!res.ok) { const e = new Error(json.error || 'Richiesta non riuscita.'); e.status = res.status; throw e; }
    return json;
  }
  function setAdmin(a) {
    admin = a;
    if (a) sessionStorage.setItem('nyc.admin', JSON.stringify(a)); else sessionStorage.removeItem('nyc.admin');
    renderTabs();
  }
  async function refresh(silent) {
    const sig = () => `${data && data.version}|${net}|${Boolean(admin)}`;
    const before = sig();
    try {
      const d = await api('/api/data');
      if (admin && !d.admin) setAdmin(null);
      data = d; fetchedAt = new Date().toISOString(); net = 'ok';
      LS.set('data', d); LS.set('fetchedAt', fetchedAt);
      if (LS.get('seenVersion', null) == null) LS.set('seenVersion', d.version);
    } catch {
      net = 'offline';
    }
    // gli aggiornamenti automatici non ridisegnano la pagina se nulla e' cambiato (per non cancellare cio' che si sta scrivendo)
    if (silent && before === sig()) return renderTop();
    render();
  }

  // ---------- viste ----------
  const view = () => {
    const [name = 'oggi', a, b] = location.hash.replace(/^#\/?/, '').split('/');
    return { name: name || 'oggi', a, b };
  };
  const TABS = [
    ['oggi', 'Oggi', '<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>'],
    ['programma', 'Programma', '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>'],
    ['vicino', 'Vicino a me', '<path d="M12 21s7-6.2 7-11a7 7 0 0 0-14 0c0 4.8 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>'],
    ['cibo', 'TrovaCibo', '<path d="M6 3v8a2 2 0 0 0 4 0V3M8 3v18M17 3c-2 2-3 4-3 7h3v11"/>'],
    ['info', 'Info', '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>'],
    ['admin', 'Admin', '<path d="M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6z"/><path d="M9 12l2 2 4-4"/>'],
  ];
  function renderTabs() {
    const cur = view().name;
    $('#tabs').innerHTML = TABS.filter((t) => t[0] !== 'admin' || admin).map(([id, label, icon]) =>
      `<a href="#/${id}" ${cur === id ? 'aria-current="page"' : ''}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg>${label}</a>`).join('');
  }
  function renderTop() {
    const n = nowNY();
    $('#clock').textContent = `New York · ${fmtDay(n.date, { weekday: 'short', day: 'numeric', month: 'short' })} · ${n.time}`;
    const el = $('#netline');
    const copy = fetchedAt ? fmtInstant(fetchedAt) : 'mai';
    el.className = net === 'offline' ? 'off' : '';
    el.textContent = net === 'offline' ? `Senza rete · stai leggendo la copia salvata il ${copy}`
      : data ? `Programma aggiornato il ${fmtInstant(data.updatedAt)}` : '';
  }

  const badge = (cls, label) => `<span class="badge ${cls}">${esc(label)}</span>`;
  function timesHtml(a) {
    if (a.meetTime) return `Ritrovo <b>${esc(a.meetTime)}</b>${a.time ? ` · inizio ${esc(a.time)}` : ''}${a.endTime ? `–${esc(a.endTime)}` : ''}`;
    if (a.time) return `<b>${esc(a.time)}</b>${a.endTime ? `–${esc(a.endTime)}` : ''}`;
    return 'Orario da confermare';
  }
  function actCard(a, o = {}) {
    const linked = data.pois.filter((p) => p.linkedActivityId === a.id && p.published);
    const changed = pendingChanges().some((c) => c.entityId === a.id);
    const place = hasPlace(a) ? `<p class="place"><b>${esc(a.placeName)}</b>${a.placeName && a.address ? ' · ' : ''}${esc(a.address)}</p>` : a.meetPlace ? '' : '<p class="place">Luogo da confermare</p>';
    const target = stopOf(a);
    return `<article class="card act${o.next ? ' next' : ''}" id="act-${esc(a.id)}">
      <div class="row"><div class="times">${o.showDay ? esc(fmtDay(a.date, { weekday: 'short', day: 'numeric', month: 'short' })) + ' · ' : ''}${timesHtml(a)}</div>
        <div class="badges">${changed ? badge('upd', 'Aggiornato') : ''}${badge(a.status, STATUS_L[a.status])}${a.audience !== 'tutti' ? badge('', AUD_L[a.audience] + (a.audienceNote ? ' · ' + a.audienceNote : '')) : ''}</div></div>
      <h3>${esc(a.title)}</h3>${place}
      ${a.meetPlace ? `<p class="place">Punto di ritrovo: <b>${esc(a.meetPlace)}</b></p>` : ''}
      ${a.description ? `<p class="desc">${esc(a.description)}</p>` : ''}
      ${a.transportNote ? `<p class="note">Trasporti: ${esc(a.transportNote)}</p>` : ''}
      ${linked.map((p) => `<div class="curio"><b>${esc(p.name)}${p.work ? ' · ' + esc(p.work) : ''} — ${esc(LINK_L[p.linkType])}</b>${esc(p.context)}</div>`).join('')}
      <div class="actions">
        ${target ? extLink(mapsDir(target), 'Portami qui', 'btn primary') : ''}
        <button class="btn" data-act="cal" data-id="${esc(a.id)}">Aggiungi al calendario</button>
        ${a.voucherUrl ? extLink(a.voucherUrl, 'Voucher') : ''}
        ${a.audience !== 'tutti' ? `<button class="btn${interest[a.id] ? ' on' : ''}" data-act="interest" data-id="${esc(a.id)}" aria-pressed="${Boolean(interest[a.id])}">${interest[a.id] ? '★ Mi interessa' : '☆ Mi interessa'}</button>` : ''}
        ${admin ? `<button class="btn small" data-act="edit-activity" data-id="${esc(a.id)}">✎ Modifica</button>` : ''}
      </div>
      ${a.updatedAt ? `<p class="meta">Scheda aggiornata il ${esc(fmtInstant(a.updatedAt))}</p>` : ''}
    </article>`;
  }

  function meetingBox() {
    const m = nextMeeting();
    const h = data.trip.hotel;
    const hotel = `<div class="hotel"><span>Hotel: ${esc(h.name)}, ${esc(h.address.split(',')[0])}</span>${extLink(mapsDir({ placeName: h.name, address: h.address }), 'Portami in hotel', '')}</div>`;
    if (!m) {
      return `<section class="card meet" aria-label="Prossimo punto di incontro"><div class="label">Prossimo punto di incontro</div>
        <h3>Nessun ritrovo previsto</h3><p class="place">Nel programma non ci sono ritrovi con orario o luogo fissati da qui in avanti${onlyMineNote()}.</p>${hotel}</section>`;
    }
    const now = nowNY();
    const t = m.meetTime || m.time;
    let rel = fmtDay(m.date, { weekday: 'long', day: 'numeric', month: 'long' });
    if (m.date === now.date) {
      rel = 'oggi';
      if (t) { const mins = minutesBetween(now.date, now.time, m.date, t); rel += mins >= 60 ? ` · tra ${Math.floor(mins / 60)} h ${mins % 60} min` : ` · tra ${mins} min`; }
    } else if (m.date === addDays(now.date, 1)) rel = 'domani';
    // dove portare: l'hotel se il ritrovo è lì, altrimenti il luogo della scheda, altrimenti il testo del ritrovo
    const target = /hotel/i.test(m.meetPlace || '') ? { placeName: h.name, address: h.address } : hasPlace(m) ? m : { placeName: m.meetPlace, address: '' };
    return `<section class="card meet" aria-label="Prossimo punto di incontro"><div class="row"><div class="label">Prossimo punto di incontro</div>${badge(m.status, STATUS_L[m.status])}</div>
      <div class="when">${t ? esc(t) : 'Ora da confermare'}<small>${esc(rel)}</small></div>
      <h3>${esc(m.title)}</h3>
      <p class="place"><b>${esc(m.meetPlace || m.placeName || 'Luogo da confermare')}</b>${!m.meetPlace && m.address ? ' · ' + esc(m.address) : ''}</p>
      ${m.meetTime && m.time ? `<p class="place">La visita inizia alle ${esc(m.time)}</p>` : ''}
      <div class="actions">${hasPlace(target) ? extLink(mapsDir(target), 'Portami qui', 'btn taxi') : ''}<a class="btn" href="#/programma/${esc(m.date)}/${esc(m.id)}">Apri la scheda</a></div>${hotel}</section>`;
  }
  const onlyMineNote = () => (data.activities.some((a) => a.audience !== 'tutti' && !interest[a.id]) ? ' (le attività facoltative contano solo se le hai segnate con «Mi interessa»)' : '');

  function viewOggi() {
    const now = nowNY();
    const t = data.trip;
    let hero, day = now.date;
    if (now.date < t.start) {
      const n = Math.round((asUTC(t.start) - asUTC(now.date)) / 864e5);
      hero = `<h1>${n === 1 ? 'Manca 1 giorno' : `Mancano ${n} giorni`} alla partenza</h1><p>Si parte ${esc(fmtDay(t.start))}. Qui sotto il primo giorno.</p>`;
      day = t.start;
    } else if (now.date > t.end) {
      hero = '<h1>Il viaggio è concluso</h1><p>Il programma resta consultabile.</p>'; day = t.end;
    } else {
      hero = `<h1>${esc(fmtDay(now.date))}</h1><p>Giorno ${tripDays().indexOf(now.date) + 1} di ${tripDays().length} · a New York sono le ${esc(now.time)}</p>`;
    }
    const acts = dayActs(day).filter((a) => !onlyMine || included(a));
    const nextId = day === now.date ? (acts.find((a) => included(a) && isUpcoming(a, now)) || {}).id : null;
    const done = day === now.date && acts.length && !nextId;
    const off = net === 'offline' ? `<div class="alert plain">Sei senza rete: leggi la copia salvata${fetchedAt ? ` il ${esc(fmtInstant(fetchedAt))}` : ''}. «Portami qui» funziona solo se in Google Maps hai scaricato prima l'area offline.</div>` : '';
    return `<div class="hero">${hero}</div>${off}${changesHtml()}${nearHtml()}${meetingBox()}
      <div class="row"><h2>${day === now.date ? 'Oggi in programma' : esc(fmtDay(day))}</h2></div>
      ${done ? '<p class="lead">Le attività con orario di oggi sono passate.</p>' : ''}
      ${acts.length ? acts.map((a) => actCard(a, { next: a.id === nextId })).join('') : '<p class="empty">Nessuna attività inserita per questo giorno.</p>'}
      <div class="actions"><button class="btn" data-act="route" data-day="${esc(day)}">Percorso di oggi</button><a class="btn" href="#/programma/${esc(day)}">Tutto il programma</a></div>`;
  }

  function viewProgramma(v) {
    const now = nowNY();
    const days = tripDays();
    const day = days.includes(v.a) ? v.a : (days.includes(now.date) ? now.date : days[0]);
    const all = dayActs(day);
    const acts = all.filter((a) => !onlyMine || included(a));
    const chips = days.map((d) => `<button class="chip${d === day ? ' on' : ''}${d === now.date ? ' today' : ''}" data-act="day" data-day="${d}"><small>${esc(fmtDay(d, { weekday: 'short' }))}</small>${Number(d.slice(8))} dic</button>`).join('');
    let html = '', last = '';
    for (const a of acts) {
      const f = fascia(a);
      if (f !== last) { html += `<p class="fascia">${f}</p>`; last = f; }
      html += actCard(a);
    }
    return `<div class="chips" role="tablist" aria-label="Giorni">${chips}</div>${changesHtml()}
      <div class="row"><h2>${esc(fmtDay(day))}</h2>
        <button class="btn small${onlyMine ? ' on' : ''}" data-act="only-mine" aria-pressed="${onlyMine}">${onlyMine ? '★ Solo le mie' : 'Mostra solo le mie'}</button></div>
      ${onlyMine ? '<p class="lead">Vedi le attività per tutti e quelle facoltative segnate con «Mi interessa». È un filtro personale, non una conferma di presenza.</p>' : ''}
      ${html || `<p class="empty">${all.length ? 'Nessuna attività tra le tue per questo giorno.' : 'Nessuna attività inserita per questo giorno.'}</p>`}
      <div class="actions"><button class="btn" data-act="route" data-day="${esc(day)}">Percorso del giorno in Maps</button>
        ${admin ? `<button class="btn" data-act="new-activity" data-day="${esc(day)}">+ Nuova attività</button>` : ''}</div>`;
  }

  function poiCard(p) {
    const d = geo.pos && p.lat != null ? dist(geo.pos, p) : null;
    return `<article class="card" id="poi-${esc(p.id)}">
      <div class="row"><div class="times">${esc(CAT_L[p.category])}${p.zone ? ' · ' + esc(p.zone) : ''}</div>
        <div class="badges">${p.published ? '' : badge('draft', 'Bozza non pubblicata')}${badge('', LINK_L[p.linkType])}</div></div>
      <h3>${esc(p.name)}${p.work ? ` <span class="place">· ${esc(p.work)}</span>` : ''}</h3>
      <p class="place">${esc(p.address)}${d != null ? ` · <b>${esc(fmtDist(d))}</b>` : ''}</p>
      <p class="desc">${esc(p.context)}</p>
      ${p.note ? `<p class="note">${esc(p.note)}</p>` : ''}
      ${p.linkedActivityId ? '<p class="note">Fa già parte del programma.</p>' : '<p class="note">Curiosità: non è una tappa del programma.</p>'}
      <div class="actions">${extLink(mapsPlace(p), 'Apri in Maps')}
        <button class="btn${poiSeen[p.id] ? ' on' : ''}" data-act="poi-seen" data-id="${esc(p.id)}" aria-pressed="${Boolean(poiSeen[p.id])}">${poiSeen[p.id] ? '✓ Visto' : 'Segna come visto'}</button>
        ${admin ? `<button class="btn small" data-act="edit-poi" data-id="${esc(p.id)}">✎ Modifica</button>` : ''}</div>
      ${!p.coordsVerified && d != null ? '<p class="meta">Distanza indicativa: coordinate ancora da verificare.</p>' : ''}
    </article>`;
  }
  function viewVicino() {
    const cats = Object.keys(CAT_L).map((c) => `<button class="chip${hiddenCats.includes(c) ? ' off' : ' on'}" data-act="cat" data-cat="${c}" aria-pressed="${!hiddenCats.includes(c)}">${CAT_L[c]}</button>`).join('');
    let list = data.pois.filter((p) => !hiddenCats.includes(p.category));
    if (geo.pos) list = list.slice().sort((a, b) => (a.lat == null ? 1e9 : dist(geo.pos, a)) - (b.lat == null ? 1e9 : dist(geo.pos, b)));
    const todo = list.filter((p) => !poiSeen[p.id]), seen = list.filter((p) => poiSeen[p.id]);
    const geoBar = geo.watch != null
      ? `<div class="alert plain">${geo.pos ? `Posizione attiva (precisione ≈ ${Math.round(geo.pos.acc)} m). I luoghi sono ordinati per distanza finché l'app resta aperta.` : 'Sto cercando la tua posizione…'}
          <div class="actions"><button class="btn small" data-act="geo-stop">Ferma la posizione</button><button class="btn small${muted ? ' on' : ''}" data-act="mute">${muted ? 'Segnalazioni silenziate' : 'Silenzia le segnalazioni'}</button></div></div>`
      : `<div class="alert plain">Attiva la posizione per vedere cosa c'è nei dintorni. Resta sul telefono: non viene inviata né mostrata ad altri.${geo.err ? `<p class="err">${esc(geo.err)}</p>` : ''}
          <div class="actions"><button class="btn primary" data-act="geo-start">Usa la mia posizione</button></div></div>`;
    return `<div class="hero"><h1>Vicino a me</h1><p>Curiosità da scoprire se si passa già in zona. Non cambiano il programma.</p></div>
      ${nearHtml()}${geoBar}<div class="chips">${cats}</div>
      ${todo.map(poiCard).join('') || '<p class="empty">Nessuna scheda in queste categorie.</p>'}
      ${seen.length ? `<h2>Già visti</h2>${seen.map(poiCard).join('')}` : ''}
      ${admin ? '<div class="actions"><button class="btn" data-act="new-poi">+ Nuovo punto di interesse</button></div>' : ''}`;
  }

  const FOOD_TYPE_L = { diner: 'Diner', hamburger_restaurant: 'Hamburger', barbecue_restaurant: 'Barbecue', sandwich_shop: 'Sandwich', deli: 'Deli', fast_food_restaurant: 'Street food / fast food', food_court: 'Food court', american_restaurant: 'Cucina americana', steak_house: 'Steakhouse', breakfast_restaurant: 'Colazione e brunch', mexican_restaurant: 'Messicano' };
  const FOOD_RANK = Object.keys(FOOD_TYPE_L);
  const PRICE_L = { PRICE_LEVEL_FREE: 'Gratis', PRICE_LEVEL_INEXPENSIVE: '$', PRICE_LEVEL_MODERATE: '$$', PRICE_LEVEL_EXPENSIVE: '$$$', PRICE_LEVEL_VERY_EXPENSIVE: '$$$$' };
  function foodType(r) { return FOOD_RANK.find((t) => t === r.primaryType) || FOOD_RANK.find((t) => (r.types || []).includes(t)) || ''; }
  function foodResultsHtml() {
    if (food.busy) return '<p class="empty">Cerco nei dintorni…</p>';
    if (food.err) return `<p class="err">${esc(food.err)}</p>`;
    if (!food.results) return '';
    let list = food.results.map((r) => ({ ...r, kind: foodType(r), d: r.lat != null ? dist(food.center, r) : 1e9 }));
    if (food.open) list = list.filter((r) => r.openNow !== false);
    if (food.price) list = list.filter((r) => !['PRICE_LEVEL_EXPENSIVE', 'PRICE_LEVEL_VERY_EXPENSIVE'].includes(r.priceLevel));
    if (food.kids) list = list.filter((r) => r.goodForChildren === true);
    const rank = (r) => (r.kind ? FOOD_RANK.indexOf(r.kind) : 50) + (food.mode === 'tutti' && !(r.goodForGroups || r.reservable) ? 100 : 0);
    list.sort((a, b) => rank(a) - rank(b) || a.d - b.d);
    if (!list.length) return '<p class="empty">Nessun locale con questi filtri. Prova ad allargare il raggio o a togliere un filtro.</p>';
    return `<p class="lead">${list.length} locali · dati Google Maps delle ${esc(new Date(food.at).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }))}. Categorie, orari e prezzi possono essere incompleti: è un aiuto, non una garanzia.</p>` +
      list.map((r) => `<article class="card"><div class="row"><div class="times">${esc(FOOD_TYPE_L[r.kind] || 'Ristorante')} · ${esc(PRICE_L[r.priceLevel] || 'prezzo non indicato')}</div>
        <div class="badges">${r.openNow === true ? badge('prenotato', 'Aperto ora') : r.openNow === false ? badge('', 'Chiuso') : badge('', 'Orari non indicati')}${r.goodForChildren ? badge('proposto', 'Adatto ai ragazzi') : ''}${r.goodForGroups ? badge('proposto', 'Gruppi') : ''}${r.reservable ? badge('proposto', 'Prenotabile') : ''}</div></div>
        <h3>${esc(r.name)}</h3><p class="place">${esc(r.address)} · <b>${esc(fmtDist(r.d))}</b></p>
        ${food.mode === 'tutti' ? '<p class="note">Posto per 23 da verificare: chiama o prenota prima di muovere il gruppo.</p>' : ''}
        <div class="actions">${extLink(r.mapsUri || mapsPlace({ name: r.name, address: r.address }), 'Apri in Maps', 'btn primary')}${r.phone ? `<a class="btn" href="tel:${esc(r.phone.replace(/[^\d+]/g, ''))}">Chiama ${esc(r.phone)}</a>` : ''}</div></article>`).join('');
  }
  function viewCibo() {
    const booked = sortActs(data.activities.filter((a) => a.type === 'pasto' && a.status === 'prenotato' && a.date >= nowNY().date));
    const fb = data.config.foodFallback || [];
    const sel = (k, opts) => `<select data-food="${k}">${opts.map(([v, l]) => `<option value="${v}"${String(food[k]) === String(v) ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
    const chk = (k, l) => `<label class="field check"><input type="checkbox" data-food="${k}"${food[k] ? ' checked' : ''}><span>${l}</span></label>`;
    const offline = net === 'offline';
    const cant = offline ? 'Senza rete non posso cercare locali aperti adesso: orari e disponibilità richiedono la connessione.'
      : !data.foodSearch ? 'La ricerca dal vivo non è ancora attiva su questo server (manca la chiave Google Places).' : '';
    return `<div class="hero"><h1>TrovaCibo</h1><p>Cucina americana e street food nei dintorni, intorno ai 30–40 $ a persona. Tasse, mancia e bevande possono essere escluse.</p></div>
      <div class="seg" role="group" aria-label="Quanti siete"><button class="${food.mode === 'pochi' ? 'on' : ''}" data-act="food-mode" data-mode="pochi">Siamo pochi</button><button class="${food.mode === 'tutti' ? 'on' : ''}" data-act="food-mode" data-mode="tutti">Siamo in 23</button></div>
      ${food.mode === 'tutti' ? '<div class="alert plain"><b>In 23 è un\'altra storia.</b> Vicinanza e prezzo non garantiscono un tavolo per tutti: chiamate prima, oppure dividetevi per famiglie in locali vicini.</div>' : ''}
      ${booked.length ? `<h2>Già prenotato nel programma</h2>${booked.map((a) => actCard(a, { showDay: true })).join('')}` : ''}
      <h2>Cerca nei dintorni</h2>
      ${cant ? `<div class="alert plain">${cant}</div>` : `
      <div class="filters">
        <label class="field"><span>Partendo da</span>${sel('origin', [['me', 'La mia posizione'], ['hotel', 'Hotel']])}</label>
        <label class="field"><span>Raggio</span>${sel('radius', [[300, '300 m'], [600, '600 m'], [1000, '1 km'], [2000, '2 km']])}</label>
        <label class="field"><span>Categoria</span>${sel('cat', [['tutte', 'Tutte le preferite'], ['diner', 'Diner'], ['burger', 'Hamburger'], ['bbq', 'Barbecue'], ['sandwich', 'Sandwich e deli'], ['street', 'Street food']])}</label>
        <div>${chk('open', 'Aperto ora')}${chk('price', 'Fino a $$')}${chk('kids', 'Adatto ai ragazzi')}</div>
      </div>
      <button class="btn primary block" data-act="food-go"${food.busy ? ' disabled' : ''}>Cerca</button>
      <p class="meta">La posizione viene usata solo quando premi «Cerca». Escluse cucina italiana e cucine orientali; il messicano resta.</p>
      <div id="food-results">${foodResultsHtml()}</div>`}
      <h2>Opzioni salvate dal gruppo</h2>
      ${fb.length ? `<p class="lead">Scelte in anticipo, consultabili anche senza rete. Verificate apertura e posto al momento.</p>${fb.map((r) => `<article class="card"><h3>${esc(r.name)}</h3><p class="place">${esc(r.address)}</p>${r.note ? `<p class="note">${esc(r.note)}</p>` : ''}
        <div class="actions">${extLink(mapsPlace(r), 'Apri in Maps')}</div></article>`).join('')}`
      : '<p class="lead">Gli amministratori non hanno ancora salvato opzioni di emergenza.</p>'}`;
  }

  function viewInfo() {
    const h = data.trip.hotel;
    return `<div class="hero"><h1>Info pratiche</h1></div>
      <article class="card"><div class="times">Il nostro hotel</div><h3>${esc(h.name)}</h3><p class="place">${esc(h.address)}</p>
        <p class="note">Indirizzo da mostrare a un tassista: <b>${esc(h.address)}</b></p>
        <div class="actions">${extLink(mapsDir({ placeName: h.name, address: h.address }), 'Portami in hotel', 'btn primary')}</div></article>
      <article class="card"><div class="times">Emergenze negli Stati Uniti</div><h3>911</h3><p class="place">Polizia, ambulanza, vigili del fuoco.</p>
        <div class="actions"><a class="btn danger" href="tel:911">Chiama il 911</a></div></article>
      ${data.config.infoNotes ? `<article class="card"><div class="times">Note del gruppo</div><p class="desc">${esc(data.config.infoNotes)}</p></article>` : ''}
      <h2>Cosa funziona senza rete</h2>
      <article class="card"><table class="plain">
        <tr><td>Programma, tappe, curiosità, hotel</td><td>Sì, nell'ultima copia scaricata${fetchedAt ? ` (${esc(fmtInstant(fetchedAt))})` : ''}.</td></tr>
        <tr><td>«Mi interessa» e luoghi visti</td><td>Sì, restano su questo telefono.</td></tr>
        <tr><td>Distanza dalle curiosità</td><td>Sì, se il GPS è attivo e hai dato il permesso.</td></tr>
        <tr><td>Ricerca ristoranti</td><td>No: serve la rete. Restano le opzioni salvate dal gruppo.</td></tr>
        <tr><td>Google Maps</td><td>Solo se hai scaricato prima l'area offline nell'app Maps.</td></tr>
        <tr><td>Google Calendar</td><td>Serve la rete; in alternativa il file .ics.</td></tr>
      </table></article>
      <p class="lead">Suggerimento: prima di partire apri l'app una volta con la rete e, in Google Maps, scarica l'area di New York.</p>
      <h2>Riservatezza</h2>
      <p class="lead">Chiunque abbia il link può leggere queste pagine: per questo non contengono biglietti, numeri di prenotazione o dati personali. La tua posizione non lascia il telefono, tranne le coordinate inviate quando premi «Cerca» in TrovaCibo.</p>
      ${data.readOnly ? '<div class="alert plain">Su questo server il programma è in sola lettura: le modifiche degli amministratori non sono ancora attive.</div>' : ''}
      <p class="meta">Versione del programma: ${data.version} · aggiornato il ${esc(fmtInstant(data.updatedAt))}</p>
      <div class="actions">${admin ? '<a class="btn" href="#/admin">Pannello amministratore</a>' : '<button class="btn small" data-act="login">Accesso amministratori</button>'}
        <button class="btn small" data-act="reload">Aggiorna ora</button></div>`;
  }

  function viewAdmin() {
    if (!admin) return `<div class="hero"><h1>Amministrazione</h1><p>Serve il codice amministratore.</p></div><div class="actions"><button class="btn primary" data-act="login">Inserisci il codice</button></div>`;
    const cfg = data.config;
    const drafts = data.pois.filter((p) => !p.published).length;
    const hist = !adminLog ? '<p class="lead">Carico la cronologia…</p>' : adminLog.changes.length ? `<ul class="hist">${adminLog.changes.slice().reverse().map((c) => {
      const what = c.action === 'create' ? 'creato' : c.action === 'delete' ? 'eliminato' : (c.fields || []).map((f) => `${ADMIN_FIELD_L[f.f] || f.f}: ${String(f.before).slice(0, 60) || '—'} → ${String(f.after).slice(0, 60) || '—'}`).join(' · ');
      return `<li><b>${esc(c.title)}</b> — ${esc(what)}<br><span class="who">v${c.v} · ${esc(c.author)} · ${esc(fmtInstant(c.at))}</span>
        ${adminLog.snapshots.includes(c.v - 1) ? ` <button class="btn small" data-act="restore" data-v="${c.v - 1}">Ripristina com'era prima</button>` : ''}</li>`;
    }).join('')}</ul>` : '<p class="lead">Nessuna modifica finora.</p>';
    return `<div class="hero"><h1>Amministrazione</h1><p>Accesso di ${esc(admin.name)} · la sessione scade alle ${esc(new Date(admin.exp).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }))}</p></div>
      <div class="actions"><button class="btn primary" data-act="new-activity">+ Nuova attività</button><button class="btn" data-act="new-poi">+ Nuovo punto di interesse</button></div>
      <p class="lead">Per modificare una tappa o una curiosità usa «✎ Modifica» sulla sua scheda. ${drafts ? `Ci sono ${drafts} schede in bozza, visibili solo a voi in «Vicino a me».` : ''}</p>
      <h2>TrovaCibo e note</h2>
      <form class="card" data-form="config">
        <label class="field"><span>Tipi di cucina esclusi (nomi Google Places, separati da virgola)</span><textarea name="excludedTypes">${esc((cfg.excludedTypes || []).join(', '))}</textarea></label>
        <label class="field"><span>Opzioni di emergenza per il cibo, una per riga: Nome | Indirizzo | Nota</span><textarea name="foodFallback">${esc((cfg.foodFallback || []).map((r) => [r.name, r.address, r.note].join(' | ')).join('\n'))}</textarea></label>
        <label class="field"><span>Note del gruppo (sezione Info)</span><textarea name="infoNotes">${esc(cfg.infoNotes || '')}</textarea><small>Pagina pubblica: niente dati personali, biglietti o numeri di prenotazione.</small></label>
        <p class="err" hidden></p><button class="btn primary">Salva impostazioni</button></form>
      <h2>Cronologia delle modifiche</h2><article class="card">${hist}</article>
      <h2>Accesso</h2>
      <div class="actions"><button class="btn" data-act="rotate">Cambia il mio codice</button><button class="btn" data-act="logout">Esci</button></div>
      <p class="meta">Per aggiungere o revocare il secondo amministratore: sul server, <code>node server.js admin add|revoke &lt;nome&gt;</code>.</p>`;
  }

  function render() {
    renderTop(); renderTabs();
    const main = $('#view');
    if (!data) {
      main.innerHTML = net === 'offline' ? '<p class="empty">Nessuna copia del programma su questo telefono. Apri l\'app una volta con la rete per scaricarla.</p>' : '<p class="empty">Caricamento…</p>';
      return;
    }
    const v = view();
    const views = { oggi: viewOggi, programma: viewProgramma, vicino: viewVicino, cibo: viewCibo, info: viewInfo, admin: viewAdmin };
    const y = window.scrollY;
    const simBar = sim() ? `<div class="sim"><span>Simulazione: a New York è ${esc(sim().replace('T', ' '))}</span><button data-act="sim-off">Esci</button></div>` : '';
    main.innerHTML = simBar + (views[v.name] || viewOggi)(v);
    if (render.last === location.hash) window.scrollTo(0, y); else window.scrollTo(0, 0);
    render.last = location.hash;
    const target = v.name === 'programma' && v.b ? $('#act-' + CSS.escape(v.b)) : v.name === 'vicino' && v.a ? $('#poi-' + CSS.escape(v.a)) : null;
    if (target && render.flashed !== location.hash) { render.flashed = location.hash; target.scrollIntoView({ block: 'center' }); target.classList.add('flash'); }
    if (v.name === 'admin' && admin && !adminLog) loadHistory();
  }
  async function loadHistory() {
    try { adminLog = await api('/api/admin/history'); if (view().name === 'admin') render(); } catch { /* sessione scaduta: gestita in api() */ }
  }

  // ---------- finestre ----------
  const sheet = $('#sheet');
  function openSheet(html) { sheet.innerHTML = `<div class="sheet">${html}</div>`; if (!sheet.open) sheet.showModal(); }
  const closeSheet = () => { if (sheet.open) sheet.close(); };
  sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSheet(); });

  function calSheet(a) {
    openSheet(`<h2>Aggiungi al calendario</h2><p class="lead"><b>${esc(a.title)}</b><br>${esc(fmtDay(a.date))} · ${timesHtml(a)} (ora di New York)${a.endTime || !startOf(a) ? '' : ' · fine stimata dopo 90 minuti'}</p>
      <div class="alert plain">È una copia personale: se il programma cambia, l'evento nel tuo calendario <b>non si aggiorna da solo</b>. Controlla l'avviso «Cambio di programma» e, se serve, aggiungilo di nuovo.</div>
      <div class="actions">${extLink(gcalUrl(a), 'Apri in Google Calendar', 'btn primary')}<button class="btn" data-act="ics" data-id="${esc(a.id)}">Scarica file .ics</button></div>
      <p class="meta">Google Calendar ti chiederà di confermare prima di salvare.</p>
      <div class="foot"><button class="btn" data-act="close">Chiudi</button></div>`);
  }

  function routeLinks(stops, start) {
    const hotel = { placeName: data.trip.hotel.name, address: data.trip.hotel.address };
    let origin = null, rest = stops;
    if (start === 'hotel') origin = hotel;
    else if (start !== 'me') { const i = Number(start); origin = stops[i]; rest = stops.slice(i + 1); }
    if (!rest.length) return `<p class="lead">È l'ultima tappa della fascia.</p>${extLink(mapsPlace(origin), 'Apri il luogo in Maps')}`;
    const out = [];
    let from = origin, n = 1;
    for (let i = 0; i < rest.length; i += 4) {
      const leg = rest.slice(i, i + 4);
      const q = new URLSearchParams({ api: '1', destination: locStr(leg[leg.length - 1]) });
      if (from) q.set('origin', locStr(from));
      if (leg.length > 1) q.set('waypoints', leg.slice(0, -1).map(locStr).join('|'));
      const label = `${rest.length > 4 ? `Tratto ${n}: ` : ''}${from ? esc(from.title || from.placeName) : 'da dove sei'} → ${esc(leg[leg.length - 1].title)}${leg.length > 1 ? ` (${leg.length} tappe)` : ''}`;
      out.push(extLink('https://www.google.com/maps/dir/?' + q, label, 'btn primary block'));
      from = leg[leg.length - 1]; n++;
    }
    return out.join('');
  }
  function routeSheet(day) {
    const stops = dayActs(day).filter((a) => included(a) && stopOf(a));
    const groups = {};
    for (const a of stops) (groups[fascia(a)] ||= []).push(stopOf(a));
    const body = Object.entries(groups).map(([f, list]) => `<h3 class="fascia">${f}</h3>
      <label class="field"><span>Parto da</span><select data-route="${esc(f)}"><option value="me">La mia posizione</option><option value="hotel">Hotel</option>${list.map((a, i) => `<option value="${i}">${esc(a.title)}</option>`).join('')}</select></label>
      <div class="actions" data-route-links="${esc(f)}">${routeLinks(list, 'me')}</div>`).join('');
    routeSheet.groups = groups;
    openSheet(`<h2>Percorso · ${esc(fmtDay(day))}</h2>
      ${body || '<p class="lead">Per questo giorno non ci sono ancora tappe con un indirizzo.</p>'}
      ${body ? '<p class="meta">Maps si apre a tratti di poche tappe. Con più fermate non propone i mezzi pubblici: per la metropolitana apri una tappa alla volta con «Portami qui». Contano le attività per tutti e quelle segnate «Mi interessa».</p>' : ''}
      <div class="foot"><button class="btn" data-act="close">Chiudi</button></div>`);
  }

  const dayOpts = () => tripDays().map((d) => [d, fmtDay(d, { weekday: 'short', day: 'numeric', month: 'short' })]);
  const FORMS = {
    activity: () => [
      ['title', 'Titolo', 'text'], ['date', 'Giorno', 'select', dayOpts()],
      ['type', 'Tipo', 'select', Object.entries(TYPE_L)], ['status', 'Stato', 'select', Object.entries(STATUS_L)],
      ['audience', 'Destinatari', 'select', Object.entries(AUD_L)], ['audienceNote', 'Nota sui destinatari', 'text', null, 'Es. «3 persone». Niente nomi.'],
      ['meetTime', 'Ora di ritrovo', 'time'], ['time', 'Ora di inizio', 'time'],
      ['meetPlace', 'Punto di ritrovo', 'text', null, 'Se diverso dal luogo della visita.'], ['endTime', 'Ora di fine (stima)', 'time'],
      ['placeName', 'Luogo', 'text'], ['address', 'Indirizzo', 'text'],
      ['lat', 'Latitudine', 'num'], ['lng', 'Longitudine', 'num'],
      ['coordsVerified', 'Coordinate verificate (Maps userà queste)', 'bool'], ['order', 'Ordine nel giorno', 'num'],
      ['description', 'Descrizione', 'area'], ['transportNote', 'Note sui trasporti', 'text'],
      ['voucherUrl', 'Link al voucher', 'text', null, 'Pagina pubblica: non collegare PDF di biglietti o numeri di prenotazione.'],
    ],
    poi: () => [
      ['name', 'Nome', 'text'], ['category', 'Categoria', 'select', Object.entries(CAT_L)],
      ['linkType', 'Tipo di legame', 'select', Object.entries(LINK_L), 'Non chiamare «set» un luogo solo citato in un film.'], ['work', 'Film, serie o opera', 'text'],
      ['address', 'Indirizzo', 'text'], ['zone', 'Zona', 'text'],
      ['lat', 'Latitudine', 'num'], ['lng', 'Longitudine', 'num'],
      ['coordsVerified', 'Coordinate verificate', 'bool'], ['radius', 'Raggio di segnalazione (m)', 'num'],
      ['context', 'Racconto breve', 'area'], ['note', 'Nota pratica', 'text'],
      ['source', 'Fonte', 'text'], ['lastVerified', 'Ultima verifica', 'date'],
      ['published', 'Pubblicata (visibile a tutti)', 'bool'], ['alertsEnabled', 'Segnala quando si è vicini', 'bool', null, 'Vale solo con coordinate verificate.'],
      ['linkedActivityId', 'Arricchisce la tappa', 'select', [['', '— nessuna —'], ...sortActs(data.activities).map((a) => [a.id, `${a.date.slice(8)} dic · ${a.title}`])]],
    ],
  };
  const DEFAULTS = {
    activity: { type: 'visita', status: 'proposto', audience: 'tutti', order: 50 },
    poi: { category: 'film', linkType: 'ambientazione', radius: 250, published: false, alertsEnabled: false },
  };
  function editSheet(kind, item, preset = {}) {
    const orig = item || { ...DEFAULTS[kind], ...preset };
    const fields = FORMS[kind]().map(([k, label, type, opts, hint]) => {
      const v = orig[k] ?? '';
      const small = hint ? `<small>${esc(hint)}</small>` : '';
      if (type === 'bool') return `<label class="field check"><input type="checkbox" name="${k}"${v ? ' checked' : ''}><span>${esc(label)}</span></label>`;
      if (type === 'select') return `<label class="field"><span>${esc(label)}</span><select name="${k}">${opts.map(([val, l]) => `<option value="${esc(val)}"${val === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>${small}</label>`;
      if (type === 'area') return `<label class="field"><span>${esc(label)}</span><textarea name="${k}">${esc(v)}</textarea>${small}</label>`;
      const attrs = type === 'num' ? 'type="number" step="any" inputmode="decimal"' : type === 'time' ? 'type="time"' : type === 'date' ? 'type="date"' : 'type="text"';
      return `<label class="field"><span>${esc(label)}</span><input ${attrs} name="${k}" value="${esc(v)}">${small}</label>`;
    }).join('');
    editSheet.ctx = { kind, item, fields: FORMS[kind]() };
    openSheet(`<form data-form="edit"><h2>${item ? 'Modifica' : 'Nuova'} ${kind === 'activity' ? 'attività' : 'curiosità'}</h2>
      <div class="grid2">${fields}</div><p class="err" hidden></p>
      <div class="foot">${item ? '<button type="button" class="btn danger" data-act="delete">Elimina</button>' : ''}<button type="button" class="btn" data-act="close">Annulla</button><button class="btn primary">Salva</button></div></form>`);
  }
  function loginSheet() {
    openSheet(`<form data-form="login"><h2>Accesso amministratori</h2><p class="lead">Il codice viene verificato sul server e non resta salvato su questo telefono.</p>
      <label class="field"><span>Codice amministratore</span><input name="code" type="password" autocomplete="off" autocapitalize="characters" required></label>
      <p class="err" hidden></p><div class="foot"><button type="button" class="btn" data-act="close">Annulla</button><button class="btn primary">Entra</button></div></form>`);
    $('input', sheet).focus();
  }

  // ---------- azioni ----------
  const showErr = (form, msg) => { const p = $('.err', form); p.textContent = msg; p.hidden = false; };
  async function saved(msg) { adminLog = null; closeSheet(); await refresh(); toast(msg); }

  document.addEventListener('submit', async (e) => {
    const form = e.target.closest('form[data-form]');
    if (!form) return;
    e.preventDefault();
    const fd = new FormData(form);
    try {
      if (form.dataset.form === 'login') {
        const a = await api('/api/admin/login', { method: 'POST', body: { code: fd.get('code') } });
        setAdmin(a); closeSheet(); await refresh(); location.hash = '#/admin'; toast(`Ciao ${a.name}: ora puoi modificare il programma.`);
      } else if (form.dataset.form === 'edit') {
        const { kind, item, fields } = editSheet.ctx;
        const body = {};
        for (const [k, , type] of fields) {
          const el = form.elements[k];
          const v = type === 'bool' ? el.checked : type === 'num' ? (el.value === '' ? null : Number(el.value)) : el.value.trim();
          const before = item ? (item[k] ?? (type === 'bool' ? false : type === 'num' ? null : '')) : undefined;
          if (!item || v !== before) body[k] = v;
        }
        const base = kind === 'activity' ? '/api/activities' : '/api/pois';
        if (item && !Object.keys(body).length) return closeSheet();
        await api(item ? `${base}/${item.id}` : base, { method: item ? 'PUT' : 'POST', body });
        await saved('Salvato. Chi apre l\'app vedrà l\'aggiornamento.');
      } else if (form.dataset.form === 'config') {
        const body = {
          excludedTypes: String(fd.get('excludedTypes')).split(/[,\n]/).map((s) => s.trim()).filter(Boolean),
          foodFallback: String(fd.get('foodFallback')).split('\n').map((l) => l.split('|').map((s) => s.trim())).filter((p) => p[0]).map(([name, address = '', note = '']) => ({ name, address, note })),
          infoNotes: String(fd.get('infoNotes')),
        };
        await api('/api/config', { method: 'PUT', body });
        await saved('Impostazioni salvate.');
      }
    } catch (err) { showErr(form, err.message); }
  });

  const ACTIONS = {
    seen() { LS.set('seenVersion', data.version); render(); },
    day(el) { location.hash = '#/programma/' + el.dataset.day; },
    'only-mine'() { onlyMine = !onlyMine; LS.set('onlyMine', onlyMine); render(); },
    interest(el) { const id = el.dataset.id; if (interest[id]) delete interest[id]; else interest[id] = true; LS.set('interest', interest); render(); },
    cal(el) { calSheet(data.activities.find((a) => a.id === el.dataset.id)); },
    ics(el) {
      const a = data.activities.find((x) => x.id === el.dataset.id);
      const url = URL.createObjectURL(new Blob([icsFor(a)], { type: 'text/calendar' }));
      const link = Object.assign(document.createElement('a'), { href: url, download: a.title.replace(/[^\p{L}\d]+/gu, '-').slice(0, 40) + '.ics' });
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
    },
    route(el) { routeSheet(el.dataset.day); },
    close: closeSheet,
    'geo-start': startWatch, 'geo-stop': stopWatch,
    mute() { muted = !muted; LS.set('muted', muted); near = []; render(); toast(muted ? 'Segnalazioni silenziate.' : 'Segnalazioni riattivate.'); },
    'near-ok'() { near = []; render(); },
    cat(el) { const c = el.dataset.cat; hiddenCats = hiddenCats.includes(c) ? hiddenCats.filter((x) => x !== c) : [...hiddenCats, c]; LS.set('hiddenCats', hiddenCats); render(); },
    'poi-seen'(el) { const id = el.dataset.id; if (poiSeen[id]) delete poiSeen[id]; else poiSeen[id] = true; LS.set('poiSeen', poiSeen); render(); },
    'food-mode'(el) { food.mode = el.dataset.mode; render(); },
    async 'food-go'() {
      food.busy = true; food.err = ''; render();
      try {
        const c = food.origin === 'hotel' ? { lat: data.trip.hotel.lat, lng: data.trip.hotel.lng } : await getPos();
        const q = new URLSearchParams({ lat: c.lat.toFixed(5), lng: c.lng.toFixed(5), radius: food.radius, cat: food.cat });
        const r = await api('/api/food?' + q);
        food.results = r.results; food.at = r.at; food.center = c;
      } catch (err) { food.err = err instanceof TypeError ? 'Senza rete non posso cercare: guarda le opzioni salvate dal gruppo qui sotto.' : err.message; food.results = null; }
      food.busy = false; render();
    },
    login: loginSheet,
    async logout() { await api('/api/admin/logout', { method: 'POST' }).catch(() => {}); setAdmin(null); adminLog = null; location.hash = '#/info'; await refresh(); },
    async rotate() {
      if (!confirm('Generare un nuovo codice? Quello attuale smetterà subito di funzionare.')) return;
      try { const r = await api('/api/admin/rotate', { method: 'POST' }); setAdmin({ token: r.token, name: r.name, exp: r.exp }); openSheet(`<h2>Il tuo nuovo codice</h2><p class="lead">Annotalo adesso: non verrà più mostrato.</p><p class="code">${esc(r.code)}</p><div class="foot"><button class="btn primary" data-act="close">L'ho annotato</button></div>`); }
      catch (err) { toast(err.message); }
    },
    async restore(el) {
      if (!confirm('Ripristinare il programma com\'era prima di questa modifica? Anche le modifiche successive verranno annullate.')) return;
      try { await api('/api/admin/restore', { method: 'POST', body: { version: Number(el.dataset.v) } }); await saved('Versione ripristinata.'); } catch (err) { toast(err.message); }
    },
    'new-activity'(el) { editSheet('activity', null, el.dataset.day ? { date: el.dataset.day } : {}); },
    'new-poi'() { editSheet('poi', null); },
    'edit-activity'(el) { editSheet('activity', data.activities.find((a) => a.id === el.dataset.id)); },
    'edit-poi'(el) { editSheet('poi', data.pois.find((p) => p.id === el.dataset.id)); },
    async delete() {
      const { kind, item } = editSheet.ctx;
      if (!confirm(`Eliminare «${item.title || item.name}»? Potrai ripristinarla dalla cronologia.`)) return;
      try { await api(`${kind === 'activity' ? '/api/activities' : '/api/pois'}/${item.id}`, { method: 'DELETE' }); await saved('Eliminata.'); } catch (err) { showErr($('form', sheet), err.message); }
    },
    reload() { refresh().then(() => toast(net === 'offline' ? 'Senza rete: resta la copia salvata.' : 'Programma aggiornato.')); },
    'sim-off'() { sessionStorage.removeItem('nyc.sim'); history.replaceState(null, '', location.pathname + location.hash); render(); },
  };
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (el && ACTIONS[el.dataset.act]) { e.preventDefault(); ACTIONS[el.dataset.act](el); }
  });
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.food) {
      food[t.dataset.food] = t.type === 'checkbox' ? t.checked : t.dataset.food === 'radius' ? Number(t.value) : t.value;
      const box = $('#food-results'); if (box && t.type === 'checkbox') box.innerHTML = foodResultsHtml();
    }
    if (t.dataset.route) $(`[data-route-links="${CSS.escape(t.dataset.route)}"]`, sheet).innerHTML = routeLinks(routeSheet.groups[t.dataset.route], t.value);
  });

  // ---------- avvio ----------
  let lastNav = 0;
  window.addEventListener('hashchange', () => {
    render();
    if (Date.now() - lastNav > 20000) { lastNav = Date.now(); refresh(true); } // cambiando sezione si controlla se c'è una versione nuova
  });
  window.addEventListener('online', () => refresh());
  window.addEventListener('offline', () => { net = 'offline'; render(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(true); });
  setInterval(() => { if (!document.hidden) refresh(true); }, 120000);
  setInterval(renderTop, 30000);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  render();
  refresh();
})();

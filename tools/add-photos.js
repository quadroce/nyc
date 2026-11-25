// Aggiunge alle curiosità una foto del luogo presa da Wikimedia Commons (solo licenze libere),
// con autore e licenza. Le foto restano sui server Wikimedia: nel seed finiscono solo indirizzo e crediti.
// Uso: node tools/add-photos.js   (richiede la rete; si può rilanciare)
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'data', 'seed.json');
const seed = JSON.parse(fs.readFileSync(file, 'utf8'));
const UA = { 'User-Agent': 'trip-guide-photo-credits/1.0 (script una tantum)' };

// id della scheda -> voce di Wikipedia in inglese di cui usare l'immagine principale
const MAP = {
  'p-ghostbusters': 'Firehouse, Hook & Ladder Company 8', 'p-waldorf': 'Waldorf Astoria New York', 'p-msg': 'Madison Square Garden',
  'p-ellis': 'Ellis Island', 'p-911': 'National September 11 Memorial & Museum', 'p-brooklyn-bridge': 'Brooklyn Bridge',
  'p-grand-central-storia': 'Grand Central Terminal', 'p-rockefeller': 'Rockefeller Center', 'p-st-patrick': "St. Patrick's Cathedral (Midtown Manhattan)",
  'p-top-of-the-rock': '30 Rockefeller Plaza', 'p-wollman': 'Wollman Rink', 'p-tramway': 'Roosevelt Island Tramway', 'p-bryant-park': 'Bryant Park',
  'p-nypl-leoni': 'New York Public Library Main Branch', 'p-liberty': 'Statue of Liberty', 'p-dumbo': 'Dumbo, Brooklyn', 'p-chelsea-market': 'Chelsea Market',
  'p-high-line': 'High Line', 'p-dyker': 'Dyker Heights, Brooklyn', 'p-amnh': 'American Museum of Natural History',
  'p-marvel-grand-central': 'Park Avenue Viaduct', 'p-marvel-times-square': 'Times Square', 'p-marvel-bleecker': 'Bleecker Street',
  'p-citigroup': 'Citigroup Center', 'p-greenacre': 'Greenacre Park', 'p-track61': 'Track 61 (New York City)', 'p-palace': 'Lotte New York Palace Hotel',
  'p-daily-news': 'Daily News Building', 'p-tudor-city': 'Tudor City', 'p-onu': 'Headquarters of the United Nations',
  'p-roosevelt-hotel': 'The Roosevelt Hotel (Manhattan)', 'p-metlife': 'MetLife Building', 'p-st-regis': 'St. Regis New York', 'p-radio-city': 'Radio City Music Hall',
  'p-albero': 'Rockefeller Center Christmas Tree', 'p-pranzo-trave': 'Lunch atop a Skyscraper', 'p-fao': 'FAO Schwarz', 'p-prada': '1221 Avenue of the Americas',
  'p-moma': 'Museum of Modern Art', 'p-tiffany': 'Tiffany & Co. flagship store', 'p-plaza': 'Plaza Hotel', 'p-carnegie': 'Carnegie Hall',
  'p-times-nome': 'One Times Square', 'p-macys': "Macy's Herald Square", 'p-empire': 'Empire State Building', 'p-hells-kitchen': "Hell's Kitchen, Manhattan",
  'p-zoo': 'Central Park Zoo', 'p-balto': 'Statue of Balto', 'p-bethesda': 'Bethesda Terrace and Fountain',
  'p-strawberry': 'Strawberry Fields (memorial)', 'p-frick': 'Henry Clay Frick House', 'p-san-remo': 'The San Remo', 'p-dana': '55 Central Park West',
  'p-lincoln-center': 'Lincoln Center for the Performing Arts', 'p-zabars': "Zabar's", 'p-serendipity': 'Serendipity 3', 'p-flatiron': 'Flatiron Building',
  'p-casa-stretta': '75½ Bedford Street', 'p-washington-square': 'Washington Square Arch', 'p-katz': "Katz's Delicatessen",
  'p-old-st-patrick': "St. Patrick's Old Cathedral", 'p-mott': 'Mott Street', 'p-lombardis': "Lombardi's Pizza", 'p-yancy': 'Delancey Street',
  'p-mib': 'Brooklyn–Battery Tunnel', 'p-toro': 'Charging Bull', 'p-castle-clinton': 'Castle Clinton', 'p-wall-street': 'Wall Street',
  'p-federal-hall': 'Federal Hall', 'p-continental': '1 Wall Street Court',
  'p-kevin-torri': 'World Trade Center (1973–2001)', 'p-leone': 'Manhattan Bridge', 'p-nintendo': 'Nintendo New York',
  'p-dh-fed': 'Federal Reserve Bank of New York Building', 'p-dh-oneill': "O'Neill Building", 'p-dh-72': '72nd Street station (IRT Broadway–Seventh Avenue Line)',
  'p-dh-tompkins': 'Tompkins Square Park', 'p-dh-yankee': 'Yankee Stadium', 'p-columbia': 'Low Memorial Library', 'p-oscorp': '135 East 57th Street',
  'p-hawkeye': 'The Rink at Rockefeller Center', 'p-toms': "Tom's Restaurant", 'p-soup': 'The Original Soupman', 'p-mad-men': '1271 Avenue of the Americas',
  'p-snl': 'Studio 8H', 'p-arconia': 'The Belnord', 'p-tribunale': 'New York County Courthouse', 'p-magnolia': 'Magnolia Bakery', 'p-bloomingdales': "Bloomingdale's",
  'p-met': 'Metropolitan Museum of Art', 'p-guggenheim': 'Solomon R. Guggenheim Museum', 'p-copa': 'Copacabana (nightclub)',
  'p-panchina': 'Queensboro Bridge', 'p-tavern': 'Tavern on the Green', 'p-columbus-circle': 'Columbus Circle', 'p-joker': 'Joker Stairs',
  'p-barchette': 'Conservatory Water', 'p-macusa': 'Woolworth Building', 'p-joes': "Joe's Pizza", 'p-infinity': 'Washington Square Park',
  'p-seagram': 'Seagram Building', 'p-smith-wollensky': 'Smith & Wollensky', 'p-birdman': 'St. James Theatre', 'p-sardis': "Sardi's",
  'p-saranno-famosi': 'Church of St. Mary the Virgin (Manhattan)', 'p-tootsie': 'Russian Tea Room', 'p-pierre': 'The Pierre',
  'p-maisel': 'B. Altman and Company Building', 'p-empire-hotel': 'The Empire Hotel (New York City)', 'p-fontana-friends': 'Cherry Hill Fountain',
  'p-bow-bridge': 'Bow Bridge (Central Park)', 'p-mall': 'Central Park Mall', 'p-belvedere': 'Belvedere Castle', 'p-suits': 'Citigroup Center', 'p-ponte-film': 'Brooklyn Bridge',
  'p-dakota': 'The Dakota', 'p-reggio': 'Caffe Reggio', 'p-ferry': 'Staten Island Ferry', 'p-succession': '28 Liberty Street', 'p-gotham': '23 Wall Street',
  'p-vigo': 'Alexander Hamilton U.S. Custom House', 'p-barnum': "Barnum's American Museum",
  'p-twa': 'TWA Flight Center', 'p-mib-dischi': 'New York State Pavilion', 'p-guerrieri': 'Wonder Wheel', 'p-elf-tunnel': 'Lincoln Tunnel',
};

// id della scheda -> ricerca diretta su Wikimedia Commons (quando la voce di Wikipedia non ha un'immagine adatta)
const SEARCH = {
  'p-gapstow': 'Gapstow Bridge Central Park',
  'p-rockefeller': 'Rockefeller Center Channel Gardens',
  'p-metlife': 'MetLife Building Park Avenue',
  'p-macusa': 'Woolworth Building New York',
  'p-fao': 'FAO Schwarz Rockefeller Plaza store',
  'p-mib': 'Brooklyn Battery Tunnel ventilation building Battery Place',
  'p-hawkeye': 'Rockefeller Center ice rink Prometheus',
  'p-dyker': 'Dyker Heights Christmas lights',
  'p-friends': '90 Bedford Street Friends building',
  'p-carrie': '66 Perry Street',
  'p-marilyn': 'Lexington Avenue 52nd Street subway grate Marilyn',
  'p-boathouse': 'Loeb Boathouse Central Park',
  'p-posta-giardino': '91st Street Garden Riverside Park',
  'p-tata': '7 East 75th Street Manhattan',
  'p-robinson': "St. Luke's Place Manhattan",
};

// id della scheda -> file preciso di Commons (controllato a vista)
const FILES = {
  'p-chrysler': 'File:Chrysler Building by David Shankbone Retouched.jpg',
  'p-five-points': 'File:Five Points - George Catlin - 1827.jpg',
};

const api = async (host, params) => {
  const res = await fetch(`https://${host}/w/api.php?` + new URLSearchParams({ format: 'json', formatversion: '2', ...Object.fromEntries(Object.entries(params).filter(([k]) => k !== '_try')) }), { headers: UA });
  if (res.status === 429 && (params._try || 0) < 4) { // troppe richieste: aspetta e riprova
    await sleep(4000 * ((params._try || 0) + 1));
    return api(host, { ...params, _try: (params._try || 0) + 1 });
  }
  if (!res.ok) throw new Error(`${host} ${res.status}`);
  return res.json();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chunks = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));
const strip = (html) => String(html || '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
const FREE = /^(cc0|cc[ -]by|public domain|pd\b|no restrictions|attribution)/i;
const BAD_NAME = /logo|map|locator|seal|coat of arms|icon|\.svg$/i;

(async () => {
  // 1. immagine principale di ogni voce
  const titles = [...new Set(Object.values(MAP))];
  const lead = new Map(); // titolo richiesto -> { file, thumb }
  for (const group of chunks(titles, 40)) {
    const j = await api('en.wikipedia.org', { action: 'query', titles: group.join('|'), redirects: '1', prop: 'pageimages', piprop: 'thumbnail|name', pithumbsize: '500', pilimit: '50' });
    const back = new Map(); // titolo finale -> titolo richiesto
    for (const t of group) back.set(t, t);
    for (const n of j.query.normalized || []) back.set(n.to, back.get(n.from) || n.from);
    for (const r of j.query.redirects || []) back.set(r.to, back.get(r.from) || r.from);
    for (const p of j.query.pages || []) if (p.pageimage && p.thumbnail) lead.set(back.get(p.title) || p.title, { file: p.pageimage, thumb: p.thumbnail.source });
  }
  // 2. licenza e autore su Commons: restano solo i file presenti lì con licenza libera
  const info = new Map();
  for (const group of chunks([...new Set([...lead.values()].map((v) => v.file))], 40)) {
    const j = await api('commons.wikimedia.org', { action: 'query', titles: group.map((f) => 'File:' + f).join('|'), prop: 'imageinfo', iiprop: 'extmetadata|url' });
    const norm = new Map((j.query.normalized || []).map((n) => [n.to, n.from]));
    for (const p of j.query.pages || []) {
      const ii = p.imageinfo && p.imageinfo[0];
      if (!ii || p.missing) continue;
      const m = ii.extmetadata || {};
      const key = (norm.get(p.title) || p.title).replace(/^File:/, '');
      info.set(key, { license: strip(m.LicenseShortName && m.LicenseShortName.value), author: strip(m.Artist && m.Artist.value).slice(0, 80), page: ii.descriptionurl });
      info.set(key.replace(/ /g, '_'), info.get(key));
    }
  }
  // 2b. ricerche dirette su Commons: primo JPEG con licenza libera
  const found = new Map();
  for (const [id, q] of Object.entries(SEARCH)) {
    await sleep(1500);
    const j = await api('commons.wikimedia.org', { action: 'query', generator: 'search', gsrsearch: q + ' filetype:bitmap', gsrnamespace: '6', gsrlimit: '6', prop: 'imageinfo', iiprop: 'url|extmetadata|mime', iiurlwidth: '500' });
    const pages = ((j.query && j.query.pages) || []).sort((a, b) => a.index - b.index);
    for (const pg of pages) {
      const ii = pg.imageinfo && pg.imageinfo[0];
      if (!ii || ii.mime !== 'image/jpeg' || BAD_NAME.test(pg.title)) continue;
      const m = ii.extmetadata || {};
      const license = strip(m.LicenseShortName && m.LicenseShortName.value);
      if (!FREE.test(license)) continue;
      found.set(id, { thumb: ii.thumburl, license, author: strip(m.Artist && m.Artist.value).slice(0, 80), page: ii.descriptionurl, file: pg.title });
      break;
    }
  }
  // 2c. file indicati per nome
  for (const [id, title] of Object.entries(FILES)) {
    await sleep(1500);
    const j = await api('commons.wikimedia.org', { action: 'query', titles: title, prop: 'imageinfo', iiprop: 'url|extmetadata|mime', iiurlwidth: '500' });
    const pg = ((j.query && j.query.pages) || [])[0];
    const ii = pg && !pg.missing && pg.imageinfo && pg.imageinfo[0];
    const m = (ii && ii.extmetadata) || {};
    const license = strip(m.LicenseShortName && m.LicenseShortName.value);
    if (ii && FREE.test(license)) found.set(id, { thumb: ii.thumburl, license, author: strip(m.Artist && m.Artist.value).slice(0, 80), page: ii.descriptionurl, file: pg.title });
    else console.log(`file non utilizzabile per ${id}: ${title}`);
  }
  // 3. scrittura nel seed
  let ok = 0; const skipped = [];
  for (const p of seed.pois) {
    delete p.photoUrl; delete p.photoCredit; delete p.photoPage;
    const f = found.get(p.id);
    if (f) {
      p.photoUrl = f.thumb; p.photoCredit = `Foto: ${f.author || 'autore non indicato'}, ${f.license}, Wikimedia Commons`; p.photoPage = f.page; ok++;
      continue;
    }
    if (SEARCH[p.id]) { skipped.push(`${p.id}: nessun risultato libero per «${SEARCH[p.id]}»`); continue; }
    const title = MAP[p.id];
    if (!title) continue;
    const l = lead.get(title);
    const i = l && (info.get(l.file) || info.get(l.file.replace(/_/g, ' ')));
    const why = !l ? 'nessuna immagine nella voce' : BAD_NAME.test(l.file) ? `immagine non adatta (${l.file})` : !i ? `non su Commons, probabilmente non libera (${l.file})` : !FREE.test(i.license) ? `licenza non riconosciuta: ${i.license}` : '';
    if (why) { skipped.push(`${p.id} [${title}]: ${why}`); continue; }
    p.photoUrl = l.thumb;
    p.photoCredit = `Foto: ${i.author || 'autore non indicato'}, ${i.license}, Wikimedia Commons`;
    p.photoPage = i.page;
    ok++;
  }
  fs.writeFileSync(file, JSON.stringify(seed, null, 2) + '\n');
  console.log(`Foto aggiunte a ${ok} schede su ${Object.keys(MAP).length + Object.keys(SEARCH).length} richieste.`);
  for (const [id, f] of found) console.log(`ricerca ${id} -> ${f.file}`);
  if (skipped.length) console.log('Senza foto:\n- ' + skipped.join('\n- '));
})().catch((e) => { console.error('Errore:', e.message); process.exit(1); });

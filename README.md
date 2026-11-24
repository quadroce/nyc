# NYC in compagnia

PWA del viaggio a New York (4–9 dicembre 2026), dal documento di prodotto v0.2.
Nessuna dipendenza da installare: serve solo Node.js 20.12 o successivo.

## Avvio

```powershell
node server.js admin add Francesco
```

Stampa una sola volta il codice amministratore (sul server resta solo l'impronta). Poi:

```powershell
node server.js
```

e apri <http://localhost:3000>. L'accesso admin è in **Info → Accesso amministratori**.

Secondo amministratore: `node server.js admin add <nome>`; per toglierlo dopo il viaggio `node server.js admin revoke <nome>`; elenco con `admin list`. Ognuno può rigenerare il proprio codice dal pannello Admin.

## Cosa c'è

| Sezione | Contenuto |
| --- | --- |
| Oggi | Ora di New York, «Prossimo punto di incontro», avviso «Cambio di programma» (prima → dopo, autore, ora), attività del giorno |
| Programma | Giorni 4–9 dicembre per fascia oraria, stati, «Mi interessa» (solo sul telefono), percorso del giorno a tratti in Google Maps |
| Vicino a me | Curiosità per categoria, distanza con posizione attiva, «visto», segnalazioni di vicinanza (una per luogo al giorno, silenziabili) |
| TrovaCibo | «Siamo pochi» / «Siamo in 23», filtri, ricerca Google Places dal server, opzioni di emergenza salvate dagli admin |
| Info | Hotel, 911, cosa funziona senza rete, riservatezza |
| Admin | Crea/modifica/elimina tappe e curiosità, impostazioni, cronologia con ripristino |

Calendario: ogni scheda apre la creazione evento di Google Calendar (fuso `America/New_York`) o scarica un `.ics`.

## Dati

- `data/seed.json`: contenuto iniziale. Alla prima partenza viene copiato in `data/state.json`, che da lì in poi è l'archivio vero (modificato dalla PWA).
- `data/snapshots.json`: ultime 40 versioni, per il ripristino. `data/admins.json`: impronte dei codici. Con Redis le stesse voci sono chiavi `nyc:*`.
- Per ripartire dal seed: ferma il server e cancella `data/state.json` e `data/snapshots.json`.

Il programma nel seed viene dal memo «La Grande Mela in compagnia» (prima bozza, 26 ottobre 2026), convertito da `tools/import-memo.js`: 27 attività, con ritrovo distinto dall'orario della visita, e le schede «Due righe per orientarsi» come curiosità collegate alle tappe. La partita NFL del 6 non è nel memo: resta come attività di sottogruppo senza dettagli. Da qui in avanti il programma si modifica nella PWA, non nel seed.

Ancora «da confermare» come nel memo: trasferimento JFK–hotel e cena del 4, pattinaggio al Wollman Rink, indirizzo del Rosa Mexicano, orario dei controlli per le isole, punto di incontro del tour di Dyker Heights, orario e ingresso del museo, check-out e auto per JFK.

Le coordinate delle curiosità sono indicative e marcate «non verificate»: finché un admin non le verifica, Maps viene aperto per nome e indirizzo e le segnalazioni di vicinanza restano spente. Le schede Marvel sono bozze non pubblicate.

## TrovaCibo (Google Places)

Copia `.env.example` in `.env` e inserisci `GOOGLE_PLACES_API_KEY` (Places API «New» abilitata). La chiave resta sul server. Limiti: `PLACES_DAILY_BUDGET` ricerche al giorno, 8 al minuto per dispositivo, risultati tenuti in memoria 10 minuti e mai salvati su disco. I campi richiesti (adatto ai bambini, gruppi, prenotabile) ricadono nella fascia di prezzo più alta di Nearby Search: controlla i costi prima del viaggio.

## Prova

- `http://localhost:3000/?ora=2026-12-05T16:00` simula quell'ora di New York (banner rosso, «Esci» per tornare all'ora reale).
- Senza rete: apri l'app una volta online, poi attiva la modalità aereo e riaprila.

## Pubblicazione

Serve **HTTPS** (obbligatorio per installare la PWA e per la posizione). L'archivio si sceglie da solo:

| Dove gira | Archivio | Cosa fare |
| --- | --- | --- |
| Vercel o altro serverless | Redis via REST (Upstash) | Aggiungi al progetto un database Upstash Redis dal Marketplace di Vercel: le variabili `KV_REST_API_URL` e `KV_REST_API_TOKEN` (o `UPSTASH_REDIS_REST_URL` / `_TOKEN`) vengono lette da sole. Poi rifai il deploy. |
| Server con disco (Render, Fly, VPS, PC) | File in `DATA_DIR` | Monta un disco persistente e imposta `DATA_DIR`. Dietro un proxy imposta `TRUST_PROXY=1`. |
| Nessuno dei due | Sola lettura | Il sito mostra il programma del seed; l'accesso admin è spento e lo dichiara. |

**Codice admin con Redis**: metti le stesse due variabili nel `.env` locale (da Vercel: Settings → Environment Variables, oppure `vercel env pull`) e lancia `node server.js admin add Francesco`. Il comando scrive nello stesso archivio del sito.

Le sessioni admin sono gettoni firmati che durano 2 ore; decadono subito se il codice viene cambiato o revocato. «Esci» scarta il gettone dal telefono.

Con Redis il programma **non** si aggiorna più da `data/seed.json` dopo il primo avvio: l'archivio vero è Redis. Per ripartire dal seed cancella la chiave `nyc:state`.

## Non incluso

- Componente Android nativa con geofencing (fase 4 del documento): progetto separato. Il catalogo è leggibile da `/api/data` (`pois` con `alertsEnabled`, `radius`, coordinate).
- Idee 3–6 del documento (Piano B, missioni per ragazzi, preferiti), rimandate a dopo il test.
- Sincronizzazione vera con Google Calendar.

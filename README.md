# NYC in compagnia

PWA del viaggio a New York (4–9 dicembre 2026), dal documento di prodotto v0.2.
Nessuna dipendenza da installare: serve solo Node.js 20.12 o successivo.

## Modificare il programma (sito su Vercel)

Il sito pubblicato legge il programma da `data/seed.json`. Per cambiarlo non serve nessun database:

1. Apri [`data/seed.json`](data/seed.json) su GitHub e premi la matita (**Edit this file**). Funziona anche dal telefono.
2. Modifica la tappa, poi **Commit changes** sul ramo `main`.
3. Vercel ripubblica da solo in circa un minuto. Chi ha già aperto l'app vede l'avviso «Cambio di programma» con prima → dopo; chi la apre per la prima volta vede direttamente la versione nuova.

Prima di pubblicare, Vercel esegue `npm run build`, che controlla il file (`tools/check-seed.js`). Se c'è un errore, per esempio una virgola di troppo o un orario scritto `8:40`, la pubblicazione si ferma, **resta online la versione precedente** e l'errore è leggibile nei log del deploy su Vercel. Dal PC lo stesso controllo è `npm run check`.

Campi di una tappa (`activities`):

| Campo | Valori |
| --- | --- |
| `date` | `2026-12-04` … `2026-12-09` |
| `meetTime`, `time`, `endTime` | Ritrovo, inizio, fine: `HH:MM` ora di New York, oppure `""` |
| `meetPlace` | Punto di ritrovo, se diverso dal luogo. Se contiene «hotel», «Portami qui» porta all'hotel |
| `status` | `prenotato`, `proposto`, `da_confermare`, `facoltativo` |
| `audience` | `tutti`, `facoltativo`, `sottogruppo` (con `audienceNote`, es. «3 persone») |
| `type` | `ritrovo`, `visita`, `pasto`, `spostamento` |
| `placeName`, `address` | Luogo e indirizzo completo usati per Google Maps |
| `description`, `transportNote` | Testi liberi |
| `id` | Non cambiarlo: serve a riconoscere la tappa. Per una tappa nuova inventane uno, es. `a-0612-brunch` |

Le curiosità stanno in `pois`: `published: false` le nasconde, `linkedActivityId` le aggancia a una tappa. Le note della sezione Info sono in `config.infoNotes`, le opzioni di emergenza per il cibo in `config.foodFallback` (`name`, `address`, `note`).

La pagina è pubblica, come il repository: niente numeri di prenotazione, biglietti o dati personali.

In questa modalità il pannello Admin è spento. Per riaccenderlo basta collegare un archivio (vedi Pubblicazione).

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

Serve **HTTPS** (obbligatorio per installare la PWA e per la posizione). L'archivio si sceglie da solo, in quest'ordine:

| Archivio | Variabili | Note |
| --- | --- | --- |
| Supabase | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (o `SUPABASE_SECRET_KEY`) | Crea prima la tabella con `supabase/schema.sql`. Una riga per chiave nella tabella `nyc_kv` (nome modificabile con `SUPABASE_TABLE`). |
| Redis via REST (Upstash) | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` (o `KV_REST_API_URL`, `KV_REST_API_TOKEN`) | Chiavi `nyc:*`. |
| File | `DATA_DIR` (facoltativa) | Solo dove il disco è scrivibile e persistente (PC, VPS, Render, Fly). Dietro un proxy imposta `TRUST_PROXY=1`. |
| Nessuno | | Il programma è `data/seed.json` e si modifica su GitHub (vedi sopra); il pannello Admin è spento. È la configurazione attuale su Vercel. |

La chiave di servizio di Supabase dà accesso completo al progetto: va messa solo tra le variabili d'ambiente del server (su Vercel senza prefissi pubblici) e nel `.env` locale, mai nel repository.

**Codice admin con archivio remoto**: metti le stesse variabili nel `.env` locale e lancia `node server.js admin add Francesco`. Il comando scrive nello stesso archivio del sito.

Le sessioni admin sono gettoni firmati che durano 2 ore; decadono subito se il codice viene cambiato o revocato. «Esci» scarta il gettone dal telefono.

Con un archivio remoto il programma **non** si aggiorna più da `data/seed.json` dopo il primo avvio. Per ripartire dal seed cancella la riga `state` (Supabase) o la chiave `nyc:state` (Redis).

## Non incluso

- Componente Android nativa con geofencing (fase 4 del documento): progetto separato. Il catalogo è leggibile da `/api/data` (`pois` con `alertsEnabled`, `radius`, coordinate).
- Idee 3–6 del documento (Piano B, missioni per ragazzi, preferiti), rimandate a dopo il test.
- Sincronizzazione vera con Google Calendar.

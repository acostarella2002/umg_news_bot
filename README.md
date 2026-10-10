# UMG News Bot

**Feed RSS e notifiche WhatsApp per le bacheche avvisi dell'Università Magna Graecia di Catanzaro.**

UMG News Bot raccoglie in un unico servizio gli avvisi pubblicati sulle bacheche di 42 corsi di laurea, 3 scuole, dell'ateneo e della Fondazione UMG. Ogni nuovo avviso viene pubblicato in un feed RSS e inviato nel gruppo WhatsApp del corso a cui appartiene, dentro la community _"UMG automated news by Primavera Studentesca UMG"_.

Un progetto di **Primavera Studentesca UMG**.

---

## Indice

1. [Funzionalità](#funzionalità)
2. [Come funziona](#come-funziona)
3. [Privacy e sicurezza](#privacy-e-sicurezza)
4. [Riduzione del rischio di ban](#riduzione-del-rischio-di-ban)
5. [Configurazione](#configurazione)
6. [Comandi WhatsApp](#comandi-whatsapp)
7. [Feed RSS e monitoraggio](#feed-rss-e-monitoraggio)
8. [Sviluppo](#sviluppo)
9. [Guida passo passo da Windows](#guida-passo-passo-da-windows)

---

## Funzionalità

- **Lettura automatica delle bacheche.** Ogni 15 minuti il bot legge le pagine avvisi di ogni corso di laurea:
  - `medicina.unicz.it/corso_studio/*/avvisi`
  - `sfn.unicz.it/corso_studio/*/avvisi`
  - `diges.unicz.it/corso_studio/*/avvisi`

  Legge inoltre gli avvisi delle tre scuole, i feed RSS di ateneo (`web.unicz.it`) e quelli della Fondazione UMG (Bandi e Notizie).

- **Feed RSS.** Il bot pubblica un feed per ogni corso, per ogni scuola, per l'ateneo e per la Fondazione, più un feed aggregato con tutti gli avvisi.
- **Notifiche WhatsApp.** Ogni avviso **nuovo** viene inviato nel gruppo collegato al corso. Il messaggio contiene titolo, data, un estratto del testo, gli allegati e il link all'avviso originale.
- **Avvisi delle scuole.** Un avviso pubblicato da una scuola raggiunge automaticamente tutti i corsi di quella scuola.
- **Gestione dal telefono.** I gruppi si collegano ai corsi con semplici comandi scritti nella chat _"Messaggio a te stesso"_ dell'account del bot.

## Come funziona

Il servizio è un unico processo Node.js con quattro attività indipendenti, che comunicano solo attraverso un database SQLite:

| Attività       | Cosa fa                                                                                        |
| -------------- | ---------------------------------------------------------------------------------------------- |
| **Poller**     | Ogni 15 minuti scarica le bacheche, riconosce gli avvisi nuovi e ne scarica il testo completo. |
| **Server RSS** | Espone i feed e lo stato del servizio sulla porta 8080, in sola lettura.                       |
| **Sender**     | Svuota la coda dei messaggi WhatsApp con un ritmo lento e simile a quello di una persona.      |
| **Comandi**    | Esegue i comandi che il proprietario scrive nella chat "Messaggio a te stesso".                |

Due regole proteggono i gruppi dai messaggi indesiderati:

- **Prima lettura silenziosa.** La prima volta che il bot legge una bacheca memorizza tutti gli avvisi esistenti **senza inviarli**. Dopo quel momento, solo gli avvisi davvero nuovi vengono inviati.
- **Niente invii retroattivi.** Quando colleghi un gruppo, riceve solo gli avvisi pubblicati da quel momento in poi. Dopo un'interruzione del servizio vengono inviati solo gli avvisi degli ultimi 3 giorni.

## Privacy e sicurezza

Il bot è progettato per non conoscere nulla delle persone che leggono i gruppi.

- **Nessun dato personale.** Il bot non legge e non salva messaggi, numeri o nomi. Elabora solo i messaggi che il proprietario scrive nella chat "Messaggio a te stesso"; tutto il resto viene scartato senza essere letto.
- **Database minimo.** Contiene solo avvisi pubblici e gli identificativi dei gruppi. Non esiste nessuna tabella dedicata alle persone.
- **Log puliti.** Un filtro oscura identificativi WhatsApp e numeri di telefono prima che vengano scritti nei log.
- **Protezione anti-SSRF.** Il bot scarica pagine solo da `*.unicz.it` e `*.fondazioneumg.it`, anche dopo eventuali redirect. Un link malevolo dentro un avviso non può fargli contattare altri siti.
- **Server in sola lettura.** Il server web non accetta scritture e invia header di sicurezza su ogni risposta.
- **Container isolato.** Il container gira con un utente non privilegiato, filesystem in sola lettura e nessuna capability Linux.

Queste garanzie sono verificate automaticamente dai test in `test/security.test.js`.

## Riduzione del rischio di ban

Il bot usa il protocollo di WhatsApp Web tramite la libreria Baileys, che non è un'API ufficiale. Per questo si comporta nel modo più prudente possibile.

- **Solo gruppi.** Usa l'account WhatsApp Business dell'associazione come "dispositivo collegato" e scrive solo nei gruppi. Non crea gruppi, non invia inviti e non scrive mai a singole persone.
- **Ritmo umano.** Tra due messaggi attende un tempo casuale di 8–20 secondi e mostra "sta scrivendo…" prima di ogni invio. Quando molti avvisi arrivano insieme rallenta a un messaggio ogni 2–3 minuti.
- **Limite orario.** Non invia più di 40 messaggi all'ora e non risulta sempre "online".
- **Gestione degli errori.** Un messaggio che non riesce a partire viene riprovato dopo 5 e poi 15 minuti, senza bloccare gli altri gruppi.
- **Nessuna ondata.** Prima lettura silenziosa, finestra di 3 giorni e controllo delle date proteggono da invii massivi, anche quando un sito cambia struttura.

## Configurazione

### Variabili d'ambiente

La configurazione si trova nel file `.env`, da creare a partire da `.env.example`.

| Variabile            | Predefinito             | Descrizione                                                                                                                              |
| -------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `BASE_URL`           | `http://localhost:8080` | Indirizzo pubblico del server, usato nei link dei feed (es. `http://<IP-del-server>:8080`).                                              |
| `PORT`               | `8080`                  | Porta HTTP interna al container.                                                                                                         |
| `POLL_MINUTES`       | `15`                    | Minuti tra due controlli delle bacheche.                                                                                                 |
| `WA_ENABLED`         | `true`                  | Imposta `false` per usare solo i feed RSS, senza WhatsApp.                                                                               |
| `WA_PAIRING_NUMBER`  | —                       | Numero del WhatsApp Business **del bot**, in formato internazionale e solo cifre (es. `393331234567`). Serve solo al primo collegamento. |
| `SEND_MIN_DELAY_S`   | `8`                     | Pausa minima tra due messaggi, in secondi.                                                                                               |
| `SEND_MAX_DELAY_S`   | `20`                    | Pausa massima tra due messaggi, in secondi.                                                                                              |
| `SLOW_MIN_DELAY_S`   | `120`                   | Pausa minima quando in coda ci sono più di 10 messaggi.                                                                                  |
| `SLOW_MAX_DELAY_S`   | `180`                   | Pausa massima quando in coda ci sono più di 10 messaggi.                                                                                 |
| `MAX_SENDS_PER_HOUR` | `40`                    | Numero massimo di messaggi all'ora.                                                                                                      |
| `KEEPALIVE_DAYS`     | `7`                     | Giorni tra due promemoria nella chat "Messaggio a te stesso".                                                                            |
| `LOG_LEVEL`          | `info`                  | Dettaglio dei log: `fatal`, `error`, `warn`, `info`, `debug`.                                                                            |

### Bacheche

L'elenco delle bacheche è in `config/sources.json`. Per aggiungere un corso, inserisci una voce nella sezione `courses` con questi campi:

- `id`: identificativo breve, **solo lettere minuscole, numeri e trattini bassi** (es. `ingegneria_biomedica`). Non cambiarlo dopo la messa in produzione, perché è usato dai collegamenti ai gruppi.
- `name`: nome leggibile, mostrato nei messaggi e nei feed.
- `school`: `medicina`, `sfn` o `diges`. Determina quali avvisi della scuola riceve il corso.
- `url`: indirizzo della pagina avvisi del corso.

Dopo la modifica, verifica che la nuova bacheca venga letta correttamente con `npm run check:sources`.

## Comandi WhatsApp

I comandi si scrivono **solo** nella chat _"Messaggio a te stesso"_ del WhatsApp Business del bot, dal telefono principale. In qualsiasi altra chat vengono ignorati. Maiuscole e minuscole sono indifferenti.

| Comando                        | Effetto                                                                                |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| `!aiuto`                       | Mostra l'elenco dei comandi.                                                           |
| `!stato`                       | Mostra ultimo controllo, messaggi in coda, inviati e falliti, collegamenti.            |
| `!gruppi`                      | Elenca, numerati, i gruppi in cui si trova il bot.                                     |
| `!target [filtro]`             | Elenca gli identificativi di corsi, scuole e feed.                                     |
| `!associa <n\|jid> <target…>`  | Collega un gruppo a uno o più target, dopo aver verificato che il bot ne faccia parte. |
| `!dissocia <n\|jid> <target…>` | Scollega un gruppo.                                                                    |
| `!mappa`                       | Mostra i collegamenti attuali e segnala quelli non più validi.                         |
| `!test <target>`               | Mostra un'anteprima dell'ultimo avviso, visibile solo a te.                            |
| `!pausa` / `!riprendi`         | Sospende o riprende gli invii.                                                         |

**Esempio.** `!gruppi` restituisce l'elenco numerato; `!associa 3 medicina_chirurgia` collega il gruppo n. 3 al corso di Medicina e Chirurgia. Con `!associa 1 ateneo fondazione` colleghi più target allo stesso gruppo, ad esempio la bacheca della community. Il bot risponde con il nome del gruppo collegato: controllalo sempre.

**Promemoria settimanale.** Ogni 7 giorni il bot scrive nella chat "Messaggio a te stesso" un riepilogo dello stato. Serve a ricordarti di aprire WhatsApp Business sul telefono principale: se il telefono resta offline per circa 14 giorni, WhatsApp scollega il bot.

## Feed RSS e monitoraggio

| Indirizzo       | Contenuto                                                                |
| --------------- | ------------------------------------------------------------------------ |
| `/feeds`        | Elenco in formato JSON di tutti i feed disponibili, con i relativi link. |
| `/rss/<id>.xml` | Feed RSS di un corso, di una scuola, dell'ateneo o della Fondazione.     |
| `/rss/all.xml`  | Feed aggregato con tutti gli avvisi.                                     |
| `/health`       | Stato del servizio, usato anche da Docker.                               |

`/health` risponde `200` quando tutto funziona e `503` quando serve un intervento. In quel caso `docker ps` mostra il container come `unhealthy`, e la risposta indica il motivo:

| Campo                    | Significato e azione                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| `dataWritable: false`    | La cartella `data/` non è scrivibile. Controlla permessi e proprietario.                              |
| `pollsRunning: false`    | Le bacheche non vengono controllate da almeno tre cicli. Controlla lo spazio su disco.                |
| `whatsapp: "logged_out"` | WhatsApp ha scollegato il bot. Ripeti il collegamento (vedi [D.3](#d3-ricollegare-whatsapp)).         |
| `whatsapp: "replaced"`   | Un'altra copia del bot usa la stessa sessione. Spegnila: il bot si ricollega da solo entro 15 minuti. |

## Sviluppo

### Comandi principali

| Comando                 | Descrizione                                                                    |
| ----------------------- | ------------------------------------------------------------------------------ |
| `npm ci`                | Installa le dipendenze esattamente nelle versioni bloccate.                    |
| `npm test`              | Esegue i 54 test automatici (moduli, sicurezza, flusso completo).              |
| `npm run lint`          | Controlla il codice con ESLint.                                                |
| `npm run format:check`  | Verifica la formattazione con Prettier (`npm run format` la corregge).         |
| `npm run check:sources` | Controlla dal vivo tutte le bacheche e segnala quelle vuote o irraggiungibili. |
| `npm run poll:once`     | Esegue un ciclo reale su un database in memoria, senza inviare messaggi.       |
| `npm start`             | Avvia il servizio completo.                                                    |

### Struttura del progetto

```
src/            codice dell'applicazione (poller, parser, database, server, WhatsApp)
config/         sources.json, l'elenco delle bacheche
scripts/        strumenti di controllo (check-sources, poll-once)
test/           test automatici e pagine reali salvate come esempi
brain/          documentazione tecnica completa (vault Obsidian)
data/           database e sessione WhatsApp, creati all'avvio (non versionati)
```

### Documentazione tecnica

La cartella `brain/` è un vault [Obsidian](https://obsidian.md) che descrive in dettaglio architettura, flusso degli avvisi, schema del database, invarianti di privacy e anti-ban, convenzioni di codice e procedure di modifica. Prima di modificare il codice, parti da `brain/00 - Indice.md`.

---

## Guida passo passo da Windows

Questa guida porta il progetto da zero a un servizio attivo 24 ore su 24 su un server gratuito Oracle Cloud, usando solo il terminale di Windows (**PowerShell**). I comandi della parte B.4 e successivi si eseguono **sul server** dopo esserti collegato via SSH: sono indicati con il blocco `bash`.

> [!IMPORTANT]
> Il bot deve girare in **un solo posto alla volta**. Se lo avvii sul PC con WhatsApp attivo mentre è attivo anche sul server, i gruppi riceveranno messaggi doppi. Per le prove in locale usa sempre `WA_ENABLED=false`.

### Parte A — Prova in locale

#### A.1 Prepara Node.js

Il progetto richiede Node.js 22.13 o successivo. Nella cartella è già incluso un Node portatile in `.tools\node`: per usarlo, apri PowerShell nella cartella del progetto e aggiungilo al `PATH` della sessione corrente.

```powershell
cd $HOME\Desktop\umg-news-bot
$env:Path = "$PWD\.tools\node;$env:Path"
node --version
```

In alternativa puoi installare Node.js in modo permanente con `winget install OpenJS.NodeJS.LTS` e riaprire il terminale.

#### A.2 Installa e verifica

```powershell
npm ci
npm test
npm run check:sources
```

`npm test` deve terminare con `fail 0`; `check:sources` deve mostrare un numero di avvisi per ogni bacheca, senza righe `ERROR` o `EMPTY`.

#### A.3 Avvia i soli feed RSS

```powershell
$env:WA_ENABLED = "false"
npm start
```

Apri `http://localhost:8080/feeds` nel browser per vedere l'elenco dei feed, e `http://localhost:8080/health` per lo stato. Premi `Ctrl+C` per fermare il servizio, poi chiudi il terminale (o esegui `Remove-Item Env:WA_ENABLED`) per annullare l'impostazione.

#### A.4 (Facoltativo) Prova con Docker Desktop

Se hai installato [Docker Desktop](https://www.docker.com/products/docker-desktop/), puoi provare il container esattamente come girerà sul server:

```powershell
Copy-Item .env.example .env
notepad .env
```

Nel file imposta `WA_ENABLED=false`, salva e chiudi. Poi:

```powershell
docker compose up -d --build
docker compose ps
curl.exe http://localhost:8080/health
docker compose down
```

Prima di procedere, elimina la cartella `data` creata dalla prova (`Remove-Item -Recurse -Force data`), così il server partirà con un database pulito.

### Parte B — Server gratuito su Oracle Cloud

#### B.1 Crea una chiave SSH

La chiave SSH ti permette di collegarti al server in modo sicuro, senza password. Windows 10 e 11 includono già il client OpenSSH.

```powershell
ssh-keygen -t ed25519 -f $HOME\.ssh\oracle_umg
Get-Content $HOME\.ssh\oracle_umg.pub | Set-Clipboard
```

Il secondo comando copia la chiave **pubblica** negli appunti: ti servirà al passo successivo. Non condividere mai il file senza estensione `.pub`, che è la chiave privata.

#### B.2 Crea l'account e la macchina virtuale

1. Registrati su [cloud.oracle.com](https://cloud.oracle.com) scegliendo il piano **Always Free**. È richiesta una carta per la verifica dell'identità, ma le risorse Always Free non vengono addebitate.
2. Apri **Compute → Instances → Create instance** e imposta:
   - **Image**: Canonical Ubuntu 24.04;
   - **Shape**: `VM.Standard.A1.Flex` (Ampere ARM) con 1 OCPU e 6 GB di memoria;
   - **Add SSH keys → Paste public keys**: incolla la chiave copiata al passo B.1.
3. Premi **Create** e attendi che lo stato diventi _Running_. Annota il **Public IP address** mostrato nella pagina dell'istanza.

> [!NOTE]
> Se ricevi l'errore _Out of capacity_, le macchine ARM gratuite sono momentaneamente esaurite nella tua zona: riprova più tardi o seleziona un altro _Availability Domain_.

> [!WARNING]
> Oracle può recuperare le istanze Always Free che restano poco utilizzate per una settimana, e questo bot consuma pochissime risorse. Per evitarlo, passa l'account a **Pay As You Go** (_Billing → Upgrade_): le risorse Always Free restano gratuite.

#### B.3 Apri la porta dei feed

Per rendere raggiungibili i feed RSS da Internet, apri la porta 8080:

1. Dalla pagina dell'istanza apri la **Subnet** → **Security List** predefinita → **Add Ingress Rules**.
2. Imposta **Source CIDR** `0.0.0.0/0`, **IP Protocol** `TCP`, **Destination Port Range** `8080` e salva.

#### B.4 Collegati al server e installa Docker

Da PowerShell, sostituendo `<IP>` con l'indirizzo annotato al passo B.2:

```powershell
ssh -i $HOME\.ssh\oracle_umg ubuntu@<IP>
```

Alla prima connessione conferma con `yes`. Ora sei sul server: esegui i comandi seguenti.

```bash
sudo apt update && sudo apt install -y docker.io docker-compose-v2
sudo usermod -aG docker $USER
sudo iptables -I INPUT 6 -p tcp --dport 8080 -j ACCEPT
sudo netfilter-persistent save
exit
```

Il comando `iptables` apre la porta anche nel firewall interno di Ubuntu, che sulle immagini Oracle è attivo. Il comando `exit` chiude la sessione: ricollegandoti, il tuo utente potrà usare Docker senza `sudo`.

#### B.5 Copia il progetto sul server

Torna su PowerShell **sul tuo PC**, nella cartella del progetto. Crea un archivio senza le cartelle che non servono sul server e invialo:

```powershell
cd $HOME\Desktop\umg-news-bot
tar -czf ..\umg-news-bot.tgz --exclude=node_modules --exclude=.tools --exclude=data --exclude=.env --exclude=brain .
scp -i $HOME\.ssh\oracle_umg ..\umg-news-bot.tgz ubuntu@<IP>:~/
ssh -i $HOME\.ssh\oracle_umg ubuntu@<IP>
```

Sul server, estrai l'archivio:

```bash
mkdir -p ~/umg-news-bot && tar -xzf ~/umg-news-bot.tgz -C ~/umg-news-bot && rm ~/umg-news-bot.tgz
cd ~/umg-news-bot
```

#### B.6 Configura e avvia

```bash
cp .env.example .env
nano .env
```

Nell'editor imposta almeno:

- `WA_PAIRING_NUMBER` con il numero del WhatsApp Business del bot (es. `393331234567`);
- `BASE_URL` con `http://<IP>:8080`;
- `WA_ENABLED=true`.

Salva con `Ctrl+O`, `Invio`, ed esci con `Ctrl+X`. Poi prepara la cartella dei dati (deve appartenere all'utente del container, UID 1000) e avvia il servizio:

```bash
mkdir -p data && sudo chown 1000:1000 data && chmod 700 data
docker compose up -d --build
docker compose logs -f
```

La prima compilazione richiede alcuni minuti. Attendi nei log la riga `PAIRING CODE: XXXX-XXXX` e passa alla parte C senza chiudere i log.

### Parte C — Collega WhatsApp e i gruppi

#### C.1 Prepara la community (una volta sola)

Dal telefono con il **WhatsApp Business del bot**:

1. crea la community _"UMG automated news by Primavera Studentesca UMG"_ e un gruppo per ogni corso;
2. in ogni gruppo imposta _Impostazioni gruppo → Invia messaggi → Solo gli amministratori_;
3. nomina gli amministratori dell'associazione come admin della community: scriveranno a mano nella bacheca della community.

Creando i gruppi dall'account del bot, il bot ne è automaticamente amministratore e può scrivere.

#### C.2 Collega il bot

1. Sul telefono apri _WhatsApp Business → Dispositivi collegati → Collega un dispositivo → Collega con numero di telefono_.
2. Inserisci il codice `XXXX-XXXX` mostrato nei log.
3. Nei log compare `whatsapp connected`. Premi `Ctrl+C` per uscire dai log: il servizio continua a funzionare in background.

#### C.3 Associa i gruppi ai corsi

Nella chat **"Messaggio a te stesso"** scrivi, uno alla volta:

1. `!gruppi`: annota il numero di ogni gruppo;
2. `!target medicina`: trova gli identificativi dei corsi;
3. `!associa 3 medicina_chirurgia`: ripeti per ogni gruppo e controlla il nome del gruppo nella risposta;
4. `!associa 1 ateneo fondazione`: collega la bacheca della community agli avvisi di ateneo e Fondazione;
5. `!mappa` e `!test medicina_chirurgia`: verifica collegamenti e anteprima.

Non serve collegare le scuole ai gruppi dei corsi: gli avvisi di una scuola arrivano già a tutti i suoi corsi. Condividi tu i link d'invito dei gruppi: il bot non lo fa, per ridurre il rischio di ban.

#### C.4 Verifica dal PC

```powershell
curl.exe http://<IP>:8080/health
curl.exe http://<IP>:8080/feeds
```

`/health` deve rispondere con `"ok":true` e `"whatsapp":"connected"`.

### Parte D — Manutenzione

#### D.1 Aggiornare il codice

Sul PC, ricrea l'archivio e invialo come al passo B.5. Sul server:

```bash
tar -xzf ~/umg-news-bot.tgz -C ~/umg-news-bot && rm ~/umg-news-bot.tgz
cd ~/umg-news-bot && docker compose up -d --build
```

Il file `.env` e la cartella `data/` sul server non vengono toccati: avvisi, collegamenti e sessione WhatsApp restano invariati.

#### D.2 Fare un backup

Sul server, ferma per qualche secondo il servizio (così il database viene copiato in uno stato coerente), crea un archivio della cartella dei dati e riavvia:

```bash
cd ~/umg-news-bot
docker compose stop
sudo tar -czf ~/backup-data.tgz data && sudo chown $USER ~/backup-data.tgz
docker compose start
```

Dal PC, scaricalo:

```powershell
scp -i $HOME\.ssh\oracle_umg ubuntu@<IP>:~/backup-data.tgz .
```

Il backup contiene la sessione WhatsApp: conservalo in un luogo riservato e **non avviarlo mai sul PC** mentre il bot è attivo sul server.

#### D.3 Ricollegare WhatsApp

Se `/health` riporta `"whatsapp":"logged_out"` o nei log compare `logged out`, WhatsApp ha scollegato il bot. Sul server:

```bash
cd ~/umg-news-bot
docker compose down
sudo rm -rf data/wa-auth
docker compose up -d
docker compose logs -f
```

Poi ripeti il passo C.2 con il nuovo codice. I collegamenti ai gruppi restano validi.

#### D.4 Controlli periodici

- Apri WhatsApp Business sul telefono principale almeno una volta ogni 14 giorni: il bot te lo ricorda ogni settimana.
- Controlla lo stato con `docker compose ps` (sul server) o `curl.exe http://<IP>:8080/health` (dal PC).
- Leggi gli ultimi eventi con `docker compose logs --tail 100`.
- A inizio anno accademico esegui `npm run check:sources` sul PC per individuare bacheche spostate o nuovi corsi.

Per esporre i feed in HTTPS con un dominio gratuito, segui la sezione _HTTPS_ di [DEPLOY.md](DEPLOY.md).

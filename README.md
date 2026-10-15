# UMG News Bot

**RSS feeds and WhatsApp notifications for the notice boards of the Magna Graecia University of Catanzaro (UMG).**

UMG News Bot gathers into a single service the notices published on the boards of 42 degree courses, 3 schools, the university and the UMG Foundation. Every new notice is published in an RSS feed and sent to the WhatsApp group of the course it belongs to, inside the _"UMG automated news by Primavera Studentesca UMG"_ community.

A project by **Primavera Studentesca UMG**.

---

## Table of contents

1. [Features](#features)
2. [How it works](#how-it-works)
3. [Privacy and security](#privacy-and-security)
4. [Reducing the risk of a ban](#reducing-the-risk-of-a-ban)
5. [Configuration](#configuration)
6. [WhatsApp commands](#whatsapp-commands)
7. [RSS feeds and monitoring](#rss-feeds-and-monitoring)
8. [Development](#development)
9. [Operating the server](#operating-the-server)
10. [WhatsApp setup (once)](#whatsapp-setup-once)
11. [Server setup history](#server-setup-history)

---

## Features

- **Automatic board reading.** Every 10 minutes the bot reads the notice page of each degree course:
  - `medicina.unicz.it/corso_studio/*/avvisi`
  - `sfn.unicz.it/corso_studio/*/avvisi`
  - `diges.unicz.it/corso_studio/*/avvisi`

  It also reads the notices of the three schools, the university RSS feeds (`web.unicz.it`) and those of the UMG Foundation (calls and news).

- **RSS feeds.** One feed per course, per school, for the university and for the Foundation, plus an aggregated feed with every notice.
- **WhatsApp notifications.** Every **new** notice is sent to the group of its course, with title, date, an excerpt, the attachments and a link to the original.
- **School notices.** A notice published by a school reaches every course of that school.
- **Managed from the phone.** Groups are linked to courses automatically, and everything else is controlled with simple commands in the bot account's _"Message yourself"_ chat.

## How it works

The service is a single Node.js process running four independent activities, which communicate only through an SQLite database:

| Activity       | What it does                                                                            |
| -------------- | --------------------------------------------------------------------------------------- |
| **Poller**     | Every 10 minutes downloads the boards, detects new notices and fetches their full text. |
| **RSS server** | Serves the feeds and the service status on port 8080, read-only.                        |
| **Sender**     | Empties the WhatsApp message queue at a slow, human-like pace.                          |
| **Commands**   | Runs the commands the owner writes in the "Message yourself" chat.                      |

Two rules protect the groups from unwanted messages:

- **Silent first read.** The first time the bot reads a board, it stores every existing notice **without sending it**. From then on, only genuinely new notices are sent.
- **No retroactive sending.** A newly linked group only receives notices published from that moment on. After an interruption, only notices from the last 3 days are sent.

## Privacy and security

The bot is designed to know nothing about the people who read the groups.

- **No personal data.** The bot neither reads nor stores messages, phone numbers or names. It only processes the messages the owner writes in the "Message yourself" chat; everything else is discarded unread.
- **Minimal database.** Only public notices and group identifiers. There is no table for people.
- **Clean logs.** WhatsApp identifiers and phone numbers are masked before anything is logged.
- **SSRF protection.** Pages are downloaded only from `*.unicz.it` and `*.fondazioneumg.it`, even after redirects.
- **Read-only server.** The web server accepts no writes and sends security headers on every response.
- **Isolated container.** Unprivileged user, read-only filesystem, no Linux capabilities.

These guarantees are checked automatically by the tests in `test/security.test.js`.

## Reducing the risk of a ban

The bot speaks the WhatsApp Web protocol through the Baileys library, which is not an official API, so it behaves as cautiously as possible.

- **Groups only.** It uses the association's WhatsApp Business account as a "linked device" and writes only to groups. It never creates groups, sends invites or writes to individual people.
- **Human pace.** A random 8–20 seconds between two messages, with "typing…" before each one; one message every 2–3 minutes when many notices arrive at once.
- **Hourly cap.** At most 40 messages per hour; the bot does not appear permanently "online".
- **Error handling.** A failed message is retried after 5 and then 15 minutes, without blocking the other groups.
- **No floods.** The silent first read, the 3-day window and a publication-date check prevent mass sending.

## Configuration

### Environment variables

The configuration lives in the server's `.env` file, created by copying `.env.example`, which contains the recommended values. The bot's phone number goes only in the server's `.env`: the repository keeps a placeholder.

| Variable             | Value in `.env.example` | Description                                                                                                                                                               |
| -------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BASE_URL`           | `http://localhost:8080` | Public address of the server, used in feed links. On the server: `http://<server-IP>:8080`.                                                                               |
| `PORT`               | `8080`                  | HTTP port inside the container.                                                                                                                                           |
| `POLL_MINUTES`       | `10`                    | Minutes between two board checks.                                                                                                                                         |
| `WA_ENABLED`         | `false`                 | `false` runs the RSS feeds only (for tests on the PC). On the server: `true`.                                                                                             |
| `WA_PAIRING_NUMBER`  | `39xxxxxxxxxx`          | Number of the bot's WhatsApp Business account, digits only with country code (`39…`). Set: link with an 8-character code. **Empty: link by scanning a QR** (recommended). |
| `SEND_MIN_DELAY_S`   | `8`                     | Minimum pause between two messages, in seconds.                                                                                                                           |
| `SEND_MAX_DELAY_S`   | `20`                    | Maximum pause between two messages, in seconds.                                                                                                                           |
| `SLOW_MIN_DELAY_S`   | `120`                   | Minimum pause when more than 10 messages are queued.                                                                                                                      |
| `SLOW_MAX_DELAY_S`   | `180`                   | Maximum pause when more than 10 messages are queued.                                                                                                                      |
| `MAX_SENDS_PER_HOUR` | `40`                    | Maximum number of messages per hour.                                                                                                                                      |
| `KEEPALIVE_DAYS`     | `6`                     | Days between two reminders to open the phone (see [Reminder](#reminder-to-open-the-phone)).                                                                               |
| `LOG_LEVEL`          | `info`                  | Log detail: `fatal`, `error`, `warn`, `info`, `debug`.                                                                                                                    |

### Notice boards

The boards are listed in `config/sources.json`. To add a course, add an entry to `courses`:

- `id`: short identifier, **lowercase letters, digits and underscores only** (e.g. `ingegneria_biomedica`). Never change it once in production.
- `name`: readable name, shown in messages and feeds. It is also the **exact name of the course's WhatsApp group**.
- `school`: `medicina`, `sfn` or `diges`. Determines which school notices the course receives.
- `url`: address of the course's notice page.

Then check the new board with `npm run check:sources`.

## WhatsApp commands

You control the bot by writing commands in a special chat of the bot's WhatsApp Business account. There is no website or admin panel: this chat is the only control panel.

### Where to write the commands

1. Take the phone where the **bot's WhatsApp Business account** is installed (the primary phone).
2. Open the chat with yourself: start a new chat and pick the first contact, marked _"(You)"_ / _"(Tu)"_. On Italian phones it is called _"Messaggio a te stesso"_, in English _"Message yourself"_.
3. Write a command, send it, and wait a few seconds for the bot's reply in the same chat.

Rules to keep in mind:

- **Only this chat works.** Commands written in groups or in any other chat are ignored, so nobody else can control the bot.
- **Every command starts with `!`** and is a single word, sometimes followed by values separated by spaces (e.g. `!associa 3 giurisprudenza`).
- **Upper and lower case do not matter.** `!Associa` works like `!associa` (phones capitalise the first letter automatically).
- **The bot must be online.** A command sent more than 2 minutes before the bot comes online is ignored: if you get no reply, wait a minute and send it again.
- **The bot always replies in Italian.**

### Words you will meet

- **Target**: what a group can receive. Each course, school and news source has a short identifier, its _id_, e.g. `giurisprudenza` for the Law course, `medicina` for the School of Medicine, `ateneo` for university notices and `fondazione` for UMG Foundation notices. `!target` lists them all.
- **Link**: the connection between a WhatsApp group and one or more targets. A linked group receives every new notice of its targets.
- **Group number**: the position of a group in the list shown by `!gruppi`. It is a shortcut for the group's technical identifier (the _JID_, e.g. `120363012345678901@g.us`), which you can also use instead of the number.

### Commands at a glance

| Command                       | What it does                                                                              |
| ----------------------------- | ----------------------------------------------------------------------------------------- |
| `!aiuto`                      | Lists the commands.                                                                       |
| `!stato`                      | Shows whether the bot is working.                                                         |
| `!autoassocia`                | Links every course, school, Ateneo and Fondazione to the group with the same name.        |
| `!gruppi`                     | Lists the groups the bot belongs to, numbered.                                            |
| `!target [word]`              | Lists the ids of courses, schools and sources.                                            |
| `!associa <group> <target…>`  | Links a group to one or more targets.                                                     |
| `!dissocia <group> <target…>` | Removes a link.                                                                           |
| `!mappa`                      | Shows every link and flags the broken ones.                                               |
| `!test <target>`              | Previews the latest notice of a target, only in this chat.                                |
| `!prova [target]`             | Sends the latest notice of every linked course (or of one) to its groups, as a real test. |
| `!pausa` / `!riprendi`        | Stops or restarts sending to the groups.                                                  |
| `!svuota`                     | Cancels every queued message.                                                             |

### Each command in detail

#### `!aiuto` — list of commands

Replies with a short reminder of every command. Use it whenever you forget a command.

#### `!stato` — is the bot working?

```
📊 *Stato*
Ultimo controllo: 2026-10-10T10:15:02.000Z
In coda: 0
Inviati ultima ora: 3
Falliti ultime 24h: 0
Collegamenti: 42
Invii: ▶️ attivi
```

How to read it:

- **Ultimo controllo** (last check): when the boards were last read, in UTC time (Italian time minus 1 or 2 hours). It should never be older than about 10 minutes.
- **In coda** (queued): messages waiting to be sent. A few dozen right after many notices is normal: the bot sends them slowly on purpose.
- **Inviati ultima ora** (sent in the last hour): never above 40.
- **Falliti ultime 24h** (failed in the last 24 hours): should be `0`. If not, a group is not receiving: usually the bot is not an admin of a group where only admins can write, or it was removed from a group. Check with `!mappa`.
- **Collegamenti** (links): how many group–target links exist.
- **Invii** (sending): `▶️ attivi` (active) or `⏸️ in pausa` (paused, see `!pausa`).

#### `!autoassocia` — link the courses automatically

Links every course of `config/sources.json` to the WhatsApp group whose name is **exactly the course name** (upper/lower case, accents, apostrophe style and extra spaces do not matter). This is the recommended way to do the first setup: it avoids linking a group to the wrong course. The exact names are listed in [step C.1](#prepare-the-community).

```
🔗 *Associazione automatica gruppi → corsi*

✅ Collegati ora (2):
• Giurisprudenza → giurisprudenza
• Farmacia → farmacia

☑️ Corsi che avevano già un gruppo: 38

❓ Nessun gruppo con il nome del corso (2):
• Sociologia
• Healthcare Management (LM)
```

- **Collegati ora**: the links just created (group name → course id).
- **Corsi che avevano già un gruppo**: courses already linked; they are never changed.
- **Più gruppi con lo stesso nome** (several groups with the same name): the bot does not guess. Rename or delete the extra group, or link it by hand with `!associa`.
- **Nessun gruppo con il nome del corso** (no group with the course name): create the group, or fix its name, then send `!autoassocia` again.

The same linking also runs **by itself every time the bot connects to WhatsApp**: if you create the groups before linking the bot (as in the guide), the courses are linked automatically and the bot sends you this report. The automatic run links each course only once, so if you later remove a link with `!dissocia` it will not come back by itself; `!autoassocia`, being an explicit request, links it again. Schools, `ateneo` and `fondazione` are never linked automatically: link them with `!associa`.

#### `!gruppi` — list the groups

```
1. Bacheca UMG 🏘️ (bacheca)
   120363000000000001@g.us
2. Economia Aziendale 🏘️
   120363000000000002@g.us
3. Giurisprudenza 🏘️
   120363000000000003@g.us
```

Lists, in alphabetical order, the groups the bot belongs to. 🏘️ marks the groups inside a community, `(bacheca)` the community announcement group. The number on the left is what you use in `!associa` and `!dissocia`.

> [!NOTE]
> Numbers are valid only until the bot restarts, and change when groups are added. Always send `!gruppi` again right before using a number.

#### `!target` — find the ids

Without a word it lists every id with its name; with a word it shows only the matching ones. `!target psico` replies:

```
psicologia_cognitiva_l – Scienze e Tecniche di Psicologia Cognitiva
psicologia_cognitiva_neuroscienze – Psicologia Cognitiva e Neuroscienze (LM)
psicologia_forense – Psicologia Forense e Criminologica (LM)
```

#### `!associa` — link a group by hand

Write the group number (or JID), then one or more ids separated by spaces:

```
!associa 3 giurisprudenza
!associa 1 ateneo fondazione
```

The bot checks that it really belongs to that group and replies with the group name: **always read it** to make sure you picked the right number.

```
✅ Collegato a "Giurisprudenza": giurisprudenza
```

Possible refusals:

- `Il bot non è in questo gruppo…`: wrong number or JID, or the bot has left that group. Send `!gruppi` again.
- `Questa è la community…`: you picked the community itself, which cannot receive messages. Pick its announcement group (`(bacheca)`) instead.
- `Target sconosciuti: …` (unknown targets): an id is misspelled. Check it with `!target`.
- `Uso: …` (usage): the number is not in the last `!gruppi` list, or something is missing.

A new link only receives notices published **from now on**: older notices are never sent.

#### `!dissocia` — remove a link

Same format as `!associa`: `!dissocia 3 giurisprudenza`. The group stops receiving the notices of that target. It also works for groups the bot has already left.

#### `!mappa` — check every link

```
ateneo → Bacheca UMG
   120363000000000001@g.us
giurisprudenza → Giurisprudenza
   120363000000000003@g.us
sociologia → ⚠️ bot non più nel gruppo
   120363000000000009@g.us
```

Shows each target with the name of its group. `⚠️ bot non più nel gruppo` means the bot is no longer in that group: add the bot back, or remove the link with `!dissocia`.

#### `!test` — preview a message

`!test giurisprudenza` shows, **only in this chat**, the latest notice of that target exactly as the groups would receive it. Nothing is sent to the groups.

#### `!prova` — real test in the groups

`!prova` puts in the queue the latest notice of every linked target, one per group; `!prova farmacia` does it for one course only. Messages go through the normal queue, so the anti-ban rules apply: with more than 10 queued, one every 2–3 minutes (about 2 hours for 40 groups) and at most 40 per hour. Follow the progress with `!stato`, stop with `!pausa`. A notice already sent to a group is never sent again.

#### `!pausa` and `!riprendi` — emergency stop

`!pausa` stops every message to the groups immediately; RSS feeds keep working and new notices keep piling up in the queue. `!riprendi` restarts sending. Use it if something looks wrong, for example a burst of unexpected messages.

#### `!svuota` — empty the queue

`!svuota` cancels every message still in the queue (also those waiting for the notice text) and answers how many were cancelled. The notices stay in the RSS feeds; new notices published afterwards are sent normally. Typical use: after `!pausa`, when the queued messages are no longer worth sending.

### Which group receives what

- **Course notice** → the group of that course.
- **School notice** (Medicina, SFN, DiGES) → the school group, if the school has one; otherwise every course group of that school.
- **Ateneo / Fondazione** → their own groups.
- **The same notice published twice** (different link, same title and same attachment links) reaches a group only once. If the attachment numbers differ (`scarica_allegato/N`), both are sent.

### Message format

The text of every message comes from `config/message.json`, the same for all groups:

```json
"lines": ["*📢{titolo}*", "", "{testo}", "", "{link}", "", "*#PrimaveraStudentescaUMG*🌸"],
"attachment": "• {nome}: {url}",
"maxBody": 700
```

- Placeholders: `{bacheca}` course/school name, `{titolo}`, `{data}` (Rome time), `{testo}` body excerpt (at most `maxBody` characters), `{allegati}` attachment list (each one built with `attachment`), `{link}` the notice page.
- A line whose placeholder is empty (no date, no attachments…) is dropped; `""` is a blank line.
- WhatsApp markup works: `*bold*`, `_italic_`, `~strikethrough~`.
- An unknown placeholder (a typo such as `{titlo}`) stops the bot at startup with a clear error in the logs.
- After editing: deploy (`.\scripts\deploy.ps1`) and check with `!test <target>`.

### Reminder to open the phone

Every 6 days (`KEEPALIVE_DAYS`) the bot writes a reminder with a short status in this chat. Its purpose: WhatsApp unlinks devices whose primary phone stays offline for about 14 days. When you see the reminder, just open WhatsApp Business on the phone and leave it connected to the Internet for a few minutes.

## RSS feeds and monitoring

| Address         | Content                                                           |
| --------------- | ----------------------------------------------------------------- |
| `/feeds`        | JSON list of every available feed, with its link.                 |
| `/rss/<id>.xml` | RSS feed of a course, a school, the university or the Foundation. |
| `/rss/all.xml`  | Aggregated feed with every notice.                                |
| `/health`       | Service status, also used by Docker.                              |

`/health` answers `200` when everything works and `503` when someone needs to step in. In that case `docker ps` shows the container as `unhealthy`, and the response tells you why:

| Field                    | Meaning and action                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `dataWritable: false`    | The `data/` folder is not writable. Check its permissions and owner.                                              |
| `pollsRunning: false`    | The boards have not been checked for at least three cycles. Check the free disk space.                            |
| `whatsapp: "logged_out"` | WhatsApp has unlinked the bot. Link it again (see [Relink WhatsApp](#relink-whatsapp)).                           |
| `whatsapp: "replaced"`   | Another copy of the bot is using the same session. Shut it down: the bot reconnects on its own within 15 minutes. |

## Development

| Command                 | Description                                                             |
| ----------------------- | ----------------------------------------------------------------------- |
| `npm ci`                | Installs the dependencies exactly at the locked versions.               |
| `npm test`              | Runs the 64 automated tests (modules, security, end-to-end flow).       |
| `npm run lint`          | Checks the code with ESLint.                                            |
| `npm run format:check`  | Checks formatting with Prettier (`npm run format` fixes it).            |
| `npm run check:sources` | Checks every board live and reports the empty or unreachable ones.      |
| `npm run poll:once`     | Runs one real cycle on an in-memory database, without sending messages. |
| `npm start`             | Starts the full service.                                                |

```
src/            application code (poller, parsers, database, server, WhatsApp)
config/         sources.json, the list of notice boards
scripts/        check tools (check-sources, poll-once)
test/           automated tests and real pages saved as fixtures
brain/          full technical documentation (Obsidian vault, in Italian)
data/           database and WhatsApp session, created at startup (not versioned)
```

The `brain/` folder is an [Obsidian](https://obsidian.md) vault (in Italian) describing architecture, notice flow, database, privacy and anti-ban rules, coding conventions and how to change the code. Start from `brain/00 - Indice.md`.

---

## Operating the server

The bot runs on an Oracle Cloud **Always Free** virtual machine (`VM.Standard.E2.1.Micro`, Ubuntu 24.04) at **`<server-IP>`**, user `ubuntu`. All the commands below are run in **PowerShell on your PC**; they reach the server over SSH. How the server was built is recorded in [Server setup history](#server-setup-history).

> [!IMPORTANT]
> WhatsApp must be active in **one place only**: the server. On the PC always run with `WA_ENABLED=false`, otherwise the groups receive duplicate messages.

### Your PC (once)

1. **Node.js 22** (only needed to run tests and develop). Run once, accept the administrator prompt, then restart the terminal:

   ```powershell
   $release = (Invoke-RestMethod 'https://nodejs.org/dist/index.json') | Where-Object { $_.version -like 'v22.*' } | Select-Object -First 1
   $msi = Join-Path $env:TEMP "node-$($release.version)-x64.msi"
   Invoke-WebRequest "https://nodejs.org/dist/$($release.version)/node-$($release.version)-x64.msi" -OutFile $msi
   Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /passive /norestart" -Wait -Verb RunAs
   ```

2. **SSH key.** The private key `oracle_umg` must be in `$HOME\.ssh\`. On another PC, copy it there from a safe place; never share it.
3. **Session variables.** At the start of every PowerShell session, set:

   ```powershell
   $IP = '<server-IP>'
   $KEY = "$HOME\.ssh\oracle_umg"
   cd $HOME\Desktop\umg-news-bot
   ```

### Deploy a change

The server does **not** read from GitHub: `git push` only saves the code online, `deploy.ps1` is what updates the bot. The usual sequence:

```powershell
npm test; npm run lint; npm run format:check      # everything must pass
git add -A
git commit -m "describe the change"
git push                                          # save on GitHub
.\scripts\deploy.ps1                              # update the server
curl.exe "http://${IP}:8080/health"               # after ~30 s: "ok":true, "whatsapp":"connected"
```

`deploy.ps1` packs the project, uploads it, rebuilds the container and restarts the bot, then prints the container status. The server's `.env` and `data/` (notices, group links, WhatsApp session) are never touched. On the Micro machine the rebuild takes a few minutes.

### Everyday commands

| Task                          | Command                                                                            |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| Update the code on the server | `.\scripts\deploy.ps1` (after `npm test`; see [Deploy a change](#deploy-a-change)) |
| Check that everything works   | `curl.exe "http://${IP}:8080/health"`                                              |
| Open a shell on the server    | `ssh -i $KEY ubuntu@$IP`                                                           |
| Container status              | `ssh -i $KEY ubuntu@$IP "cd umg-news-bot && docker compose ps"`                    |
| Last 100 log lines            | `ssh -i $KEY ubuntu@$IP "cd umg-news-bot && docker compose logs --tail 100"`       |
| Follow the logs live          | `ssh -t -i $KEY ubuntu@$IP "cd umg-news-bot && docker compose logs -f"`            |
| Restart the bot               | `ssh -i $KEY ubuntu@$IP "cd umg-news-bot && docker compose restart"`               |
| Stop / start the bot          | `ssh -i $KEY ubuntu@$IP "cd umg-news-bot && docker compose stop"` (or `start`)     |
| Stop only WhatsApp messages   | write `!pausa` in the "Message yourself" chat (`!riprendi` to resume)              |

Press `Ctrl+C` to leave the live logs; the bot keeps running.

### Change the configuration

```powershell
ssh -t -i $KEY ubuntu@$IP "cd umg-news-bot && nano .env && docker compose up -d"
```

Edit the values (see [Environment variables](#environment-variables)), save with `Ctrl+O`, `Enter`, exit with `Ctrl+X`: the bot restarts with the new settings.

### Backup

```powershell
ssh -i $KEY ubuntu@$IP "cd umg-news-bot && docker compose stop && sudo tar -czf ~/backup-data.tgz data && sudo chown ubuntu ~/backup-data.tgz && docker compose start"
scp -i $KEY "ubuntu@${IP}:~/backup-data.tgz" .
```

The bot stops for a few seconds so that the database is copied consistently. The backup contains the WhatsApp session: keep it private and never start it on the PC.

### Relink WhatsApp

If `/health` reports `"whatsapp":"logged_out"`, WhatsApp has unlinked the bot:

```powershell
ssh -t -i $KEY ubuntu@$IP "cd umg-news-bot && docker compose down && sudo rm -rf data/wa-auth && docker compose up -d && docker compose logs -f"
```

Then scan the QR (or enter the code) as in [Link the bot](#link-the-bot). Group links are kept.

### Periodic checks

- Open WhatsApp Business on the primary phone when the bot's reminder arrives (every 6 days).
- Check `/health` from time to time; `"ok":true` means everything works.
- At the start of each academic year run `npm run check:sources` to spot moved boards or new courses.

---

## WhatsApp setup (once)

### Prepare the community

From the phone with the **bot's WhatsApp Business account**, preferably before linking the bot:

1. create the _"UMG automated news by Primavera Studentesca UMG"_ community;
2. inside it, create one group per course, named **exactly like the course** in the table below (upper/lower case, accents and apostrophe style do not matter);
3. in every group set _Group settings → Send messages → Only admins_;
4. make the association's administrators admins of the community.

<details>
<summary><strong>Exact group names (generated from <code>config/sources.json</code>)</strong></summary>

| Group name (type it exactly like this)                                     | Course id                             | School                            |
| -------------------------------------------------------------------------- | ------------------------------------- | --------------------------------- |
| Infermieristica                                                            | `infermieristica`                     | Scuola di Medicina e Chirurgia    |
| Infermieristica (Interateneo RC)                                           | `infermieristica_rc`                  | Scuola di Medicina e Chirurgia    |
| Fisioterapia                                                               | `fisioterapia`                        | Scuola di Medicina e Chirurgia    |
| Ostetricia                                                                 | `ostetricia`                          | Scuola di Medicina e Chirurgia    |
| Logopedia                                                                  | `logopedia`                           | Scuola di Medicina e Chirurgia    |
| Dietistica                                                                 | `dietistica`                          | Scuola di Medicina e Chirurgia    |
| Tecniche di Radiologia Medica per Immagini e Radioterapia                  | `radiologia`                          | Scuola di Medicina e Chirurgia    |
| Tecniche di Laboratorio Biomedico                                          | `laboratorio_biomedico`               | Scuola di Medicina e Chirurgia    |
| Tecniche di Fisiopatologia Cardiocircolatoria e Perfusione Cardiovascolare | `fisiopatologia_cardio`               | Scuola di Medicina e Chirurgia    |
| Igiene Dentale                                                             | `igiene_dentale`                      | Scuola di Medicina e Chirurgia    |
| Tecniche della Prevenzione nell'Ambiente e nei Luoghi di Lavoro            | `prevenzione_ambiente_lavoro`         | Scuola di Medicina e Chirurgia    |
| Scienze Motorie e Sportive                                                 | `scienze_motorie`                     | Scuola di Medicina e Chirurgia    |
| Scienze e Tecniche di Psicologia Cognitiva                                 | `psicologia_cognitiva_l`              | Scuola di Medicina e Chirurgia    |
| Ingegneria Informatica e Biomedica                                         | `ing_informatica_biomedica`           | Scuola di Medicina e Chirurgia    |
| Scienze Infermieristiche e Ostetriche (LM)                                 | `scienze_infermieristiche_ostetriche` | Scuola di Medicina e Chirurgia    |
| Scienze Riabilitative delle Professioni Sanitarie (LM)                     | `scienze_riabilitative`               | Scuola di Medicina e Chirurgia    |
| Scienze delle Professioni Sanitarie Tecniche Diagnostiche (LM)             | `prof_sanitarie_diagnostiche`         | Scuola di Medicina e Chirurgia    |
| Ingegneria Biomedica (LM)                                                  | `ing_biomedica`                       | Scuola di Medicina e Chirurgia    |
| Medicina e Chirurgia                                                       | `medicina_chirurgia`                  | Scuola di Medicina e Chirurgia    |
| Medicina e Chirurgia TD                                                    | `medicina_chirurgia_td`               | Scuola di Medicina e Chirurgia    |
| Odontoiatria e Protesi Dentaria                                            | `odontoiatria`                        | Scuola di Medicina e Chirurgia    |
| Psicologia Cognitiva e Neuroscienze (LM)                                   | `psicologia_cognitiva_neuroscienze`   | Scuola di Medicina e Chirurgia    |
| Psicologia Forense e Criminologica (LM)                                    | `psicologia_forense`                  | Scuola di Medicina e Chirurgia    |
| Scienze e Tecniche dello Sport (LM Interateneo)                            | `scienze_tecniche_sport`              | Scuola di Medicina e Chirurgia    |
| Scienze della Formazione Primaria (Interateneo Unical)                     | `formazione_primaria`                 | Scuola di Medicina e Chirurgia    |
| Biotecnologie                                                              | `biotecnologie`                       | Scuola di Farmacia e Nutraceutica |
| Scienze e Tecnologie delle Produzioni Animali                              | `produzioni_animali`                  | Scuola di Farmacia e Nutraceutica |
| Scienze Biologiche per l'Ambiente (Interateneo)                            | `biologiche_ambiente`                 | Scuola di Farmacia e Nutraceutica |
| Scienze e Tecnologie Cosmetiche e dei Prodotti del Benessere               | `cosmetiche`                          | Scuola di Farmacia e Nutraceutica |
| Farmacia                                                                   | `farmacia`                            | Scuola di Farmacia e Nutraceutica |
| Biotecnologie Innovative per la Salute (LM)                                | `biotecnologie_salute`                | Scuola di Farmacia e Nutraceutica |
| Scienze Chimiche e Cosmetiche (LM)                                         | `chimiche_cosmetiche`                 | Scuola di Farmacia e Nutraceutica |
| Scienze delle Investigazioni                                               | `scienze_investigazioni`              | Dipartimento DiGES                |
| Economia Aziendale                                                         | `economia_aziendale`                  | Dipartimento DiGES                |
| Organizzazione delle Amministrazioni Pubbliche e Private                   | `oapp`                                | Dipartimento DiGES                |
| Sociologia e Servizio Sociale                                              | `sociologia_servizio_sociale`         | Dipartimento DiGES                |
| Sociologia                                                                 | `sociologia`                          | Dipartimento DiGES                |
| Economia Aziendale e Management (LM)                                       | `economia_management`                 | Dipartimento DiGES                |
| Amministrazioni Pubbliche e Società (LM)                                   | `amministrazioni_societa`             | Dipartimento DiGES                |
| Giurisprudenza                                                             | `giurisprudenza`                      | Dipartimento DiGES                |
| Economia, Data Analysis e Settore Pubblico (LM)                            | `economia_data_analysis`              | Dipartimento DiGES                |
| Healthcare Management (LM)                                                 | `healthcare_management`               | Dipartimento DiGES                |

</details>

School groups are optional: with a school group, school notices go only there; without one, they reach every course group of that school. Group names for schools, Ateneo and Fondazione: `Scuola di Medicina e Chirurgia`, `Scuola di Farmacia e Nutraceutica`, `Dipartimento DiGES`, `Ateneo UMG - Avvisi Generali`, `Fondazione UMG - Avvisi Generali` (the last two come from the optional `group` field in `sources.json`, which sets the group name when it differs from the board name).

### Link the bot

1. Follow the logs: `ssh -t -i $KEY ubuntu@$IP "cd umg-news-bot && docker compose logs -f --no-log-prefix --tail 40"`.
2. With `WA_PAIRING_NUMBER` empty a QR is drawn (a new one every ~20 s; shrink the font with Ctrl + - if it looks distorted). On the phone: _WhatsApp Business → Linked devices → Link a device_ and scan the **latest** QR.
   With a number set, `PAIRING CODE: XXXX-XXXX` appears instead: _Link a device → Link with phone number instead_. The code only works on that exact number and expires in ~2 minutes.
   If nothing is scanned in time, the bot shows a new QR/code by itself after a short pause.
3. The logs show `whatsapp connected`. In the **"Message yourself"** chat the bot sends the report _"🔗 Associazione automatica gruppi → corsi"_ with the courses linked to their groups.

### Complete the links

In the **"Message yourself"** chat (see [WhatsApp commands](#whatsapp-commands)):

1. if the report lists courses _without a group_, create or rename those groups and send `!autoassocia`;
2. send `!gruppi`, find the community announcement group (marked `(bacheca)`) and link it with `!associa <number> ateneo fondazione`;
3. check with `!mappa` and preview a message with `!test giurisprudenza`;
4. share the group invite links with the students.

---

## Server setup history

How the production server was created in October 2026. Kept as a record and as the recipe to rebuild it from scratch.

1. **Oracle Cloud account** (Always Free), home region **Italy Northwest (Milan)**, compartment `assprimaverastudentescau (root)`.
2. **SSH key** created on the PC:

   ```powershell
   ssh-keygen -t ed25519 -f $HOME\.ssh\oracle_umg
   ```

3. **Network**: VCN `umg_news_vcn` with the public subnet `umg_news_bot_subnet` (`10.0.0.0/24`), the Internet Gateway `umg-news-igw`, the route rule `0.0.0.0/0 → umg-news-igw` in the default route table, and two ingress rules in the subnet's security list: TCP `22` (SSH) and TCP `8080` (feeds), both from `0.0.0.0/0`. On a new setup, _Networking → Virtual cloud networks → Start VCN Wizard → Create VCN with Internet Connectivity_ creates gateway and route automatically; only the `8080` rule must be added.
4. **Virtual machine** `umg-news-bot`: image _Canonical Ubuntu 24.04_ (x86_64), shape `VM.Standard.E2.1.Micro` (1/8 OCPU, 1 GB memory), in `umg_news_bot_subnet` with an automatically assigned public IPv4 address (`<server-IP>`) and the public key `oracle_umg.pub`.
5. **Server preparation** (on the server, via `ssh -i $HOME\.ssh\oracle_umg ubuntu@<server-IP>`): 2 GB of swap, Docker, and port 8080 in the local firewall.

   ```bash
   sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
   echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
   sudo apt update && sudo apt install -y docker.io docker-compose-v2
   sudo usermod -aG docker ubuntu
   sudo iptables -I INPUT 6 -p tcp --dport 8080 -j ACCEPT
   sudo netfilter-persistent save
   ```

6. **First deployment**: project copied to `~/umg-news-bot` (archive + `scp`, the same steps now automated by `scripts\deploy.ps1`), then on the server (the first build takes 10–15 minutes on the Micro machine):

   ```bash
   cd ~/umg-news-bot
   cp .env.example .env
   nano .env     # WA_ENABLED=true, BASE_URL=http://<server-IP>:8080, WA_PAIRING_NUMBER= (empty: QR)
   mkdir -p data && sudo chown 1000:1000 data && sudo chmod 700 data
   docker compose up -d --build
   ```

7. **WhatsApp**: community and groups prepared, bot linked by QR (the pairing code was refused by the phone with "couldn't link device"), links completed as in [WhatsApp setup](#whatsapp-setup-once).

To serve the feeds over HTTPS with a free domain, see [DEPLOY.md](DEPLOY.md) (in Italian).

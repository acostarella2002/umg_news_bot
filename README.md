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
9. [Step-by-step guide from Windows](#step-by-step-guide-from-windows)

---

## Features

- **Automatic board reading.** Every 15 minutes the bot reads the notice page of each degree course:
  - `medicina.unicz.it/corso_studio/*/avvisi`
  - `sfn.unicz.it/corso_studio/*/avvisi`
  - `diges.unicz.it/corso_studio/*/avvisi`

  It also reads the notices of the three schools, the university RSS feeds (`web.unicz.it`) and those of the UMG Foundation (calls and news).

- **RSS feeds.** The bot publishes one feed per course, per school, for the university and for the Foundation, plus an aggregated feed with every notice.
- **WhatsApp notifications.** Every **new** notice is sent to the group linked to its course. The message contains the title, the date, an excerpt of the text, the attachments and a link to the original notice.
- **School notices.** A notice published by a school automatically reaches every course of that school.
- **Managed from the phone.** Groups are linked to courses with simple commands written in the bot account's _"Message yourself"_ chat.

## How it works

The service is a single Node.js process running four independent activities, which communicate only through an SQLite database:

| Activity       | What it does                                                                            |
| -------------- | --------------------------------------------------------------------------------------- |
| **Poller**     | Every 15 minutes downloads the boards, detects new notices and fetches their full text. |
| **RSS server** | Serves the feeds and the service status on port 8080, read-only.                        |
| **Sender**     | Empties the WhatsApp message queue at a slow, human-like pace.                          |
| **Commands**   | Runs the commands the owner writes in the "Message yourself" chat.                      |

Two rules protect the groups from unwanted messages:

- **Silent first read.** The first time the bot reads a board, it stores every existing notice **without sending it**. From then on, only genuinely new notices are sent.
- **No retroactive sending.** When you link a group, it only receives notices published from that moment on. After a service interruption, only notices from the last 3 days are sent.

## Privacy and security

The bot is designed to know nothing about the people who read the groups.

- **No personal data.** The bot neither reads nor stores messages, phone numbers or names. It only processes the messages the owner writes in the "Message yourself" chat; everything else is discarded unread.
- **Minimal database.** It contains only public notices and group identifiers. There is no table for people.
- **Clean logs.** A filter masks WhatsApp identifiers and phone numbers before anything is written to the logs.
- **SSRF protection.** The bot downloads pages only from `*.unicz.it` and `*.fondazioneumg.it`, even after redirects. A malicious link inside a notice cannot make it contact other sites.
- **Read-only server.** The web server accepts no writes and sends security headers on every response.
- **Isolated container.** The container runs as an unprivileged user, with a read-only filesystem and no Linux capabilities.

These guarantees are checked automatically by the tests in `test/security.test.js`.

## Reducing the risk of a ban

The bot speaks the WhatsApp Web protocol through the Baileys library, which is not an official API. For this reason it behaves as cautiously as possible.

- **Groups only.** It uses the association's WhatsApp Business account as a "linked device" and writes only to groups. It never creates groups, sends invites or writes to individual people.
- **Human pace.** It waits a random 8–20 seconds between two messages and shows "typing…" before each one. When many notices arrive at once, it slows down to one message every 2–3 minutes.
- **Hourly cap.** It never sends more than 40 messages per hour and does not appear permanently "online".
- **Error handling.** A message that fails is retried after 5 and then 15 minutes, without blocking the other groups.
- **No floods.** The silent first read, the 3-day window and a publication-date check prevent mass sending, even when a website changes its structure.

## Configuration

### Environment variables

The configuration lives in the `.env` file, created on the server by copying `.env.example` (`cp .env.example .env`). The values in `.env.example` are the recommended ones and already include the bot's WhatsApp Business number, so on the server you normally only need to change `BASE_URL`.

> [!CAUTION]
> `.env.example` contains the bot's real phone number. Do not publish it in a public repository: a public number attracts spam and increases the risk of a ban. If you publish the code, replace it with a placeholder and keep the real number only in the server's `.env`.

| Variable             | Default                 | Description                                                                                                                                                                      |
| -------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BASE_URL`           | `http://localhost:8080` | Public address of the server, used in feed links (e.g. `http://<server-IP>:8080`).                                                                                               |
| `PORT`               | `8080`                  | HTTP port inside the container.                                                                                                                                                  |
| `POLL_MINUTES`       | `15`                    | Minutes between two board checks.                                                                                                                                                |
| `WA_ENABLED`         | `true`                  | Set to `false` to run the RSS feeds only, without WhatsApp.                                                                                                                      |
| `WA_PAIRING_NUMBER`  | already set             | Phone number of the **bot's** WhatsApp Business account, international format, digits only (country code `39` without `+`). Used only to obtain the pairing code the first time. |
| `SEND_MIN_DELAY_S`   | `8`                     | Minimum pause between two messages, in seconds.                                                                                                                                  |
| `SEND_MAX_DELAY_S`   | `20`                    | Maximum pause between two messages, in seconds.                                                                                                                                  |
| `SLOW_MIN_DELAY_S`   | `120`                   | Minimum pause when more than 10 messages are queued.                                                                                                                             |
| `SLOW_MAX_DELAY_S`   | `180`                   | Maximum pause when more than 10 messages are queued.                                                                                                                             |
| `MAX_SENDS_PER_HOUR` | `40`                    | Maximum number of messages per hour.                                                                                                                                             |
| `KEEPALIVE_DAYS`     | `6`                     | Days between two reminders in the "Message yourself" chat. Keep it well below 14 (see [Reminder](#reminder-to-open-the-phone)).                                                  |
| `LOG_LEVEL`          | `info`                  | Log detail: `fatal`, `error`, `warn`, `info`, `debug`.                                                                                                                           |

### Notice boards

The list of boards is in `config/sources.json`. To add a course, add an entry to the `courses` section with these fields:

- `id`: short identifier, **lowercase letters, digits and underscores only** (e.g. `ingegneria_biomedica`). Do not change it once in production: group links depend on it.
- `name`: human-readable name, shown in messages and feeds.
- `school`: `medicina`, `sfn` or `diges`. Determines which school notices the course receives.
- `url`: address of the course's notice page.

After the change, check that the new board is read correctly with `npm run check:sources`.

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

| Command                       | What it does                                               |
| ----------------------------- | ---------------------------------------------------------- |
| `!aiuto`                      | Lists the commands.                                        |
| `!stato`                      | Shows whether the bot is working.                          |
| `!autoassocia`                | Links every course to the group with the same name.        |
| `!gruppi`                     | Lists the groups the bot belongs to, numbered.             |
| `!target [word]`              | Lists the ids of courses, schools and sources.             |
| `!associa <group> <target…>`  | Links a group to one or more targets.                      |
| `!dissocia <group> <target…>` | Removes a link.                                            |
| `!mappa`                      | Shows every link and flags the broken ones.                |
| `!test <target>`              | Previews the latest notice of a target, only in this chat. |
| `!pausa` / `!riprendi`        | Stops or restarts sending to the groups.                   |

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

- **Ultimo controllo** (last check): when the boards were last read, in UTC time (Italian time minus 1 or 2 hours). It should never be older than about 15 minutes.
- **In coda** (queued): messages waiting to be sent. A few dozen right after many notices is normal: the bot sends them slowly on purpose.
- **Inviati ultima ora** (sent in the last hour): never above 40.
- **Falliti ultime 24h** (failed in the last 24 hours): should be `0`. If not, a group is not receiving: usually the bot is not an admin of a group where only admins can write, or it was removed from a group. Check with `!mappa`.
- **Collegamenti** (links): how many group–target links exist.
- **Invii** (sending): `▶️ attivi` (active) or `⏸️ in pausa` (paused, see `!pausa`).

#### `!autoassocia` — link the courses automatically

Links every course of `config/sources.json` to the WhatsApp group whose name is **exactly the course name** (upper/lower case, accents, apostrophe style and extra spaces do not matter). This is the recommended way to do the first setup: it avoids linking a group to the wrong course. The exact names are listed in [step C.1](#c1-prepare-the-community-once).

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

#### `!pausa` and `!riprendi` — emergency stop

`!pausa` stops every message to the groups immediately; RSS feeds keep working and new notices keep piling up in the queue. `!riprendi` restarts sending. Use it if something looks wrong, for example a burst of unexpected messages.

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
| `whatsapp: "logged_out"` | WhatsApp has unlinked the bot. Link it again (see [D.3](#d3-relink-whatsapp)).                                    |
| `whatsapp: "replaced"`   | Another copy of the bot is using the same session. Shut it down: the bot reconnects on its own within 15 minutes. |

## Development

### Main commands

| Command                 | Description                                                             |
| ----------------------- | ----------------------------------------------------------------------- |
| `npm ci`                | Installs the dependencies exactly at the locked versions.               |
| `npm test`              | Runs the 56 automated tests (modules, security, end-to-end flow).       |
| `npm run lint`          | Checks the code with ESLint.                                            |
| `npm run format:check`  | Checks formatting with Prettier (`npm run format` fixes it).            |
| `npm run check:sources` | Checks every board live and reports the empty or unreachable ones.      |
| `npm run poll:once`     | Runs one real cycle on an in-memory database, without sending messages. |
| `npm start`             | Starts the full service.                                                |

### Project structure

```
src/            application code (poller, parsers, database, server, WhatsApp)
config/         sources.json, the list of notice boards
scripts/        check tools (check-sources, poll-once)
test/           automated tests and real pages saved as fixtures
brain/          full technical documentation (Obsidian vault, in Italian)
data/           database and WhatsApp session, created at startup (not versioned)
```

### Technical documentation

The `brain/` folder is an [Obsidian](https://obsidian.md) vault (in Italian) that describes in detail the architecture, the notice flow, the database schema, the privacy and anti-ban invariants, the coding conventions and the procedures for changing the code. Before modifying the code, start from `brain/00 - Indice.md`.

---

## Step-by-step guide from Windows

This guide takes the project from scratch to a service running 24/7 on a free Oracle Cloud server, using only the Windows terminal (**PowerShell**). From step B.4 onwards, some commands run **on the server** after you connect over SSH: they are shown in `bash` blocks.

> [!IMPORTANT]
> The bot must run in **one place at a time**. If you start it on your PC with WhatsApp enabled while it is also running on the server, the groups will receive duplicate messages. For local tests always use `WA_ENABLED=false`.

### Part A — Local test

#### A.1 Set up Node.js

The project needs Node.js 22.13 or later. A portable Node is already included in `.tools\node`: to use it, open PowerShell in the project folder and add it to the `PATH` of the current session.

```powershell
cd $HOME\Desktop\umg-news-bot
$env:Path = "$PWD\.tools\node;$env:Path"
node --version
```

Alternatively, install Node.js permanently with `winget install OpenJS.NodeJS.LTS` and reopen the terminal.

#### A.2 Install and verify

```powershell
npm ci
npm test
npm run check:sources
```

`npm test` must end with `fail 0`; `check:sources` must show a number of notices for every board, with no `ERROR` or `EMPTY` lines.

#### A.3 Start the RSS feeds only

```powershell
$env:WA_ENABLED = "false"
npm start
```

Open `http://localhost:8080/feeds` in the browser to see the list of feeds, and `http://localhost:8080/health` for the status. Press `Ctrl+C` to stop the service, then close the terminal (or run `Remove-Item Env:WA_ENABLED`) to clear the setting.

#### A.4 (Optional) Test with Docker Desktop

If you have installed [Docker Desktop](https://www.docker.com/products/docker-desktop/), you can test the container exactly as it will run on the server:

```powershell
Copy-Item .env.example .env
notepad .env
```

In the file set `WA_ENABLED=false`, save and close. Then:

```powershell
docker compose up -d --build
docker compose ps
curl.exe http://localhost:8080/health
docker compose down
```

Before moving on, delete the `data` folder created by the test (`Remove-Item -Recurse -Force data`), so the server starts with a clean database.

### Part B — Free server on Oracle Cloud

#### B.1 Create an SSH key

The SSH key lets you connect to the server securely, without a password. Windows 10 and 11 already include the OpenSSH client.

```powershell
ssh-keygen -t ed25519 -f $HOME\.ssh\oracle_umg
Get-Content $HOME\.ssh\oracle_umg.pub | Set-Clipboard
```

The second command copies the **public** key to the clipboard: you will need it in the next step. Never share the file without the `.pub` extension: it is the private key.

#### B.2 Create the account and the virtual machine

1. Sign up at [cloud.oracle.com](https://cloud.oracle.com) choosing the **Always Free** plan. A card is required to verify your identity, but Always Free resources are never charged.
2. Open **Compute → Instances → Create instance** and set:
   - **Image**: Canonical Ubuntu 24.04;
   - **Shape**: `VM.Standard.A1.Flex` (Ampere ARM) with 1 OCPU and 6 GB of memory;
   - **Add SSH keys → Paste public keys**: paste the key copied in step B.1.
3. Click **Create** and wait for the state to become _Running_. Write down the **Public IP address** shown on the instance page.

> [!NOTE]
> If you get an _Out of capacity_ error, the free ARM machines are temporarily sold out in your zone: try again later or pick another _Availability Domain_.

> [!WARNING]
> Oracle may reclaim Always Free instances that stay underused for a week, and this bot uses very few resources. To prevent it, upgrade the account to **Pay As You Go** (_Billing → Upgrade_): Always Free resources remain free.

#### B.3 Open the feed port

To make the RSS feeds reachable from the Internet, open port 8080:

1. From the instance page open the **Subnet** → default **Security List** → **Add Ingress Rules**.
2. Set **Source CIDR** `0.0.0.0/0`, **IP Protocol** `TCP`, **Destination Port Range** `8080` and save.

#### B.4 Connect to the server and install Docker

From PowerShell, replacing `<IP>` with the address noted in step B.2:

```powershell
ssh -i $HOME\.ssh\oracle_umg ubuntu@<IP>
```

On the first connection confirm with `yes`. You are now on the server: run the following commands.

```bash
sudo apt update && sudo apt install -y docker.io docker-compose-v2
sudo usermod -aG docker $USER
sudo iptables -I INPUT 6 -p tcp --dport 8080 -j ACCEPT
sudo netfilter-persistent save
exit
```

The `iptables` command also opens the port in Ubuntu's internal firewall, which is enabled on Oracle images. `exit` closes the session: when you reconnect, your user will be able to run Docker without `sudo`.

#### B.5 Copy the project to the server

Go back to PowerShell **on your PC**, in the project folder. Create an archive without the folders the server does not need, and upload it:

```powershell
cd $HOME\Desktop\umg-news-bot
tar -czf ..\umg-news-bot.tgz --exclude=node_modules --exclude=.tools --exclude=data --exclude=.env --exclude=brain .
scp -i $HOME\.ssh\oracle_umg ..\umg-news-bot.tgz ubuntu@<IP>:~/
ssh -i $HOME\.ssh\oracle_umg ubuntu@<IP>
```

On the server, extract the archive:

```bash
mkdir -p ~/umg-news-bot && tar -xzf ~/umg-news-bot.tgz -C ~/umg-news-bot && rm ~/umg-news-bot.tgz
cd ~/umg-news-bot
```

#### B.6 Configure and start

```bash
cp .env.example .env
nano .env
```

The file already contains the recommended values and the bot's number. In the editor:

- set `BASE_URL` to `http://<IP>:8080` (the feed links depend on it);
- check that `WA_ENABLED=true` and that `WA_PAIRING_NUMBER` is the number of the bot's WhatsApp Business account.

Save with `Ctrl+O`, `Enter`, and exit with `Ctrl+X`. Then prepare the data folder (it must belong to the container user, UID 1000) and start the service:

```bash
mkdir -p data && sudo chown 1000:1000 data && chmod 700 data
docker compose up -d --build
docker compose logs -f
```

The first build takes a few minutes. Wait for the `PAIRING CODE: XXXX-XXXX` line in the logs and move on to part C without closing the logs.

### Part C — Link WhatsApp and the groups

#### C.1 Prepare the community (once)

From the phone with the **bot's WhatsApp Business account**:

1. create the _"UMG automated news by Primavera Studentesca UMG"_ community;
2. inside the community, create one group per course, naming each group **exactly like the course** in the table below (upper/lower case, accents and apostrophe style do not matter; every other character does, including the text in brackets);
3. in every group set _Group settings → Send messages → Only admins_;
4. make the association's administrators admins of the community: they will post manually in the community announcement group.

Since the groups are created from the bot's account, the bot is automatically an admin and can write in them. Creating the groups **before** step C.2 lets the bot link them all by itself as soon as it connects.

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

You do not need groups for the schools: a school's notices already reach all its courses. If you add or rename a course in `config/sources.json`, the group name must follow the new `name`.

#### C.2 Link the bot

1. On the phone open _WhatsApp Business → Linked devices → Link a device → Link with phone number instead_.
2. Enter the `XXXX-XXXX` code shown in the logs.
3. The logs show `whatsapp connected`. Press `Ctrl+C` to leave the logs: the service keeps running in the background.
4. Within a few seconds the bot writes in your **"Message yourself"** chat the report _"🔗 Associazione automatica gruppi → corsi"_ with the courses it has linked to their groups.

#### C.3 Complete and check the links

All the following commands are written in the **"Message yourself"** chat (see [WhatsApp commands](#whatsapp-commands) for a full explanation of each one).

1. **Read the automatic report.** If it lists courses under _"Nessun gruppo con il nome del corso"_ (no group with the course name), create those groups or fix their names, then send `!autoassocia`. Repeat until the list is empty or contains only courses you do not want a group for.
2. **Link the community announcement group** to university and Foundation notices:
   - send `!gruppi` and find the line marked `(bacheca)`, e.g. `1. UMG automated news… (bacheca)`;
   - send `!associa 1 ateneo fondazione` (using that number) and check the group name in the reply.
3. **Check everything:** send `!mappa` (every course should show its group, with no ⚠️) and `!test giurisprudenza` to preview a message.
4. **Share the group invite links** yourself: the bot never does it, to reduce the risk of a ban.

#### C.4 Check from your PC

```powershell
curl.exe http://<IP>:8080/health
curl.exe http://<IP>:8080/feeds
```

`/health` must answer with `"ok":true` and `"whatsapp":"connected"`.

### Part D — Maintenance

#### D.1 Update the code

On the PC, rebuild the archive and upload it as in step B.5. On the server:

```bash
tar -xzf ~/umg-news-bot.tgz -C ~/umg-news-bot && rm ~/umg-news-bot.tgz
cd ~/umg-news-bot && docker compose up -d --build
```

The `.env` file and the `data/` folder on the server are left untouched: notices, links and the WhatsApp session stay as they are.

#### D.2 Make a backup

On the server, stop the service for a few seconds (so the database is copied in a consistent state), archive the data folder and start it again:

```bash
cd ~/umg-news-bot
docker compose stop
sudo tar -czf ~/backup-data.tgz data && sudo chown $USER ~/backup-data.tgz
docker compose start
```

From the PC, download it:

```powershell
scp -i $HOME\.ssh\oracle_umg ubuntu@<IP>:~/backup-data.tgz .
```

The backup contains the WhatsApp session: keep it somewhere private and **never start it on your PC** while the bot is running on the server.

#### D.3 Relink WhatsApp

If `/health` reports `"whatsapp":"logged_out"` or the logs show `logged out`, WhatsApp has unlinked the bot. On the server:

```bash
cd ~/umg-news-bot
docker compose down
sudo rm -rf data/wa-auth
docker compose up -d
docker compose logs -f
```

Then repeat step C.2 with the new code. Group links remain valid.

#### D.4 Periodic checks

- Open WhatsApp Business on the primary phone at least once every 14 days: the bot reminds you every week.
- Check the status with `docker compose ps` (on the server) or `curl.exe http://<IP>:8080/health` (from the PC).
- Read the latest events with `docker compose logs --tail 100`.
- At the start of each academic year run `npm run check:sources` on the PC to spot moved boards or new courses.

To serve the feeds over HTTPS with a free domain, follow the _HTTPS_ section of [DEPLOY.md](DEPLOY.md) (in Italian).

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

The configuration lives in the `.env` file, created from `.env.example`.

| Variable             | Default                 | Description                                                                                                                                       |
| -------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BASE_URL`           | `http://localhost:8080` | Public address of the server, used in feed links (e.g. `http://<server-IP>:8080`).                                                                |
| `PORT`               | `8080`                  | HTTP port inside the container.                                                                                                                   |
| `POLL_MINUTES`       | `15`                    | Minutes between two board checks.                                                                                                                 |
| `WA_ENABLED`         | `true`                  | Set to `false` to run the RSS feeds only, without WhatsApp.                                                                                       |
| `WA_PAIRING_NUMBER`  | —                       | Phone number of the **bot's** WhatsApp Business account, international format, digits only (e.g. `393331234567`). Needed only for the first link. |
| `SEND_MIN_DELAY_S`   | `8`                     | Minimum pause between two messages, in seconds.                                                                                                   |
| `SEND_MAX_DELAY_S`   | `20`                    | Maximum pause between two messages, in seconds.                                                                                                   |
| `SLOW_MIN_DELAY_S`   | `120`                   | Minimum pause when more than 10 messages are queued.                                                                                              |
| `SLOW_MAX_DELAY_S`   | `180`                   | Maximum pause when more than 10 messages are queued.                                                                                              |
| `MAX_SENDS_PER_HOUR` | `40`                    | Maximum number of messages per hour.                                                                                                              |
| `KEEPALIVE_DAYS`     | `7`                     | Days between two reminders in the "Message yourself" chat.                                                                                        |
| `LOG_LEVEL`          | `info`                  | Log detail: `fatal`, `error`, `warn`, `info`, `debug`.                                                                                            |

### Notice boards

The list of boards is in `config/sources.json`. To add a course, add an entry to the `courses` section with these fields:

- `id`: short identifier, **lowercase letters, digits and underscores only** (e.g. `ingegneria_biomedica`). Do not change it once in production: group links depend on it.
- `name`: human-readable name, shown in messages and feeds.
- `school`: `medicina`, `sfn` or `diges`. Determines which school notices the course receives.
- `url`: address of the course's notice page.

After the change, check that the new board is read correctly with `npm run check:sources`.

## WhatsApp commands

Commands are written **only** in the _"Message yourself"_ chat (_"Messaggio a te stesso"_ on Italian phones) of the bot's WhatsApp Business account, from the primary phone. They are ignored in any other chat. Upper and lower case are equivalent. The bot replies in Italian.

| Command                        | Effect                                                                    |
| ------------------------------ | ------------------------------------------------------------------------- |
| `!aiuto`                       | Shows the list of commands.                                               |
| `!stato`                       | Shows the last check, queued, sent and failed messages, and links.        |
| `!gruppi`                      | Lists, numbered, the groups the bot belongs to.                           |
| `!target [filter]`             | Lists the identifiers of courses, schools and feeds.                      |
| `!associa <n\|jid> <target…>`  | Links a group to one or more targets, after checking the bot is a member. |
| `!dissocia <n\|jid> <target…>` | Unlinks a group.                                                          |
| `!mappa`                       | Shows the current links and flags those that are no longer valid.         |
| `!test <target>`               | Shows a preview of the latest notice, visible only to you.                |
| `!pausa` / `!riprendi`         | Pauses or resumes sending.                                                |

**Example.** `!gruppi` returns the numbered list; `!associa 3 medicina_chirurgia` links group no. 3 to the Medicine and Surgery course. With `!associa 1 ateneo fondazione` you link several targets to the same group, for instance the community announcement group. The bot replies with the name of the linked group: always check it.

**Weekly reminder.** Every 7 days the bot writes a status summary in the "Message yourself" chat. It reminds you to open WhatsApp Business on the primary phone: if the phone stays offline for about 14 days, WhatsApp unlinks the bot.

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
| `npm test`              | Runs the 54 automated tests (modules, security, end-to-end flow).       |
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

In the editor set at least:

- `WA_PAIRING_NUMBER` to the number of the bot's WhatsApp Business account (e.g. `393331234567`);
- `BASE_URL` to `http://<IP>:8080`;
- `WA_ENABLED=true`.

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

1. create the _"UMG automated news by Primavera Studentesca UMG"_ community and one group per course;
2. in every group set _Group settings → Send messages → Only admins_;
3. make the association's administrators admins of the community: they will post manually in the community announcement group.

Since the groups are created from the bot's account, the bot is automatically an admin and can write in them.

#### C.2 Link the bot

1. On the phone open _WhatsApp Business → Linked devices → Link a device → Link with phone number instead_.
2. Enter the `XXXX-XXXX` code shown in the logs.
3. The logs show `whatsapp connected`. Press `Ctrl+C` to leave the logs: the service keeps running in the background.

#### C.3 Link the groups to the courses

In the **"Message yourself"** chat, write one at a time:

1. `!gruppi`: note the number of each group;
2. `!target medicina`: find the course identifiers;
3. `!associa 3 medicina_chirurgia`: repeat for every group and check the group name in the reply;
4. `!associa 1 ateneo fondazione`: link the community announcement group to the university and Foundation notices;
5. `!mappa` and `!test medicina_chirurgia`: check the links and the preview.

You do not need to link the schools to the course groups: a school's notices already reach all its courses. Share the group invite links yourself: the bot does not do it, to reduce the risk of a ban.

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

// Owner commands, accepted ONLY in the bot account's own "Message yourself" chat.
// Whoever holds the primary phone owns the bot: no phone numbers or hashes need to be stored.
import { normalizeMessageContent } from '@whiskeysockets/baileys'; // unwraps disappearing / view-once / edited wrappers
import {
  getKv,
  setKv,
  mapGroup,
  unmapGroup,
  listMappings,
  latestNotices,
  pendingDeliveries,
  sentLastHour,
  failedLastDay,
  queueLatest,
  skipPending,
} from '../db.js'; // storage
import { formatNotice } from './format.js'; // preview rendering

// "39333…:12@s.whatsapp.net" -> "39333…@s.whatsapp.net" (drop device suffix).
const bare = (jid) => (jid ? `${jid.split('@')[0].split(':')[0]}@${jid.split('@')[1]}` : ''); // normalized user JID

// True when the message was written by the account itself in its self chat (phone-number or LID form).
export const isSelfChat = (msg, user) => Boolean(msg?.key?.fromMe) && [user?.id, user?.lid].filter(Boolean).some((j) => bare(j) === bare(msg.key.remoteJid)); // self chat only

// From a batch of incoming messages keep only fresh owner commands; everything else is dropped unread.
export const ownerCommands = (messages, user, nowSec = Date.now() / 1000) =>
  messages.filter((m) => isSelfChat(m, user) && nowSec - Number(m.messageTimestamp) <= 120); // self chat + not replayed history

// Extract plain text from a Baileys message (simple or extended text).
export const textOf = (msg) => {
  const m = normalizeMessageContent(msg?.message); // with disappearing messages on, the text is wrapped in ephemeralMessage
  return m?.conversation ?? m?.extendedTextMessage?.text ?? ''; // other types ignored
};

// Group names are compared loosely: case, accents, curly apostrophes (phone keyboards) and extra spaces do not matter.
export const normalizeName = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '') // drop accents
    .replace(/[‘’`´]/g, "'") // ’ ‘ ` ´ -> '
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

// Target id typed on a phone: lowercase, keeping only id characters (drops "<…>", a final ".", invisible characters).
export const asId = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '');

// Show a typed argument with invisible/non-ASCII characters spelled out ("a[U+200B]b"), to diagnose phone keyboards.
const shown = (s) => [...String(s ?? '')].map((c) => (/[\x21-\x7e]/.test(c) ? c : `[U+${c.codePointAt(0).toString(16).toUpperCase()}]`)).join('');

// Link every course without a group to the group named exactly like the course in sources.json.
// force = false (automatic run at connection): each course is auto-linked only once, so a later !dissocia is respected.
export async function autoLink({ db, sock, courses, force }) {
  const byName = new Map(); // normalized group name -> groups with that name (participants are NOT read)
  for (const g of Object.values(await sock.groupFetchAllParticipating()))
    if (!g.isCommunity) byName.set(normalizeName(g.subject), [...(byName.get(normalizeName(g.subject)) ?? []), g]); // the community itself cannot receive messages
  const mapped = new Set(listMappings(db).map((m) => m.target)); // courses that already have a group
  const result = { linked: [], already: 0, ambiguous: [], missing: [] }; // [id, name or group subject] pairs
  for (const [id, name] of courses) {
    if (mapped.has(id))
      result.already++; // never touch an existing link
    else if (!force && getKv(db, `automap:${id}`))
      continue; // auto-linked once and later unlinked by the owner
    else {
      const found = byName.get(normalizeName(name)) ?? []; // groups with the course name
      if (found.length === 1) {
        mapGroup(db, id, found[0].id); // link
        setKv(db, `automap:${id}`, found[0].id); // remember it was done
        result.linked.push([id, found[0].subject]);
      } else (found.length ? result.ambiguous : result.missing).push([id, name]); // two groups with one name, or none
    }
  }
  return result;
}

// Readable summary of an autoLink run (never starts with "!").
export const autoLinkReport = (r) =>
  [
    '🔗 *Associazione automatica gruppi → corsi*',
    r.linked.length ? `✅ Collegati ora (${r.linked.length}):\n${r.linked.map(([id, s]) => `• ${s} → ${id}`).join('\n')}` : '✅ Nessun nuovo collegamento.',
    `☑️ Corsi che avevano già un gruppo: ${r.already}`,
    r.ambiguous.length &&
      `⚠️ Più gruppi con lo stesso nome, collegali a mano con !associa (${r.ambiguous.length}):\n${r.ambiguous.map(([, n]) => `• ${n}`).join('\n')}`,
    r.missing.length && `❓ Nessun gruppo con il nome del corso (${r.missing.length}):\n${r.missing.map(([, n]) => `• ${n}`).join('\n')}`,
  ]
    .filter(Boolean)
    .join('\n\n');

// Help text listing every command.
const HELP = [
  '🤖 *Comandi UMG News Bot*',
  '!stato – stato del bot',
  '!autoassocia – collega ogni corso/scuola/feed al gruppo con lo stesso nome',
  '!gruppi – elenca i gruppi in cui è il bot (numerati)',
  '!target [filtro] – elenca gli id di corsi/scuole/feed',
  '!associa <n|jid> <target> [target…] – collega un gruppo',
  '!dissocia <n|jid> <target> – scollega',
  '!mappa – collegamenti attuali',
  "!test <target> – anteprima dell'ultimo avviso (solo qui)",
  "!prova [target] – invia nei gruppi l'ultimo avviso di ogni corso collegato (o di uno)",
  '!pausa / !riprendi – ferma o riprende gli invii',
  '!svuota – annulla tutti i messaggi in coda (gli avvisi restano nel feed RSS)',
].join('\n'); // one command per line

// Handle one command; returns the reply text (null when the text is not a command).
// state.groups caches the last !gruppi listing so groups can be referenced by number.
export async function handleCommand(text, { db, sock, names, state, courses = new Map() }) {
  if (!text.startsWith('!')) return null; // replies of the bot never start with "!"
  const [raw, ...args] = text.trim().split(/[\s\u200b-\u200d\u2060\ufeff]+/); // command + arguments; zero-width characters from phone keyboards count as spaces
  const cmd = raw.toLowerCase(); // phones auto-capitalise the first letter ("!Associa")
  // Resolve "3" (index from !gruppi) or a raw group JID; only group JIDs are accepted.
  const groupArg = (a) => (/^\d{1,3}$/.test(a) ? state.groups?.[Number(a) - 1]?.id : a)?.match(/^[\d-]+@g\.us$/)?.[0]; // undefined if invalid
  // Groups the bot is in right now, by JID (participants are NOT read or stored).
  const liveGroups = async () => new Map(Object.values(await sock.groupFetchAllParticipating()).map((g) => [g.id, g]));
  switch (cmd) {
    case '!aiuto':
    case '!help':
      return HELP; // command list
    case '!autoassocia':
      return autoLinkReport(await autoLink({ db, sock, courses, force: true })); // explicit request: also re-links courses unlinked earlier
    case '!stato':
      return [
        '📊 *Stato*', // header
        `Ultimo controllo: ${getKv(db, 'last_poll') ?? 'mai'}`, // last poll time
        `In coda: ${pendingDeliveries(db).length}`, // pending messages
        `Inviati ultima ora: ${sentLastHour(db)}`, // rate usage
        `Falliti ultime 24h: ${failedLastDay(db)}`, // broken links show up here (bot removed, not admin…)
        `Collegamenti: ${listMappings(db).length}`, // mapped groups
        `Invii: ${getKv(db, 'paused') === '1' ? '⏸️ in pausa' : '▶️ attivi'}`, // pause flag
      ].join('\n');
    case '!gruppi': {
      const all = Object.values(await sock.groupFetchAllParticipating()); // groups the bot is in (participants are NOT read or stored)
      state.groups = all.filter((g) => !g.isCommunity).sort((a, b) => a.subject.localeCompare(b.subject)); // communities themselves cannot receive messages
      return state.groups.length
        ? state.groups.map((g, i) => `${i + 1}. ${g.subject}${g.linkedParent ? ' 🏘️' : ''}${g.isCommunityAnnounce ? ' (bacheca)' : ''}\n   ${g.id}`).join('\n') // numbered list
        : 'Il bot non è in nessun gruppo.'; // empty
    }
    case '!target': {
      const f = (args[0] ?? '').toLowerCase(); // optional filter
      return (
        [...names]
          .filter(([id, n]) => !f || id.includes(f) || n.toLowerCase().includes(f))
          .map(([id, n]) => `${id} – ${n}`)
          .join('\n') || 'Nessun target.'
      ); // id list
    }
    case '!associa':
    case '!dissocia': {
      const jid = groupArg(args[0] ?? ''); // group to (un)map
      const targets = args.slice(1).map(asId).filter(Boolean); // ids are always lowercase
      if (!jid || !targets.length) return `Uso: ${cmd} <n|jid> <target> [target…] (prima usa !gruppi)`; // usage
      const linked = new Set(listMappings(db).flatMap((m) => (m.jid === jid ? [m.target] : []))); // current links of this group
      const bad = targets.filter((t) => !names.has(t) && !(cmd === '!dissocia' && linked.has(t))); // a course removed from sources.json can still be unlinked
      if (bad.length) return `Target sconosciuti: ${bad.join(', ')} (ricevuto: ${args.slice(1).map(shown).join(' ')}; vedi !target)`; // refuse typos
      if (cmd === '!dissocia') {
        for (const t of targets) unmapGroup(db, t, jid); // works even if the bot already left the group
        return `✅ Scollegato: ${targets.join(', ')}`; // confirmation
      }
      const group = (await liveGroups()).get(jid); // the bot must really be in the group, or every send would fail
      if (!group) return 'Il bot non è in questo gruppo: rifai !gruppi e controlla il numero.'; // stale index or typo in the JID
      if (group.isCommunity) return 'Questa è la community: collega la sua bacheca (gruppo annunci), non la community.'; // cannot receive messages
      for (const t of targets) mapGroup(db, t, jid); // apply
      return `✅ Collegato a "${group.subject}": ${targets.join(', ')}`; // group name lets the owner spot a wrong index
    }
    case '!mappa': {
      const rows = listMappings(db); // current links
      if (!rows.length) return 'Nessun collegamento.'; // empty
      const groups = await liveGroups(); // check each link against the real group list
      return rows.map((m) => `${m.target} → ${groups.get(m.jid)?.subject ?? '⚠️ bot non più nel gruppo'}\n   ${m.jid}`).join('\n'); // mapping table
    }
    case '!test': {
      const target = asId(args[0]); // board id
      if (!names.has(target))
        return target ? `Target sconosciuto: ${target} (ricevuto: ${shown(args[0])}; vedi !target)` : 'Uso: !test <target>, es. !test farmacia'; // validation
      const [n] = latestNotices(db, target, 1); // newest notice
      return n ? `🧪 Anteprima:\n\n${formatNotice(n, names.get(target))}` : 'Nessun avviso per questo target.'; // preview only in self chat
    }
    case '!prova': {
      const target = asId(args[0]); // optional single board
      if (target && !names.has(target)) return `Target sconosciuto: ${target} (ricevuto: ${shown(args[0])}; vedi !target)`; // validation
      const n = queueLatest(db, target); // goes through the normal queue: pauses, hourly cap, retries
      return n
        ? `🧪 ${n} messaggi di prova in coda. Partono a ritmo anti-ban (con più di 10 in coda, uno ogni 2–3 minuti). Segui con !stato, ferma con !pausa.`
        : 'Niente da mettere in coda: nessun collegamento, nessun avviso, o già inviato.';
    }
    case '!svuota':
      return `🗑️ Coda svuotata: ${skipPending(db)} messaggi annullati. Gli avvisi nuovi da ora in poi verranno inviati normalmente.`; // emergency clean-up
    case '!pausa':
      setKv(db, 'paused', '1'); // stop the sender
      return '⏸️ Invii in pausa.';
    case '!riprendi':
      setKv(db, 'paused', '0'); // resume the sender
      return '▶️ Invii ripresi.';
    default:
      return 'Comando sconosciuto. Scrivi !aiuto'; // unknown command
  }
}

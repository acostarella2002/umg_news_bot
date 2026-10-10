// Owner commands, accepted ONLY in the bot account's own "Message yourself" chat.
// Whoever holds the primary phone owns the bot: no phone numbers or hashes need to be stored.
import { normalizeMessageContent } from '@whiskeysockets/baileys'; // unwraps disappearing / view-once / edited wrappers
import { getKv, setKv, mapGroup, unmapGroup, listMappings, latestNotices, pendingDeliveries, sentLastHour, failedLastDay } from '../db.js'; // storage
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

// Help text listing every command.
const HELP = [
  '🤖 *Comandi UMG News Bot*',
  '!stato – stato del bot',
  '!gruppi – elenca i gruppi in cui è il bot (numerati)',
  '!target [filtro] – elenca gli id di corsi/scuole/feed',
  '!associa <n|jid> <target> [target…] – collega un gruppo',
  '!dissocia <n|jid> <target> – scollega',
  '!mappa – collegamenti attuali',
  "!test <target> – anteprima dell'ultimo avviso (solo qui)",
  '!pausa / !riprendi – ferma o riprende gli invii',
].join('\n'); // one command per line

// Handle one command; returns the reply text (null when the text is not a command).
// state.groups caches the last !gruppi listing so groups can be referenced by number.
export async function handleCommand(text, { db, sock, names, state }) {
  if (!text.startsWith('!')) return null; // replies of the bot never start with "!"
  const [raw, ...args] = text.trim().split(/\s+/); // command + arguments
  const cmd = raw.toLowerCase(); // phones auto-capitalise the first letter ("!Associa")
  // Resolve "3" (index from !gruppi) or a raw group JID; only group JIDs are accepted.
  const groupArg = (a) => (/^\d{1,3}$/.test(a) ? state.groups?.[Number(a) - 1]?.id : a)?.match(/^[\d-]+@g\.us$/)?.[0]; // undefined if invalid
  // Groups the bot is in right now, by JID (participants are NOT read or stored).
  const liveGroups = async () => new Map(Object.values(await sock.groupFetchAllParticipating()).map((g) => [g.id, g]));
  switch (cmd) {
    case '!aiuto':
    case '!help':
      return HELP; // command list
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
      const targets = args.slice(1).map((t) => t.toLowerCase()); // ids are always lowercase
      if (!jid || !targets.length) return `Uso: ${cmd} <n|jid> <target> [target…] (prima usa !gruppi)`; // usage
      const linked = new Set(listMappings(db).flatMap((m) => (m.jid === jid ? [m.target] : []))); // current links of this group
      const bad = targets.filter((t) => !names.has(t) && !(cmd === '!dissocia' && linked.has(t))); // a course removed from sources.json can still be unlinked
      if (bad.length) return `Target sconosciuti: ${bad.join(', ')} (vedi !target)`; // refuse typos
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
      const target = args[0]?.toLowerCase(); // board id
      if (!names.has(target)) return 'Uso: !test <target> (vedi !target)'; // validation
      const [n] = latestNotices(db, target, 1); // newest notice
      return n ? `🧪 Anteprima:\n\n${formatNotice(n, names.get(target))}` : 'Nessun avviso per questo target.'; // preview only in self chat
    }
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

// Owner commands, accepted ONLY in the bot account's own "Message yourself" chat.
// Whoever holds the primary phone owns the bot: no phone numbers or hashes need to be stored.
import { normalizeMessageContent } from '@whiskeysockets/baileys'; // unwraps disappearing / view-once / edited wrappers
import {
  getStateValue,
  setStateValue,
  linkGroup,
  unlinkGroup,
  listGroupLinks,
  latestNotices,
  pendingDeliveries,
  countSentLastHour,
  countFailedLastDay,
  queueLatestNoticePerGroup,
  cancelPendingDeliveries,
} from '../db.js'; // storage
import { formatNotice, formatRomeDate } from './format.js'; // preview rendering and Italian time

// "39333…:12@s.whatsapp.net" -> "39333…@s.whatsapp.net" (drop device suffix).
export const withoutDeviceSuffix = (jid) => (jid ? `${jid.split('@')[0].split(':')[0]}@${jid.split('@')[1]}` : ''); // normalized user JID

// True when the message was written by the account itself in its self chat (phone-number or LID form).
export const isSelfChat = (message, user) =>
  Boolean(message?.key?.fromMe) &&
  [user?.id, user?.lid].filter(Boolean).some((ownJid) => withoutDeviceSuffix(ownJid) === withoutDeviceSuffix(message.key.remoteJid)); // self chat only

// From a batch of incoming messages keep only fresh owner commands; everything else is dropped unread.
export const filterOwnerCommands = (messages, user, nowSeconds = Date.now() / 1000) =>
  messages.filter((message) => isSelfChat(message, user) && nowSeconds - Number(message.messageTimestamp) <= 120); // self chat + not replayed history

// Extract plain text from a Baileys message (simple or extended text).
export const extractMessageText = (message) => {
  const content = normalizeMessageContent(message?.message); // with disappearing messages on, the text is wrapped in ephemeralMessage
  return content?.conversation ?? content?.extendedTextMessage?.text ?? ''; // other types ignored
};

// Group names are compared loosely: case, accents, curly apostrophes (phone keyboards) and extra spaces do not matter.
export const normalizeGroupName = (name) =>
  String(name ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '') // drop accents
    .replace(/[‘’`´]/g, "'") // ’ ‘ ` ´ -> '
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

// Target id typed on a phone: lowercase, keeping only id characters (drops "<…>", a final ".", invisible characters).
export const normalizeTargetId = (typed) =>
  String(typed ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '');

// Show a typed argument with invisible/non-ASCII characters spelled out ("a[U+200B]b"), to diagnose phone keyboards.
const revealHiddenCharacters = (typed) =>
  [...String(typed ?? '')]
    .map((character) => (/[\x21-\x7e]/.test(character) ? character : `[U+${character.codePointAt(0).toString(16).toUpperCase()}]`))
    .join('');

// Link every target without a group to the group named exactly like it (groupNamesByTarget: target id -> expected group name).
// force = false (automatic run at connection): each target is auto-linked only once, so a later !dissocia is respected.
export async function autoLinkGroups({ db, sock, groupNamesByTarget, force }) {
  const groupsByName = new Map(); // normalized group name -> groups with that name (participants are NOT read)
  for (const group of Object.values(await sock.groupFetchAllParticipating()))
    if (!group.isCommunity) groupsByName.set(normalizeGroupName(group.subject), [...(groupsByName.get(normalizeGroupName(group.subject)) ?? []), group]); // the community itself cannot receive messages
  const linkedTargets = new Set(listGroupLinks(db).map((groupLink) => groupLink.target)); // targets that already have a group
  const result = { linked: [], already: 0, ambiguous: [], missing: [] }; // [id, name or group subject] pairs
  for (const [targetId, expectedName] of groupNamesByTarget) {
    if (linkedTargets.has(targetId))
      result.already++; // never touch an existing link
    else if (!force && getStateValue(db, `automap:${targetId}`))
      continue; // auto-linked once and later unlinked by the owner
    else {
      const matchingGroups = groupsByName.get(normalizeGroupName(expectedName)) ?? []; // groups with the expected name
      if (matchingGroups.length === 1) {
        linkGroup(db, targetId, matchingGroups[0].id); // link
        setStateValue(db, `automap:${targetId}`, matchingGroups[0].id); // remember it was done
        result.linked.push([targetId, matchingGroups[0].subject]);
      } else (matchingGroups.length ? result.ambiguous : result.missing).push([targetId, expectedName]); // two groups with one name, or none
    }
  }
  return result;
}

// Readable summary of an autoLinkGroups run (never starts with "!").
export const formatAutoLinkReport = (result) =>
  [
    '🔗 *Associazione automatica gruppi → corsi*',
    result.linked.length
      ? `✅ Collegati ora (${result.linked.length}):\n${result.linked.map(([targetId, subject]) => `• ${subject} → ${targetId}`).join('\n')}`
      : '✅ Nessun nuovo collegamento.',
    `☑️ Corsi che avevano già un gruppo: ${result.already}`,
    result.ambiguous.length &&
      `⚠️ Più gruppi con lo stesso nome, collegali a mano con !associa (${result.ambiguous.length}):\n${result.ambiguous.map(([, name]) => `• ${name}`).join('\n')}`,
    result.missing.length && `❓ Nessun gruppo con il nome del corso (${result.missing.length}):\n${result.missing.map(([, name]) => `• ${name}`).join('\n')}`,
  ]
    .filter(Boolean)
    .join('\n\n');

// Help text listing every command.
const HELP_TEXT = [
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
// session.groups caches the last !gruppi listing so groups can be referenced by number.
export async function handleCommand(text, { db, sock, targetNames, session, groupNamesByTarget = new Map() }) {
  if (!text.startsWith('!')) return null; // replies of the bot never start with "!"
  const [typedCommand, ...args] = text.trim().split(/[\s\u200b-\u200d\u2060\ufeff]+/); // command + arguments; zero-width characters from phone keyboards count as spaces
  const command = typedCommand.toLowerCase(); // phones auto-capitalise the first letter ("!Associa")
  // Resolve "3" (index from !gruppi) or a raw group JID; only group JIDs are accepted.
  const resolveGroupJid = (typed) => (/^\d{1,3}$/.test(typed) ? session.groups?.[Number(typed) - 1]?.id : typed)?.match(/^[\d-]+@g\.us$/)?.[0]; // undefined if invalid
  // Groups the bot is in right now, by JID (participants are NOT read or stored).
  const fetchCurrentGroups = async () => new Map(Object.values(await sock.groupFetchAllParticipating()).map((group) => [group.id, group]));
  // Reply for a target id that does not exist, showing what the phone actually sent.
  const unknownTarget = (targetId, typed) => `Target sconosciuto: ${targetId} (ricevuto: ${revealHiddenCharacters(typed)}; vedi !target)`;
  switch (command) {
    case '!aiuto':
    case '!help':
      return HELP_TEXT; // command list
    case '!autoassocia':
      return formatAutoLinkReport(await autoLinkGroups({ db, sock, groupNamesByTarget, force: true })); // explicit request: also re-links targets unlinked earlier
    case '!stato':
      return [
        '📊 *Stato*', // header
        `Ultimo controllo: ${formatRomeDate(getStateValue(db, 'last_poll')) || 'mai'}`, // last poll, in Italian time
        `In coda: ${pendingDeliveries(db).length}`, // pending messages
        `Inviati ultima ora: ${countSentLastHour(db)}`, // rate usage
        `Falliti ultime 24h: ${countFailedLastDay(db)}`, // broken links show up here (bot removed, not admin…)
        `Collegamenti: ${listGroupLinks(db).length}`, // linked groups
        `Invii: ${getStateValue(db, 'paused') === '1' ? '⏸️ in pausa' : '▶️ attivi'}`, // pause flag
      ].join('\n');
    case '!gruppi': {
      const allGroups = Object.values(await sock.groupFetchAllParticipating()); // groups the bot is in (participants are NOT read or stored)
      session.groups = allGroups.filter((group) => !group.isCommunity).sort((first, second) => first.subject.localeCompare(second.subject)); // communities themselves cannot receive messages
      return session.groups.length
        ? session.groups
            .map(
              (group, index) =>
                `${index + 1}. ${group.subject}${group.linkedParent ? ' 🏘️' : ''}${group.isCommunityAnnounce ? ' (bacheca)' : ''}\n   ${group.id}`,
            )
            .join('\n') // numbered list
        : 'Il bot non è in nessun gruppo.'; // empty
    }
    case '!target': {
      const filter = (args[0] ?? '').toLowerCase(); // optional filter
      return (
        [...targetNames]
          .filter(([targetId, name]) => !filter || targetId.includes(filter) || name.toLowerCase().includes(filter))
          .map(([targetId, name]) => `${targetId} – ${name}`)
          .join('\n') || 'Nessun target.'
      ); // id list
    }
    case '!associa':
    case '!dissocia': {
      const jid = resolveGroupJid(args[0] ?? ''); // group to (un)link
      const targetIds = args.slice(1).map(normalizeTargetId).filter(Boolean); // ids are always lowercase
      if (!jid || !targetIds.length) return `Uso: ${command} <n|jid> <target> [target…] (prima usa !gruppi)`; // usage
      const targetsOfGroup = new Set(listGroupLinks(db).flatMap((groupLink) => (groupLink.jid === jid ? [groupLink.target] : []))); // current links of this group
      const unknownIds = targetIds.filter((targetId) => !targetNames.has(targetId) && !(command === '!dissocia' && targetsOfGroup.has(targetId))); // a course removed from sources.json can still be unlinked
      if (unknownIds.length)
        return `Target sconosciuti: ${unknownIds.join(', ')} (ricevuto: ${args.slice(1).map(revealHiddenCharacters).join(' ')}; vedi !target)`; // refuse typos
      if (command === '!dissocia') {
        for (const targetId of targetIds) unlinkGroup(db, targetId, jid); // works even if the bot already left the group
        return `✅ Scollegato: ${targetIds.join(', ')}`; // confirmation
      }
      const group = (await fetchCurrentGroups()).get(jid); // the bot must really be in the group, or every send would fail
      if (!group) return 'Il bot non è in questo gruppo: rifai !gruppi e controlla il numero.'; // stale index or typo in the JID
      if (group.isCommunity) return 'Questa è la community: collega la sua bacheca (gruppo annunci), non la community.'; // cannot receive messages
      for (const targetId of targetIds) linkGroup(db, targetId, jid); // apply
      return `✅ Collegato a "${group.subject}": ${targetIds.join(', ')}`; // group name lets the owner spot a wrong index
    }
    case '!mappa': {
      const groupLinks = listGroupLinks(db); // current links
      if (!groupLinks.length) return 'Nessun collegamento.'; // empty
      const currentGroups = await fetchCurrentGroups(); // check each link against the real group list
      return groupLinks
        .map((groupLink) => `${groupLink.target} → ${currentGroups.get(groupLink.jid)?.subject ?? '⚠️ bot non più nel gruppo'}\n   ${groupLink.jid}`)
        .join('\n'); // link table
    }
    case '!test': {
      const targetId = normalizeTargetId(args[0]); // board id
      if (!targetNames.has(targetId)) return targetId ? unknownTarget(targetId, args[0]) : 'Uso: !test <target>, es. !test farmacia'; // validation
      const [newestNotice] = latestNotices(db, targetId, 1); // newest notice
      return newestNotice ? `🧪 Anteprima:\n\n${formatNotice(newestNotice, targetNames.get(targetId))}` : 'Nessun avviso per questo target.'; // preview only in self chat
    }
    case '!prova': {
      const targetId = normalizeTargetId(args[0]); // optional single board
      if (targetId && !targetNames.has(targetId)) return unknownTarget(targetId, args[0]); // validation
      const queuedCount = queueLatestNoticePerGroup(db, targetId); // goes through the normal queue: pauses, hourly cap, retries
      return queuedCount
        ? `🧪 ${queuedCount} messaggi di prova in coda. Partono a ritmo anti-ban (con più di 10 in coda, uno ogni 2–3 minuti). Segui con !stato, ferma con !pausa.`
        : 'Niente da mettere in coda: nessun collegamento, nessun avviso, o già inviato.';
    }
    case '!svuota':
      return `🗑️ Coda svuotata: ${cancelPendingDeliveries(db)} messaggi annullati. Gli avvisi nuovi da ora in poi verranno inviati normalmente.`; // emergency clean-up
    case '!pausa':
      setStateValue(db, 'paused', '1'); // stop the sender
      return '⏸️ Invii in pausa.';
    case '!riprendi':
      setStateValue(db, 'paused', '0'); // resume the sender
      return '▶️ Invii ripresi.';
    default:
      return 'Comando sconosciuto. Scrivi !aiuto'; // unknown command
  }
}

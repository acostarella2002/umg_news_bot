// Weekly "wake-up": reminds the owner (in the self chat) to open WhatsApp Business on the primary phone.
// Linked devices are logged out when the primary phone stays offline for ~14 days; a 7-day nudge keeps a safe margin.
import { getKv, setKv, sentLastHour, pendingDeliveries } from '../db.js'; // storage

// Return the self-chat JID of the connected account ("39333…@s.whatsapp.net").
export const selfJid = (user) => (user?.id ? `${user.id.split(':')[0].split('@')[0]}@s.whatsapp.net` : null); // drop device suffix

// Send the reminder when the last one is older than `days`; returns true when a reminder was sent.
export async function keepaliveTick({ db, sock, days, now = Date.now() }) {
  const last = Date.parse(getKv(db, 'last_keepalive') ?? '') || 0; // 0 when never sent
  if (!sock?.user || now - last < days * 864e5) return false; // offline or not due yet
  const text = [
    '🔔 *Promemoria UMG News Bot*', // header (cadence set by KEEPALIVE_DAYS)
    'Apri WhatsApp Business sul telefono principale e lascialo connettere a internet per qualche minuto: serve a non far scollegare il bot (limite ~14 giorni).', // the actual reminder
    `Ultimo controllo bacheche: ${getKv(db, 'last_poll') ?? 'mai'}`, // health info
    `In coda: ${pendingDeliveries(db).length} · inviati ultima ora: ${sentLastHour(db)}`, // queue info
  ].join('\n'); // final text
  await sock.sendMessage(selfJid(sock.user), { text }); // only to the account's own chat
  setKv(db, 'last_keepalive', new Date(now).toISOString()); // remember
  return true; // sent
}

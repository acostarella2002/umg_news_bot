// Weekly "wake-up": reminds the owner (in the self chat) to open WhatsApp Business on the primary phone.
// Linked devices are logged out when the primary phone stays offline for ~14 days; a 6-day nudge keeps a safe margin.
import { getStateValue, setStateValue, countSentLastHour, pendingDeliveries } from '../db.js'; // storage
import { withoutDeviceSuffix } from './commands.js'; // self-chat JID
import { formatRomeDate } from './format.js'; // Italian time

// Send the reminder when the last one is older than `intervalDays`; returns true when a reminder was sent.
export async function sendKeepaliveIfDue({ db, sock, intervalDays, now = Date.now() }) {
  const lastSentAt = Date.parse(getStateValue(db, 'last_keepalive') ?? '') || 0; // 0 when never sent
  if (!sock?.user || now - lastSentAt < intervalDays * 864e5) return false; // offline or not due yet
  const text = [
    '🔔 *Promemoria UMG News Bot*', // header (cadence set by KEEPALIVE_DAYS)
    'Apri WhatsApp Business sul telefono principale e lascialo connettere a internet per qualche minuto: serve a non far scollegare il bot (limite ~14 giorni).', // the actual reminder
    `Ultimo controllo bacheche: ${formatRomeDate(getStateValue(db, 'last_poll')) || 'mai'}`, // health info, in Italian time
    `In coda: ${pendingDeliveries(db).length} · inviati ultima ora: ${countSentLastHour(db)}`, // queue info
  ].join('\n'); // final text
  await sock.sendMessage(withoutDeviceSuffix(sock.user.id), { text }); // only to the account's own chat
  setStateValue(db, 'last_keepalive', new Date(now).toISOString()); // remember
  return true; // sent
}

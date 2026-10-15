// Remove WhatsApp identifiers and phone-number-like digit runs from text before it is logged.
export const redact = (text) =>
  String(text ?? '')
    .replace(/[\w.:-]+@(s\.whatsapp\.net|g\.us|lid|c\.us|broadcast|newsletter)\b/g, '[jid]') // any WhatsApp JID
    .replace(/\+?\d[\d\s-]{8,}\d/g, '[number]'); // phone-number-like sequences

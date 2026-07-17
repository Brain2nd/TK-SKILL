/** IMAP read helpers built on ImapFlow. */
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

function makeClient(env) {
  const secure = String(env.IMAP_TLS ?? "true").toLowerCase() !== "false";
  const rejectUnauthorized = String(env.IMAP_TLS_REJECT_UNAUTHORIZED ?? "true").toLowerCase() !== "false";
  return new ImapFlow({
    host: env.IMAP_HOST,
    port: Number(env.IMAP_PORT || 993),
    secure,
    auth: { user: env.IMAP_USER, pass: env.IMAP_PASSWORD },
    tls: { rejectUnauthorized },
    logger: false,
  });
}

function addresses(list = []) {
  return list.map(item => item.name ? `${item.name} <${item.address}>` : item.address).filter(Boolean).join(", ");
}

/** List newest matching messages without changing seen flags. */
export async function listEmails(env, { folder = "INBOX", sinceDate, limit = 20, unseenOnly = false } = {}) {
  const client = makeClient(env);
  await client.connect();
  let lock;
  try {
    lock = await client.getMailboxLock(folder);
    const query = unseenOnly ? { seen: false } : sinceDate ? { since: new Date(sinceDate) } : { all: true };
    const uids = await client.search(query, { uid: true });
    const selected = uids.slice(-limit).reverse();
    const messages = [];
    for (const uid of selected) {
      const message = await client.fetchOne(uid, { envelope: true, flags: true }, { uid: true });
      if (!message) continue;
      messages.push({
        uid,
        date: message.envelope?.date,
        from: addresses(message.envelope?.from),
        to: addresses(message.envelope?.to),
        subject: message.envelope?.subject || "",
        flags: [...(message.flags || [])],
      });
    }
    return messages;
  } finally {
    lock?.release();
    await client.logout().catch(() => client.close());
  }
}

/** Fetch and parse one message by IMAP UID. */
export async function getEmail(env, { uid, folder = "INBOX" } = {}) {
  const client = makeClient(env);
  await client.connect();
  let lock;
  try {
    lock = await client.getMailboxLock(folder);
    const message = await client.fetchOne(uid, { source: true }, { uid: true });
    if (!message?.source) return null;
    const parsed = await simpleParser(message.source);
    return {
      uid,
      from: parsed.from?.text || "",
      to: parsed.to?.text || "",
      cc: parsed.cc?.text || "",
      subject: parsed.subject || "",
      date: parsed.date,
      text: parsed.text || "",
      html: parsed.html || "",
      messageId: parsed.messageId || "",
      inReplyTo: parsed.inReplyTo || "",
      references: Array.isArray(parsed.references)
        ? parsed.references
        : parsed.references ? [parsed.references] : [],
      attachments: (parsed.attachments || []).map(attachment => ({
        filename: attachment.filename || "",
        contentType: attachment.contentType || "",
        size: attachment.size || 0,
      })),
    };
  } finally {
    lock?.release();
    await client.logout().catch(() => client.close());
  }
}

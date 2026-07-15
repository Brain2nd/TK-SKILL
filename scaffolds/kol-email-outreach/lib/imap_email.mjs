/**
 * imap_email — IMAP email read functions (plain module, no MCP)
 */
import imaps from "imap-simple";
import { simpleParser } from "mailparser";

function makeImapConfig(env) {
  return {
    imap: {
      user: env.IMAP_USER,
      password: env.IMAP_PASSWORD,
      host: env.IMAP_HOST,
      port: parseInt(env.IMAP_PORT || "993", 10),
      tls: env.IMAP_TLS !== "false",
      authTimeout: 10000,
      tlsOptions: { rejectUnauthorized: false },
    },
  };
}

/**
 * List emails from an IMAP mailbox.
 * @param {object} env - { IMAP_USER, IMAP_PASSWORD, IMAP_HOST, IMAP_PORT }
 * @param {object} opts - { folder, sinceDate, limit, unseenOnly }
 * @returns {Promise<Array<{uid, date, from, to, subject, flags}>>}
 */
export async function listEmails(env, { folder = "INBOX", sinceDate, limit = 20, unseenOnly = false } = {}) {
  const connection = await imaps.connect(makeImapConfig(env));
  try {
    await connection.openBox(folder);

    let searchCriteria = ["ALL"];
    if (unseenOnly) searchCriteria = ["UNSEEN"];
    else if (sinceDate) searchCriteria = [["SINCE", sinceDate]];

    const fetchOptions = {
      bodies: ["HEADER.FIELDS (FROM TO SUBJECT DATE)"],
      struct: true,
    };

    const messages = await connection.search(searchCriteria, fetchOptions);
    return messages.slice(-limit).reverse().map(msg => {
      const header = msg.parts.find(p => p.which.includes("HEADER"))?.body || {};
      return {
        uid: msg.attributes.uid,
        date: header.date?.[0],
        from: header.from?.[0],
        to: header.to?.[0],
        subject: header.subject?.[0],
        flags: msg.attributes.flags,
      };
    });
  } finally {
    connection.end();
  }
}

/**
 * Fetch a single email by UID, including RFC 5322 threading headers.
 * @param {object} env - { IMAP_USER, IMAP_PASSWORD, IMAP_HOST, IMAP_PORT }
 * @param {object} opts - { uid, folder }
 * @returns {Promise<{uid, from, to, subject, date, text, html, messageId, inReplyTo, references, attachments} | null>}
 */
export async function getEmail(env, { uid, folder = "INBOX" } = {}) {
  const connection = await imaps.connect(makeImapConfig(env));
  try {
    await connection.openBox(folder);

    const messages = await connection.search(
      [["UID", uid]],
      { bodies: [""], struct: true }
    );

    if (!messages.length) return null;

    const msg = messages[0];
    const rawBody = msg.parts.find(p => p.which === "")?.body;
    const parsed = await simpleParser(rawBody);

    return {
      uid: msg.attributes.uid,
      from: parsed.from?.text,
      to: parsed.to?.text,
      cc: parsed.cc?.text,
      subject: parsed.subject,
      date: parsed.date,
      text: parsed.text,
      html: parsed.html,
      messageId: parsed.messageId || "",
      inReplyTo: parsed.inReplyTo || "",
      references: Array.isArray(parsed.references)
        ? parsed.references
        : parsed.references
        ? [parsed.references]
        : [],
      attachments: parsed.attachments?.map(a => ({
        filename: a.filename,
        contentType: a.contentType,
        size: a.size,
      })),
    };
  } finally {
    connection.end();
  }
}

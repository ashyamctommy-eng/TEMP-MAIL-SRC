'use strict';

const fs = require('fs');
const path = require('path');
const { simpleParser } = require('mailparser');
const config = require('../config');
const { newId, cleanEmailHtml, plainToHtml, splitEmail } = require('../lib/util');

function safeFilename(name, fallback = 'attachment') {
  const base = path.basename(String(name || fallback)).replace(/[^\w.\-() ]+/g, '_').slice(0, 120);
  return base && base !== '.' && base !== '..' ? base : fallback;
}

function decodeHeader(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

/**
 * Parse a raw RFC822 message and persist attachments for one message id.
 * Returns a template that can be stamped onto each recipient mailbox.
 */
async function parseMessage(raw, { maxAttachmentBytes }) {
  const parsed = await simpleParser(raw, {
    skipHtmlToText: false,
    skipTextToHtml: true,
  });

  const messageId = newId(12);
  const dir = path.join(config.ATTACH_DIR, messageId);
  const attachments = [];
  const cidMap = {};

  let total = 0;
  for (const att of parsed.attachments || []) {
    const size = att.size || att.content?.length || 0;
    const filename = safeFilename(att.filename, `attachment-${attachments.length + 1}`);
    const id = newId(10);
    let storedPath = null;

    if (size <= maxAttachmentBytes) {
      fs.mkdirSync(dir, { recursive: true });
      storedPath = path.join(dir, `${id}-${filename}`);
      try {
        fs.writeFileSync(storedPath, att.content);
        total += size;
      } catch {
        storedPath = null;
      }
    }

    attachments.push({
      id,
      filename,
      mime: att.contentType || 'application/octet-stream',
      size,
      cid: att.cid || null,
      path: storedPath,
      tooLarge: size > maxAttachmentBytes,
      content: att.content,
    });
    if (att.cid) cidMap[String(att.cid).replace(/^<|>$/g, '')] = id;
  }

  const fromAddr = parsed.from?.value?.[0]?.address || '';
  const fromName = decodeHeader(parsed.from?.value?.[0]?.name || '');
  const subject = decodeHeader(parsed.subject) || '(no subject)';

  const htmlSource = parsed.html || plainToHtml(parsed.text || '');
  const cleanHtml = cleanEmailHtml(htmlSource, { cidMap });

  return {
    messageId,
    fromAddr,
    fromName,
    subject,
    bodyText: String(parsed.text || '').slice(0, 500_000),
    bodyHtml: cleanHtml.slice(0, 1_500_000),
    rawSize: Buffer.byteLength(raw),
    attachmentBytes: total,
    attachments,
  };
}

/** Build a DB-ready message row for a given recipient address. */
function stampForMailbox(template, recipient) {
  const parts = splitEmail(recipient);
  if (!parts) throw new Error('Invalid recipient');

  // Attachment rows are keyed globally, so each recipient copy gets fresh ids and
  // the inline cid: references in the HTML are rewritten to match.
  const idMap = new Map();
  const attachments = template.attachments.map((a) => {
    const id = newId(10);
    idMap.set(a.id, id);
    return { ...a, id };
  });

  let bodyHtml = template.bodyHtml;
  for (const [oldId, newIdValue] of idMap) {
    bodyHtml = bodyHtml.split(`key=${oldId}`).join(`key=${newIdValue}`);
  }

  return {
    id: template.messageId + '-' + newId(3),
    mailbox: parts.email,
    domain: parts.domain,
    fromAddr: template.fromAddr,
    fromName: template.fromName,
    toAddr: parts.email,
    subject: template.subject,
    bodyText: template.bodyText,
    bodyHtml,
    rawSize: template.rawSize,
    attachments,
  };
}

module.exports = { parseMessage, stampForMailbox, safeFilename };

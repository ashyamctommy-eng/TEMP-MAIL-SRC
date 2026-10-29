'use strict';

const fs = require('fs');
const { SMTPServer } = require('smtp-server');
const config = require('../config');
const { isKnownDomain, addMessage, getSetting, logActivity } = require('../db');
const { parseMessage, stampForMailbox } = require('./parse');
const { forwardMessage } = require('./forward');
const { splitEmail } = require('../lib/util');

function loadTls() {
  const keyPath = process.env.TLS_KEY_PATH;
  const certPath = process.env.TLS_CERT_PATH;
  if (!keyPath || !certPath) return null;
  try {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  } catch (err) {
    console.warn('[smtp] TLS certificate could not be loaded:', err.message);
    return null;
  }
}

function startSmtp() {
  const tls = loadTls();
  const maxMb = Math.max(1, Number(getSetting('max_message_mb') || config.SMTP_MAX_MB));
  const maxAttachmentMb = Math.max(1, Number(getSetting('max_attachment_mb') || config.MAX_ATTACHMENT_MB));

  const server = new SMTPServer({
    name: getSetting('mail_hostname') || config.MAIL_HOSTNAME,
    banner: getSetting('site_name') || 'GoldenMail',
    size: maxMb * 1024 * 1024,
    authOptional: true,
    disabledCommands: ['AUTH'],
    hideSTARTTLS: !tls,
    ...(tls || {}),
    logger: false,
    maxClients: 200,

    onRcptTo(address, session, callback) {
      const parts = splitEmail(address.address);
      if (!parts) return callback(new Error('Invalid recipient address'));
      if (!isKnownDomain(parts.domain)) {
        const err = new Error('Relay access denied: domain is not configured on this server');
        err.responseCode = 550;
        return callback(err);
      }
      callback();
    },

    onData(stream, session, callback) {
      const chunks = [];
      let bytes = 0;
      let aborted = false;
      const hardLimit = maxMb * 1024 * 1024;

      stream.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > hardLimit) {
          aborted = true;
          stream.destroy(new Error('Message too large'));
          return;
        }
        chunks.push(chunk);
      });

      stream.on('error', (err) => {
        if (aborted) return;
        aborted = true;
        callback(err);
      });

      stream.on('end', async () => {
        if (aborted) return;
        const recipients = [...new Set(session.envelope.rcptTo.map((r) => r.address.toLowerCase()))];
        if (!recipients.length) return callback(new Error('No recipients'));

        try {
          const raw = Buffer.concat(chunks);
          const template = await parseMessage(raw, { maxAttachmentBytes: maxAttachmentMb * 1024 * 1024 });

          for (const rcpt of recipients) {
            const row = stampForMailbox(template, rcpt);
            addMessage(row);
            const stored = row.attachments.map((a) => ({
              filename: a.filename,
              mime: a.mime,
              content: a.content,
            }));
            // Forward asynchronously so slow relays never delay the SMTP handshake.
            setImmediate(() => forwardMessage(row, stored));
          }

          logActivity('received', `${recipients.join(', ')} | ${template.fromAddr} | ${template.subject}`);
          callback(null, 'Message accepted for delivery');
        } catch (err) {
          console.error('[smtp] failed to process message:', err);
          logActivity('error', `SMTP parse failure: ${err.message}`);
          callback(new Error('Message could not be processed'));
        }
      });
    },

    onError(err) {
      console.error('[smtp]', err.message);
    },
  });

  return new Promise((resolve, reject) => {
    server.on('error', (err) => {
      console.error(`[smtp] cannot listen on ${config.SMTP_HOST}:${config.SMTP_PORT}:`, err.message);
      reject(err);
    });
    server.listen(config.SMTP_PORT, config.SMTP_HOST, () => {
      console.log(`[smtp] listening on ${config.SMTP_HOST}:${config.SMTP_PORT}` +
        (tls ? ' (STARTTLS enabled)' : ''));
      resolve(server);
    });
  });
}

module.exports = { startSmtp };

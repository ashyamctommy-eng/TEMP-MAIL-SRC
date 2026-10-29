'use strict';

const nodemailer = require('nodemailer');
const { db, getSetting, logActivity } = require('../db');
const { escapeHtml } = require('../lib/util');

let cached = { key: '', transport: null };

function buildTransport() {
  const host = getSetting('smtp_relay_host');
  const port = Number(getSetting('smtp_relay_port') || 587);
  const user = getSetting('smtp_relay_user');
  const pass = getSetting('smtp_relay_pass');
  const secure = getSetting('smtp_relay_secure') === '1';
  if (!host) return null;

  const key = `${host}:${port}:${user}:${secure}:${pass.length}`;
  if (cached.key === key) return cached.transport;

  const transport = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user ? { user, pass } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  cached = { key, transport };
  return transport;
}

function setForwardStatus(messageId, status) {
  db.prepare('UPDATE messages SET forward_status = ? WHERE id = ?').run(status, messageId);
}

/**
 * Forward a received message to its configured target. Never throws into the
 * SMTP path; failures are recorded and visible in the admin panel.
 */
async function forwardMessage(message, attachments) {
  const rule = db.prepare('SELECT * FROM forwards WHERE mailbox = ?').get(message.mailbox);
  if (!rule || !rule.target) return;

  const transport = buildTransport();
  if (!transport) {
    setForwardStatus(message.id, 'no-relay');
    return;
  }

  const from = getSetting('smtp_relay_from') || `GoldenMail <${message.mailbox}>`;

  const header = `
    <div style="font-family:Inter,Arial,sans-serif;font-size:13px;color:#555;border-bottom:1px solid #ddd;padding-bottom:8px;margin-bottom:14px">
      <strong>Forwarded by GoldenMail</strong><br>
      From: ${escapeHtml(message.fromName ? `${message.fromName} <${message.fromAddr}>` : message.fromAddr)}<br>
      To: ${escapeHtml(message.toAddr)}<br>
      Subject: ${escapeHtml(message.subject)}
    </div>`;

  try {
    await transport.sendMail({
      from,
      to: rule.target,
      subject: `[Fwd] ${message.subject}`,
      text: message.bodyText || '',
      html: header + (message.bodyHtml || '<em>(no content)</em>'),
      attachments: (attachments || [])
        .filter((a) => a.content)
        .map((a) => ({ filename: a.filename, content: a.content, contentType: a.mime })),
    });
    setForwardStatus(message.id, 'sent');
    logActivity('forward', `${message.mailbox} -> ${rule.target}`);
  } catch (err) {
    setForwardStatus(message.id, 'failed');
    logActivity('forward_error', `${message.mailbox}: ${err.message}`);
  }
}

module.exports = { forwardMessage };

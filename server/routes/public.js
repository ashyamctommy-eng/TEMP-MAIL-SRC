'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const {
  db, listDomains, getDomain, isKnownDomain, listMessagesFor, getMessageByKey,
  deleteMessageByKey, getForward, setForward, getSetting, addMessage, logActivity,
} = require('../db');
const { splitEmail, isValidEmail, normalizeEmail, rateLimiter } = require('../lib/util');
const { parseMessage, stampForMailbox } = require('../mail/parse');
const { forwardMessage } = require('../mail/forward');

const router = express.Router();

const readLimit = rateLimiter({ windowMs: 60_000, max: 180 });
const writeLimit = rateLimiter({ windowMs: 60_000, max: 60 });
const attachmentLimit = rateLimiter({ windowMs: 60_000, max: 90 });
const ingestLimit = rateLimiter({ windowMs: 60_000, max: 120 });

function messagePayload(row) {
  const attachments = db.prepare(
    'SELECT id, filename, mime, size, path FROM attachments WHERE message_id = ?'
  ).all(row.id).map((a) => ({
    key: a.id,
    filename: a.filename,
    mime: a.mime,
    size: a.size,
    tooLarge: !a.path,
  }));

  return {
    id: row.id,
    key: row.id,
    mailbox: row.mailbox,
    from: row.from_name ? `${row.from_name} <${row.from_addr}>` : row.from_addr,
    fromName: row.from_name,
    fromAddr: row.from_addr,
    to: row.to_addr,
    subject: row.subject,
    timestamp: row.received_at,
    bodyHtml: row.body_html,
    bodyText: row.body_text,
    hasAttachments: !!row.has_attachments,
    attachments,
    forwardStatus: row.forward_status,
  };
}

/* ------------------------------- public config ------------------------------ */

router.get('/config', (req, res) => {
  const active = listDomains({ activeOnly: true });
  const domains = active.map((d) => d.domain);
  const defaultDomain = (active.find((d) => d.is_default) || {}).domain || domains[0] || '';
  res.json({
    siteName: getSetting('site_name'),
    tagline: getSetting('site_tagline'),
    supportUrl: getSetting('support_url'),
    footerText: getSetting('footer_text'),
    pollInterval: Math.max(1000, Math.min(60_000, Number(getSetting('poll_interval')) || 3000)),
    allowRandom: getSetting('allow_random') === '1',
    domains,
    defaultDomain,
  });
});

router.get('/domains', (req, res) => {
  res.json({ domains: listDomains({ activeOnly: true }).map((d) => d.domain) });
});

/* --------------------------------- mailboxes -------------------------------- */

// Lightweight existence/format check used before a mailbox is created.
router.get('/mailbox', readLimit, (req, res) => {
  const parts = splitEmail(req.query.email);
  if (!parts) return res.status(400).json({ error: 'Invalid email address' });
  res.json({ email: parts.email, domainActive: isKnownDomain(parts.domain) });
});

/* --------------------------------- messages --------------------------------- */

router.get('/messages', readLimit, (req, res) => {
  const parts = splitEmail(req.query.email);
  if (!parts) return res.status(400).json({ error: 'Invalid email address' });
  if (!isKnownDomain(parts.domain)) return res.json({ messages: [], domainActive: false });

  const rows = listMessagesFor(parts.email);
  res.json({ messages: rows.map(messagePayload), domainActive: true });
});

router.delete('/messages', writeLimit, (req, res) => {
  const key = String(req.query.key || '');
  if (!/^[a-f0-9-]{16,80}$/i.test(key)) return res.status(400).json({ error: 'Invalid message key' });
  const ok = deleteMessageByKey(key);
  res.json({ success: ok });
});

/* -------------------------------- attachments ------------------------------- */

router.get('/attachment', attachmentLimit, (req, res) => {
  const key = String(req.query.key || '');
  if (!/^[a-f0-9]{8,64}$/i.test(key)) return res.status(400).json({ error: 'Invalid attachment key' });
  const att = db.prepare('SELECT * FROM attachments WHERE id = ?').get(key);
  if (!att) return res.status(404).json({ error: 'Attachment not found' });
  if (!att.path || !fs.existsSync(att.path)) {
    return res.status(410).json({ error: 'Attachment expired or too large' });
  }
  const filename = String(att.filename || 'attachment').replace(/["\\\r\n]/g, '_');
  res.setHeader('Content-Type', att.mime || 'application/octet-stream');
  res.setHeader('Content-Length', att.size);
  res.setHeader('Content-Disposition',
    `inline; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  fs.createReadStream(att.path).pipe(res);
});

/* --------------------------------- forwarding -------------------------------- */

router.get('/forward', readLimit, (req, res) => {
  const parts = splitEmail(req.query.email);
  if (!parts) return res.status(400).json({ error: 'Invalid email address' });
  const rule = getForward(parts.email);
  res.json({ targetEmail: rule?.target || '', enabled: !!rule });
});

router.post('/forward', writeLimit, express.json({ limit: '10kb' }), (req, res) => {
  const parts = splitEmail(req.body?.email);
  if (!parts) return res.status(400).json({ error: 'Invalid email address' });
  if (!isKnownDomain(parts.domain)) return res.status(400).json({ error: 'Domain is not configured' });

  const target = normalizeEmail(req.body?.targetEmail || '');
  if (target && !isValidEmail(target)) return res.status(400).json({ error: 'Invalid target email' });

  setForward(parts.email, target);
  logActivity(target ? 'forward_set' : 'forward_removed', `${parts.email} -> ${target || 'off'}`);
  res.json({ success: true, targetEmail: target, enabled: !!target });
});

/* ----------------------------- HTTP mail ingest ----------------------------- */

/**
 * Alternative inbound path for hosts where port 25 is blocked (Cloudflare Email
 * Workers, Postfix pipe, Mailgun routes). Requires the ingest secret.
 */
router.post('/ingest', ingestLimit, express.raw({ type: '*/*', limit: '30mb' }), async (req, res) => {
  const provided = req.headers['x-ingest-secret'] || req.query.secret ||
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!provided || provided !== getSetting('ingest_secret')) {
    return res.status(401).json({ error: 'Invalid ingest secret' });
  }

  const recipients = String(req.query.to || req.headers['x-mail-to'] || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (!recipients.length) return res.status(400).json({ error: 'Missing ?to= recipient' });

  const active = recipients
    .map((r) => splitEmail(r))
    .filter((p) => p && isKnownDomain(p.domain))
    .map((p) => p.email);
  if (!active.length) return res.status(400).json({ error: 'No active recipient domains' });

  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body?.raw || '', 'utf8');
  if (!raw.length) return res.status(400).json({ error: 'Empty message' });

  try {
    const template = await parseMessage(raw, {
      maxAttachmentBytes: Number(getSetting('max_attachment_mb') || 10) * 1024 * 1024,
    });
    for (const rcpt of active) {
      const row = stampForMailbox(template, rcpt);
      addMessage(row);
      setImmediate(() => forwardMessage(row, row.attachments));
    }
    logActivity('received', `${active.join(', ')} | HTTP ingest`);
    res.json({ success: true, accepted: active.length });
  } catch (err) {
    console.error('[ingest]', err);
    res.status(422).json({ error: 'Could not parse message' });
  }
});

/* ----------------------------------- health --------------------------------- */

router.get('/health', (req, res) => {
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()),
    domains: listDomains({ activeOnly: true }).length,
    messages: db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,
  });
});

module.exports = router;

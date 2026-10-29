'use strict';

const express = require('express');
const dns = require('dns').promises;
const fs = require('fs');
const {
  db, getAllSettings, setSetting, listDomains, addDomain, updateDomain,
  deleteDomain, getSetting, deleteMessageByKey, attachmentDiskBytes, logActivity,
} = require('../db');
const {
  verifyCredentials, createSession, destroySession, requireAdmin,
  changePassword, cookieOptions, COOKIE_NAME, getSession,
} = require('../lib/auth');
const { rateLimiter, clientIp, isValidEmail, normalizeEmail } = require('../lib/util');

const router = express.Router();

/* ---------------------------------- auth ---------------------------------- */

const loginLimit = rateLimiter({ windowMs: 15 * 60_000, max: 12 });

router.post('/login', loginLimit, express.json({ limit: '5kb' }), async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const admin = await verifyCredentials(username, password);
  if (!admin) {
    logActivity('login_failed', String(username).slice(0, 60), clientIp(req));
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  destroySession(req);
  const { token, expires } = createSession(admin, req);
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; ${cookieOptions(expires - Date.now())}`);
  logActivity('login', admin.username, clientIp(req));
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  destroySession(req);
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
  res.json({ ok: true });
});

router.get('/session', (req, res) => {
  const s = getSession(req);
  if (!s) return res.status(401).json({ authenticated: false });
  res.json({
    authenticated: true,
    username: s.username,
    csrf: s.csrf,
    siteName: getSetting('site_name'),
  });
});

/* -------------------------------- overview -------------------------------- */

router.get('/overview', requireAdmin, (req, res) => {
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

  const totalMessages = db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
  const todayMessages = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE received_at >= ?').get(dayStart).n;
  const mailboxes = db.prepare('SELECT COUNT(DISTINCT mailbox) AS n FROM messages').get().n;
  const activeDomains = db.prepare('SELECT COUNT(*) AS n FROM domains WHERE active = 1').get().n;
  const totalDomains = db.prepare('SELECT COUNT(*) AS n FROM domains').get().n;
  const attachments = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size),0) AS bytes FROM attachments').get();
  const forwards = db.prepare('SELECT COUNT(*) AS n FROM forwards').get().n;

  // 14-day series, zero-filled.
  const series = [];
  const rows = new Map(
    db.prepare('SELECT day, received FROM daily_stats').all().map((r) => [r.day, r.received])
  );
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400_000);
    const day = d.toISOString().slice(0, 10);
    series.push({ day, received: rows.get(day) || 0 });
  }

  const domainBreakdown = db.prepare(`
    SELECT domain, COUNT(*) AS count FROM messages
    GROUP BY domain ORDER BY count DESC LIMIT 8
  `).all();

  const recent = db.prepare(`
    SELECT id, mailbox, from_addr, from_name, subject, received_at, has_attachments
    FROM messages ORDER BY received_at DESC LIMIT 8
  `).all().map((m) => ({
    id: m.id,
    mailbox: m.mailbox,
    from: m.from_name ? `${m.from_name} <${m.from_addr}>` : m.from_addr,
    subject: m.subject,
    receivedAt: m.received_at,
    hasAttachments: !!m.has_attachments,
  }));

  const activity = db.prepare('SELECT * FROM activity ORDER BY id DESC LIMIT 12').all();

  res.json({
    totals: {
      messages: totalMessages,
      today: todayMessages,
      mailboxes,
      activeDomains,
      totalDomains,
      attachments: attachments.n,
      storageBytes: attachmentDiskBytes(),
      forwards,
    },
    series,
    domainBreakdown,
    recent,
    activity,
    smtp: {
      port: Number(process.env.SMTP_PORT || 25),
      hostname: getSetting('mail_hostname'),
      ingestEnabled: !!getSetting('ingest_secret'),
      relayConfigured: !!getSetting('smtp_relay_host'),
    },
    serverTime: Date.now(),
  });
});

/* --------------------------------- domains -------------------------------- */

router.get('/domains', requireAdmin, (req, res) => {
  res.json({
    domains: listDomains().map((d) => ({
      id: d.id,
      domain: d.domain,
      active: !!d.active,
      isDefault: !!d.is_default,
      note: d.note || '',
      createdAt: d.created_at,
      messages: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE domain = ?').get(d.domain).n,
    })),
    mailHostname: getSetting('mail_hostname'),
  });
});

router.post('/domains', requireAdmin, express.json({ limit: '10kb' }), (req, res) => {
  try {
    const domain = addDomain(req.body?.domain, {
      note: String(req.body?.note || '').slice(0, 255),
      isDefault: !!req.body?.isDefault,
      active: req.body?.active !== false,
    });
    logActivity('domain_added', domain.domain, clientIp(req));
    res.json({ ok: true, domain });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.patch('/domains/:id', requireAdmin, express.json({ limit: '10kb' }), (req, res) => {
  try {
    const row = updateDomain(Number(req.params.id), req.body || {});
    logActivity('domain_updated', `${row.domain} active=${row.active}`, clientIp(req));
    res.json({ ok: true, domain: row });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/domains/:id', requireAdmin, (req, res) => {
  const row = db.prepare('SELECT * FROM domains WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Domain not found' });
  deleteDomain(row.id);
  logActivity('domain_deleted', row.domain, clientIp(req));
  res.json({ ok: true });
});

router.post('/domains/:id/verify', requireAdmin, async (req, res) => {
  const row = db.prepare('SELECT * FROM domains WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Domain not found' });

  const host = getSetting('mail_hostname');
  const checks = [];

  try {
    const mx = await dns.resolveMx(row.domain);
    const pointsHere = mx.some((r) => r.exchange.replace(/\.$/, '').toLowerCase() === host.toLowerCase());
    checks.push({
      label: 'MX record',
      ok: mx.length > 0,
      detail: mx.length
        ? mx.map((r) => `${r.exchange} (priority ${r.priority})`).join(', ')
        : 'No MX records found',
      hint: pointsHere ? '' : `Point MX to ${host}`,
    });
  } catch (err) {
    checks.push({ label: 'MX record', ok: false, detail: err.code || err.message, hint: `Add MX -> ${host}` });
  }

  try {
    const txt = (await dns.resolveTxt(row.domain)).map((r) => r.join(''));
    const spf = txt.find((t) => t.toLowerCase().startsWith('v=spf1'));
    checks.push({
      label: 'SPF record',
      ok: !!spf,
      detail: spf || 'No SPF TXT record',
      hint: spf ? '' : 'v=spf1 mx ~all',
    });
  } catch (err) {
    checks.push({ label: 'SPF record', ok: false, detail: err.code || err.message, hint: 'v=spf1 mx ~all' });
  }

  try {
    const dmarc = (await dns.resolveTxt(`_dmarc.${row.domain}`)).map((r) => r.join(''));
    const rec = dmarc.find((t) => t.toLowerCase().startsWith('v=dmarc1'));
    checks.push({ label: 'DMARC record', ok: !!rec, detail: rec || 'No DMARC record', hint: rec ? '' : 'v=DMARC1; p=none' });
  } catch (err) {
    checks.push({ label: 'DMARC record', ok: false, detail: err.code || err.message, hint: 'v=DMARC1; p=none' });
  }

  try {
    const a = await dns.resolve4(host);
    checks.push({ label: `A record for ${host}`, ok: a.length > 0, detail: a.join(', '), hint: '' });
  } catch (err) {
    checks.push({ label: `A record for ${host}`, ok: false, detail: err.code || err.message, hint: `Point ${host} to this server's IP` });
  }

  const ok = checks.every((c) => c.ok);
  res.json({ domain: row.domain, ok, checks, checkedAt: Date.now() });
});

/* -------------------------------- messages -------------------------------- */

router.get('/messages', requireAdmin, (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(5, Number(req.query.limit) || 25));
  const q = String(req.query.q || '').trim();
  const domain = String(req.query.domain || '').trim();
  const mailbox = String(req.query.mailbox || '').trim().toLowerCase();

  const where = [];
  const params = [];
  if (q) {
    where.push('(subject LIKE ? OR from_addr LIKE ? OR from_name LIKE ? OR mailbox LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  if (domain) { where.push('domain = ?'); params.push(domain); }
  if (mailbox) { where.push('mailbox = ?'); params.push(mailbox); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) AS n FROM messages ${clause}`).get(...params).n;
  const rows = db.prepare(`
    SELECT id, mailbox, domain, from_addr, from_name, subject, received_at, raw_size,
           has_attachments, forward_status
    FROM messages ${clause}
    ORDER BY received_at DESC LIMIT ? OFFSET ?
  `).all(...params, limit, (page - 1) * limit);

  res.json({
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
    messages: rows.map((m) => ({
      id: m.id,
      mailbox: m.mailbox,
      domain: m.domain,
      from: m.from_name ? `${m.from_name} <${m.from_addr}>` : m.from_addr,
      subject: m.subject,
      receivedAt: m.received_at,
      size: m.raw_size,
      hasAttachments: !!m.has_attachments,
      forwardStatus: m.forward_status,
    })),
  });
});

router.get('/messages/:id', requireAdmin, (req, res) => {
  const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Message not found' });
  const attachments = db.prepare('SELECT id, filename, mime, size, path FROM attachments WHERE message_id = ?')
    .all(m.id)
    .map((a) => ({ key: a.id, filename: a.filename, mime: a.mime, size: a.size, tooLarge: !a.path }));

  res.json({
    id: m.id,
    mailbox: m.mailbox,
    fromAddr: m.from_addr,
    fromName: m.from_name,
    toAddr: m.to_addr,
    subject: m.subject,
    bodyHtml: m.body_html,
    bodyText: m.body_text,
    receivedAt: m.received_at,
    forwardStatus: m.forward_status,
    attachments,
  });
});

router.delete('/messages/:id', requireAdmin, (req, res) => {
  const ok = deleteMessageByKey(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Message not found' });
  logActivity('message_deleted', req.params.id, clientIp(req));
  res.json({ ok: true });
});

/* -------------------------------- settings -------------------------------- */

router.get('/settings', requireAdmin, (req, res) => {
  const s = getAllSettings();
  res.json({
    settings: {
      ...s,
      smtp_relay_pass: s.smtp_relay_pass ? '••••••••' : '',
      ingest_secret: s.ingest_secret,
    },
    mailHostnameEnv: process.env.MAIL_HOSTNAME || '',
    siteUrl: process.env.SITE_URL || '',
  });
});

const EDITABLE = new Set([
  'site_name', 'site_tagline', 'support_url', 'poll_interval', 'retention_days',
  'max_message_mb', 'max_attachment_mb', 'allow_random', 'mail_hostname',
  'smtp_relay_host', 'smtp_relay_port', 'smtp_relay_user', 'smtp_relay_pass',
  'smtp_relay_secure', 'smtp_relay_from', 'footer_text',
]);

router.patch('/settings', requireAdmin, express.json({ limit: '20kb' }), (req, res) => {
  const body = req.body || {};
  const updated = [];
  for (const [key, raw] of Object.entries(body)) {
    if (!EDITABLE.has(key)) continue;
    let value = String(raw ?? '');
    if (key === 'smtp_relay_pass' && value === '••••••••') continue;
    if (key === 'allow_random' || key === 'smtp_relay_secure') value = value === '1' || value === 'true' ? '1' : '0';
    if (['poll_interval', 'retention_days', 'max_message_mb', 'max_attachment_mb', 'smtp_relay_port'].includes(key)) {
      if (value !== '' && !/^\d+$/.test(value)) return res.status(400).json({ error: `${key} must be a number` });
    }
    if (key === 'poll_interval') value = String(Math.max(1000, Math.min(60_000, Number(value) || 3000)));
    if (key === 'retention_days') value = String(Math.max(1, Math.min(365, Number(value) || 7)));
    if (key === 'max_message_mb') value = String(Math.max(1, Math.min(100, Number(value) || 25)));
    if (key === 'smtp_relay_from' && value && !/^[^\s@]+@[^\s@]+$/.test(value.replace(/.*<|>.*/g, ''))) {
      return res.status(400).json({ error: 'Invalid relay From address' });
    }
    setSetting(key, value);
    updated.push(key);
  }
  logActivity('settings_updated', updated.join(','), clientIp(req));
  res.json({ ok: true, updated });
});

router.post('/password', requireAdmin, express.json({ limit: '5kb' }), async (req, res) => {
  try {
    await changePassword(
      req.adminSession.admin_id,
      req.body?.currentPassword,
      req.body?.newPassword,
      req.adminSession.id
    );
    logActivity('password_changed', req.adminSession.username, clientIp(req));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* --------------------------------- exports -------------------------------- */

router.get('/export/messages.csv', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT mailbox, domain, from_addr, subject, received_at, raw_size
    FROM messages ORDER BY received_at DESC LIMIT 5000
  `).all();
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = ['mailbox,domain,from,subject,received_at,size_bytes']
    .concat(rows.map((r) => [r.mailbox, r.domain, r.from_addr, r.subject,
      new Date(r.received_at).toISOString(), r.raw_size].map(esc).join(',')))
    .join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="goldenmail-messages.csv"');
  res.send(csv);
});

module.exports = router;

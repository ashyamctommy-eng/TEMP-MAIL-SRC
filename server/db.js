'use strict';

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const db = new DatabaseSync(config.DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admins (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  admin_id   INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  csrf       TEXT NOT NULL,
  ip         TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS domains (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  domain     TEXT NOT NULL UNIQUE COLLATE NOCASE,
  active     INTEGER NOT NULL DEFAULT 1,
  is_default INTEGER NOT NULL DEFAULT 0,
  note       TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  mailbox         TEXT NOT NULL,
  domain          TEXT NOT NULL,
  from_addr       TEXT NOT NULL DEFAULT '',
  from_name       TEXT NOT NULL DEFAULT '',
  to_addr         TEXT NOT NULL DEFAULT '',
  subject         TEXT NOT NULL DEFAULT '(no subject)',
  body_text       TEXT NOT NULL DEFAULT '',
  body_html       TEXT NOT NULL DEFAULT '',
  raw_size        INTEGER NOT NULL DEFAULT 0,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  is_read         INTEGER NOT NULL DEFAULT 0,
  forward_status  TEXT NOT NULL DEFAULT '',
  received_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_mailbox ON messages(mailbox, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_received ON messages(received_at DESC);

CREATE TABLE IF NOT EXISTS attachments (
  id         TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  filename   TEXT NOT NULL,
  mime       TEXT NOT NULL DEFAULT 'application/octet-stream',
  size       INTEGER NOT NULL DEFAULT 0,
  cid        TEXT,
  path       TEXT
);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);

CREATE TABLE IF NOT EXISTS forwards (
  mailbox    TEXT PRIMARY KEY,
  target     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_stats (
  day       TEXT PRIMARY KEY,
  received  INTEGER NOT NULL DEFAULT 0,
  mailboxes TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS activity (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '',
  ip         TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity(created_at DESC);
`);

/* ---------- settings ---------- */

const DEFAULT_SETTINGS = {
  site_name: 'GoldenMail',
  site_tagline: 'Temp Mail',
  support_url: 'https://t.me/MaxTechnical',
  poll_interval: '3000',
  retention_days: String(config.RETENTION_DAYS),
  max_message_mb: String(config.SMTP_MAX_MB),
  max_attachment_mb: String(config.MAX_ATTACHMENT_MB),
  allow_random: '1',
  mail_hostname: config.MAIL_HOSTNAME,
  smtp_relay_host: '',
  smtp_relay_port: '587',
  smtp_relay_user: '',
  smtp_relay_pass: '',
  smtp_relay_secure: '0',
  smtp_relay_from: '',
  ingest_secret: config.INGEST_SECRET,
  footer_text: '© GoldenMail — disposable email service',
};

const settingsCache = new Map();

function getSetting(key) {
  if (settingsCache.has(key)) return settingsCache.get(key);
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  const value = row ? row.value : (DEFAULT_SETTINGS[key] ?? '');
  settingsCache.set(key, value);
  return value;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value ?? ''));
  settingsCache.set(key, String(value ?? ''));
}

function getAllSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const row of db.prepare('SELECT key, value FROM settings').all()) out[row.key] = row.value;
  return out;
}

// Seed defaults once (does not overwrite existing rows).
const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(k, v);
// Persist a generated ingest secret so it stays stable across restarts.
if (!db.prepare('SELECT 1 FROM settings WHERE key = ?').get('ingest_secret')) {
  insertSetting.run('ingest_secret', config.INGEST_SECRET);
}

/* ---------- admins ---------- */

async function ensureAdmin() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM admins').get().n;
  if (count > 0) return null;

  const bcrypt = require('bcryptjs');
  const username = config.ADMIN_USER;
  const generated = !config.ADMIN_PASSWORD;
  const password = config.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  const hash = await bcrypt.hash(password, 12);
  db.prepare('INSERT INTO admins (username, password_hash, created_at) VALUES (?, ?, ?)')
    .run(username, hash, Date.now());

  if (generated) {
    const file = path.join(config.DATA_DIR, 'initial-admin.txt');
    fs.writeFileSync(
      file,
      `GoldenMail initial admin credentials\nusername: ${username}\npassword: ${password}\n` +
      `Change this password after your first login, then delete this file.\n`,
      { mode: 0o600 }
    );
    return { username, password, generated: true, file };
  }
  return { username, password, generated: false };
}

/* ---------- domains ---------- */

function listDomains({ activeOnly = false } = {}) {
  const sql = activeOnly
    ? 'SELECT * FROM domains WHERE active = 1 ORDER BY is_default DESC, domain ASC'
    : 'SELECT * FROM domains ORDER BY active DESC, is_default DESC, domain ASC';
  return db.prepare(sql).all();
}

function getDomain(domain) {
  return db.prepare('SELECT * FROM domains WHERE domain = ?').get(String(domain || '').toLowerCase());
}

function addDomain(domain, { note = '', isDefault = false, active = true } = {}) {
  const clean = String(domain || '').trim().toLowerCase().replace(/^@/, '');
  if (!/^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(clean)) {
    throw new Error('Invalid domain name');
  }
  if (getDomain(clean)) throw new Error('Domain already exists');

  if (isDefault) db.prepare('UPDATE domains SET is_default = 0').run();
  db.prepare('INSERT INTO domains (domain, active, is_default, note, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(clean, active ? 1 : 0, isDefault ? 1 : 0, note, Date.now());
  return getDomain(clean);
}

function updateDomain(id, patch) {
  const row = db.prepare('SELECT * FROM domains WHERE id = ?').get(id);
  if (!row) throw new Error('Domain not found');
  if (patch.isDefault) db.prepare('UPDATE domains SET is_default = 0').run();
  const next = {
    active: patch.active === undefined ? row.active : (patch.active ? 1 : 0),
    is_default: patch.isDefault === undefined ? row.is_default : (patch.isDefault ? 1 : 0),
    note: patch.note === undefined ? row.note : String(patch.note).slice(0, 255),
  };
  db.prepare('UPDATE domains SET active = ?, is_default = ?, note = ? WHERE id = ?')
    .run(next.active, next.is_default, next.note, id);
  return db.prepare('SELECT * FROM domains WHERE id = ?').get(id);
}

function deleteDomain(id) {
  const row = db.prepare('SELECT * FROM domains WHERE id = ?').get(id);
  if (!row) return false;
  db.prepare('DELETE FROM domains WHERE id = ?').run(id);
  return true;
}

/* ---------- messages ---------- */

function isKnownDomain(domain) {
  return !!db.prepare('SELECT 1 FROM domains WHERE domain = ? AND active = 1').get(String(domain).toLowerCase());
}

function addMessage(msg) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO messages (id, mailbox, domain, from_addr, from_name, to_addr, subject,
                          body_text, body_html, raw_size, has_attachments, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    msg.id, msg.mailbox, msg.domain, msg.fromAddr || '', msg.fromName || '', msg.toAddr || '',
    msg.subject || '(no subject)', msg.bodyText || '', msg.bodyHtml || '',
    msg.rawSize || 0, msg.attachments && msg.attachments.length ? 1 : 0, now
  );

  const insAtt = db.prepare('INSERT INTO attachments (id, message_id, filename, mime, size, cid, path) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const a of msg.attachments || []) {
    insAtt.run(a.id, msg.id, a.filename, a.mime, a.size, a.cid || null, a.path || null);
  }

  const day = new Date(now).toISOString().slice(0, 10);
  const row = db.prepare('SELECT * FROM daily_stats WHERE day = ?').get(day);
  if (!row) {
    db.prepare('INSERT INTO daily_stats (day, received, mailboxes) VALUES (?, 1, ?)')
      .run(day, JSON.stringify([msg.mailbox]));
  } else {
    let set;
    try { set = new Set(JSON.parse(row.mailboxes)); } catch { set = new Set(); }
    set.add(msg.mailbox);
    db.prepare('UPDATE daily_stats SET received = received + 1, mailboxes = ? WHERE day = ?')
      .run(JSON.stringify([...set].slice(-5000)), day);
  }
  return now;
}

function listMessagesFor(mailbox) {
  return db.prepare('SELECT * FROM messages WHERE mailbox = ? ORDER BY received_at DESC LIMIT 200').all(mailbox);
}

function getMessageByKey(key) {
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(key);
}

function deleteMessageByKey(key) {
  const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(key);
  if (!msg) return false;
  const atts = db.prepare('SELECT * FROM attachments WHERE message_id = ?').all(key);
  for (const a of atts) {
    if (!a.path) continue;
    const stillUsed = db.prepare('SELECT 1 FROM attachments WHERE path = ? AND message_id != ? LIMIT 1')
      .get(a.path, key);
    if (!stillUsed) fs.rm(a.path, { force: true }, () => {});
  }
  db.prepare('DELETE FROM messages WHERE id = ?').run(key);
  return true;
}

/* ---------- forwarding ---------- */

function getForward(mailbox) {
  return db.prepare('SELECT * FROM forwards WHERE mailbox = ?').get(mailbox);
}

function setForward(mailbox, target) {
  const now = Date.now();
  if (!target) {
    db.prepare('DELETE FROM forwards WHERE mailbox = ?').run(mailbox);
    return;
  }
  db.prepare(`
    INSERT INTO forwards (mailbox, target, created_at, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(mailbox) DO UPDATE SET target = excluded.target, updated_at = excluded.updated_at
  `).run(mailbox, target, now, now);
}

/* ---------- activity ---------- */

function logActivity(type, detail = '', ip = '') {
  db.prepare('INSERT INTO activity (type, detail, ip, created_at) VALUES (?, ?, ?, ?)')
    .run(type, String(detail).slice(0, 500), ip, Date.now());
  db.prepare('DELETE FROM activity WHERE id NOT IN (SELECT id FROM activity ORDER BY id DESC LIMIT 2000)').run();
}

/* ---------- maintenance ---------- */

function purgeExpired(retentionDays) {
  const cutoff = Date.now() - retentionDays * 86400_000;
  const rows = db.prepare('SELECT id FROM messages WHERE received_at < ?').all(cutoff);
  for (const r of rows) deleteMessageByKey(r.id);
  db.prepare('DELETE FROM daily_stats WHERE day < ?')
    .run(new Date(Date.now() - 400 * 86400_000).toISOString().slice(0, 10));
  return rows.length;
}

function attachmentDiskBytes() {
  let total = 0;
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else { try { total += fs.statSync(p).size; } catch {} }
    }
  };
  walk(config.ATTACH_DIR);
  return total;
}

module.exports = {
  db, getSetting, setSetting, getAllSettings, ensureAdmin,
  listDomains, getDomain, addDomain, updateDomain, deleteDomain,
  isKnownDomain, addMessage, listMessagesFor, getMessageByKey, deleteMessageByKey,
  getForward, setForward, logActivity, purgeExpired, attachmentDiskBytes,
  DEFAULT_SETTINGS,
};

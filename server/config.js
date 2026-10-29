'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');

/**
 * Minimal .env loader (no dependency). Existing process.env values always win,
 * so systemd/cPanel environment variables override the file.
 */
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if (!value) { if (process.env[key] === undefined) process.env[key] = ''; continue; }
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
      if (quote === '"') {
        value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\"/g, '"');
      }
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(path.join(ROOT, '.env'));

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(ROOT, process.env.DATA_DIR)
  : path.join(ROOT, 'data');

for (const dir of [DATA_DIR, path.join(DATA_DIR, 'attachments'), path.join(DATA_DIR, 'tmp')]) {
  fs.mkdirSync(dir, { recursive: true });
}

function bool(v, def = false) {
  if (v === undefined || v === null || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

const config = {
  ROOT,
  DATA_DIR,
  DB_PATH: process.env.DB_PATH ? path.resolve(ROOT, process.env.DB_PATH) : path.join(DATA_DIR, 'goldenmail.db'),
  ATTACH_DIR: path.join(DATA_DIR, 'attachments'),

  PORT: Number(process.env.PORT || 3000),
  HOST: process.env.HOST || '0.0.0.0',

  SMTP_ENABLED: bool(process.env.SMTP_ENABLED, true),
  SMTP_PORT: Number(process.env.SMTP_PORT || 25),
  SMTP_HOST: process.env.SMTP_HOST || '0.0.0.0',
  SMTP_MAX_MB: Number(process.env.SMTP_MAX_MB || 25),

  SITE_URL: (process.env.SITE_URL || 'http://localhost:3000').replace(/\/$/, ''),
  TRUST_PROXY: bool(process.env.TRUST_PROXY, false),
  SECURE_COOKIES: bool(process.env.SECURE_COOKIES, false),

  ADMIN_USER: process.env.ADMIN_USER || 'admin',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || '',
  SESSION_HOURS: Number(process.env.SESSION_HOURS || 12),

  DEFAULT_DOMAIN: process.env.DEFAULT_DOMAIN || '',
  MAIL_HOSTNAME: process.env.MAIL_HOSTNAME || 'mail.localhost',
  INGEST_SECRET: process.env.INGEST_SECRET || crypto.randomBytes(24).toString('hex'),

  MAX_ATTACHMENT_MB: Number(process.env.MAX_ATTACHMENT_MB || 10),
  RETENTION_DAYS: Number(process.env.RETENTION_DAYS || 7),
};

module.exports = config;

'use strict';

/**
 * Non-interactive bootstrap used by installer.sh and installer.php.
 * Creates the database, the first admin (if none), and optional settings/domain.
 *
 * Inputs (environment):
 *   ADMIN_USER, ADMIN_PASSWORD, SITE_NAME, SITE_TAGLINE, SITE_URL,
 *   MAIL_HOSTNAME, DEFAULT_DOMAIN, SITE_SUPPORT_URL
 *
 * Prints one line of JSON on stdout; diagnostics go to stderr.
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function main() {
  const result = {
    ok: true,
    createdAdmin: false,
    username: null,
    password: null,
    domain: null,
    warnings: [],
  };

  const username = String(process.env.ADMIN_USER || 'admin').trim();
  let password = String(process.env.ADMIN_PASSWORD || '');

  if (!/^[a-zA-Z0-9._-]{3,40}$/.test(username)) {
    throw new Error('ADMIN_USER must be 3-40 characters (letters, numbers, . _ -)');
  }

  const existing = db.db.prepare('SELECT COUNT(*) AS n FROM admins').get().n;
  if (!existing) {
    if (!password) password = crypto.randomBytes(9).toString('base64url');
    if (password.length < 8) throw new Error('ADMIN_PASSWORD must be at least 8 characters');
    const hash = await bcrypt.hash(password, 12);
    db.db.prepare('INSERT INTO admins (username, password_hash, created_at) VALUES (?, ?, ?)')
      .run(username, hash, Date.now());
    result.createdAdmin = true;
    result.username = username;
    result.password = password;
    db.logActivity('install', `admin "${username}" created by installer`);
  } else {
    result.username = db.db.prepare('SELECT username FROM admins ORDER BY id LIMIT 1').get().username;
    if (password) {
      const row = db.db.prepare('SELECT id FROM admins WHERE username = ? COLLATE NOCASE').get(username);
      if (row) {
        const hash = await bcrypt.hash(password, 12);
        db.db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hash, row.id);
        db.db.prepare('DELETE FROM sessions WHERE admin_id = ?').run(row.id);
        result.passwordReset = true;
      }
    }
  }

  if (process.env.SITE_NAME) db.setSetting('site_name', String(process.env.SITE_NAME).slice(0, 60));
  if (process.env.SITE_TAGLINE) db.setSetting('site_tagline', String(process.env.SITE_TAGLINE).slice(0, 60));
  if (process.env.SITE_SUPPORT_URL) db.setSetting('support_url', String(process.env.SITE_SUPPORT_URL).slice(0, 300));
  if (process.env.MAIL_HOSTNAME) db.setSetting('mail_hostname', String(process.env.MAIL_HOSTNAME).slice(0, 190));

  const domain = String(process.env.DEFAULT_DOMAIN || '').trim().toLowerCase();
  if (domain) {
    try {
      db.addDomain(domain, { isDefault: true, note: 'created by installer' });
      result.domain = domain;
    } catch (err) {
      if (/already exists/i.test(err.message)) {
        result.domain = domain;
      } else {
        result.warnings.push(`Domain "${domain}": ${err.message}`);
      }
    }
  }

  result.ingestSecret = db.getSetting('ingest_secret');
  result.adminUrl = '/admin';
  out(result);
}

main().catch((err) => {
  out({ ok: false, error: err.message });
  process.exit(1);
});

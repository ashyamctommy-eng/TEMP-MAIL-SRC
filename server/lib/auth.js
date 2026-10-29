'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const config = require('../config');

const COOKIE_NAME = 'gm_admin';
const sessionHours = () => Math.max(1, Math.min(168, config.SESSION_HOURS));

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function cookieOptions(maxAgeMs) {
  return [
    `Path=/`,
    `HttpOnly`,
    `SameSite=Strict`,
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
    ...(config.SECURE_COOKIES ? ['Secure'] : []),
  ].join('; ');
}

async function verifyCredentials(username, password) {
  const row = db.prepare('SELECT * FROM admins WHERE username = ? COLLATE NOCASE').get(String(username || ''));
  if (!row) {
    // Spend comparable time to avoid user-enumeration timing.
    await bcrypt.compare(String(password || ''), '$2b$12$C6UzMDM.H6dfI/f/IKcEeO5.wO0n0Q0vXg4lK0v0Y0v0Y0v0Y0v0Y');
    return null;
  }
  const ok = await bcrypt.compare(String(password || ''), row.password_hash);
  if (!ok) return null;
  db.prepare('UPDATE admins SET last_login_at = ? WHERE id = ?').run(Date.now(), row.id);
  return row;
}

function createSession(admin, req) {
  const token = crypto.randomBytes(32).toString('hex');
  const csrf = crypto.randomBytes(24).toString('hex');
  const now = Date.now();
  const expires = now + sessionHours() * 3600_000;
  db.prepare(`
    INSERT INTO sessions (id, admin_id, csrf, ip, user_agent, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(sha256(token), admin.id, csrf, req.socket?.remoteAddress || '',
         String(req.headers['user-agent'] || '').slice(0, 255), now, expires);
  return { token, csrf, expires };
}

function getSession(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token || token.length !== 64) return null;
  const row = db.prepare(`
    SELECT s.*, a.username FROM sessions s
    JOIN admins a ON a.id = s.admin_id
    WHERE s.id = ? AND s.expires_at > ?
  `).get(sha256(token), Date.now());
  return row || null;
}

function destroySession(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (token) db.prepare('DELETE FROM sessions WHERE id = ?').run(sha256(token));
}

function requireAdmin(req, res, next) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  req.adminSession = session;
  const method = req.method.toUpperCase();
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    const csrf = req.headers['x-csrf-token'] || req.body?._csrf;
    if (!csrf || csrf !== session.csrf) {
      return res.status(403).json({ error: 'Invalid CSRF token' });
    }
  }
  next();
}

function requirePageAuth(req, res, next) {
  const session = getSession(req);
  if (!session) return res.redirect('/admin/login');
  req.adminSession = session;
  next();
}

async function changePassword(adminId, currentPassword, newPassword, currentSessionId = '') {
  const row = db.prepare('SELECT * FROM admins WHERE id = ?').get(adminId);
  if (!row) throw new Error('Admin not found');
  const ok = await bcrypt.compare(String(currentPassword || ''), row.password_hash);
  if (!ok) throw new Error('Current password is incorrect');
  if (!newPassword || String(newPassword).length < 8) throw new Error('New password must be at least 8 characters');
  const hash = await bcrypt.hash(String(newPassword), 12);
  db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hash, adminId);
  // Invalidate every other session for this admin; keep the current one signed in.
  db.prepare('DELETE FROM sessions WHERE admin_id = ? AND id != ?').run(adminId, currentSessionId);
  return true;
}

function cleanupSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

module.exports = {
  COOKIE_NAME, cookieOptions, parseCookies, verifyCredentials, createSession,
  getSession, destroySession, requireAdmin, requirePageAuth, changePassword,
  cleanupSessions, sha256,
};

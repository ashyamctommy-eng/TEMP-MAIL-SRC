'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const dbmod = require('./db');
const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');
const { requirePageAuth, getSession, cleanupSessions } = require('./lib/auth');
const { startSmtp } = require('./mail/smtp');

const app = express();
app.disable('x-powered-by');
if (config.TRUST_PROXY) app.set('trust proxy', 1);

/* ------------------------------ security headers ----------------------------- */

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob: https: http:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '));
  next();
});

app.use(express.json({ limit: '1mb' }));

/* --------------------------------- admin pages -------------------------------- */

const VIEWS = path.join(__dirname, 'views');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const pageCache = new Map();

/** Read a page from disk once, then serve it from memory. */
function page(name) {
  if (!pageCache.has(name)) pageCache.set(name, fs.readFileSync(path.join(VIEWS, name)));
  return pageCache.get(name);
}
function publicPage(name) {
  if (!pageCache.has(name)) pageCache.set(name, fs.readFileSync(path.join(PUBLIC_DIR, name)));
  return pageCache.get(name);
}

app.get(['/admin', '/admin/'], (req, res) => {
  if (!getSession(req)) return res.redirect('/admin/login');
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(page('admin.html'));
});

app.get('/admin/login', (req, res) => {
  if (getSession(req)) return res.redirect('/admin');
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(page('login.html'));
});

app.use('/admin/api', adminRoutes);

/* ----------------------------------- api ----------------------------------- */

app.use('/api', publicRoutes);

/* ------------------------------- public pages ------------------------------ */

app.get('/favicon.svg', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=604800');
  res.type('image/svg+xml').send(publicPage('favicon.svg'));
});

// /share/<email> opens the app pre-loaded with that mailbox (handled client-side).
app.get(['/', '/share/:email'], (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(publicPage('index.html'));
});

/* ---------------------------------- errors --------------------------------- */

app.use((req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/admin/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.status(404).type('html').send(publicPage('404.html'));
});

app.use((err, req, res, next) => {
  console.error('[http]', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal server error' });
});

/* ---------------------------------- startup -------------------------------- */

async function main() {
  if (config.DEFAULT_DOMAIN && dbmod.listDomains().length === 0) {
    try {
      dbmod.addDomain(config.DEFAULT_DOMAIN, { isDefault: true, note: 'seeded from DEFAULT_DOMAIN' });
      console.log(`[setup] seeded default domain ${config.DEFAULT_DOMAIN}`);
    } catch (err) {
      console.warn('[setup] could not seed DEFAULT_DOMAIN:', err.message);
    }
  }

  const created = await dbmod.ensureAdmin();
  if (created?.generated) {
    console.log('\n============================================');
    console.log(' GoldenMail initial admin credentials');
    console.log(`  username: ${created.username}`);
    console.log(`  password: ${created.password}`);
    console.log(`  saved to: ${created.file}`);
    console.log(' Change it after first login.');
    console.log('============================================\n');
  } else if (created) {
    console.log(`[admin] created user "${created.username}" from ADMIN_PASSWORD`);
  }

  const server = app.listen(config.PORT, config.HOST, () => {
    const shownHost = config.HOST === '0.0.0.0' ? 'localhost' : config.HOST;
    console.log(`[http] listening on http://${config.HOST}:${config.PORT}`);
    console.log(`[http] admin panel at http://${shownHost}:${config.PORT}/admin`);
  });

  if (config.SMTP_ENABLED) {
    try {
      await startSmtp();
    } catch (err) {
      console.warn('[smtp] inbound SMTP did not start — HTTP ingest still works.');
      console.warn('[smtp] Ports below 1024 need root or CAP_NET_BIND_SERVICE.');
    }
  } else {
    console.log('[smtp] disabled (SMTP_ENABLED=0)');
  }

  // Housekeeping: expire old mail and stale admin sessions.
  const housekeeping = () => {
    try {
      const removed = dbmod.purgeExpired(Number(dbmod.getSetting('retention_days')) || config.RETENTION_DAYS);
      if (removed) console.log(`[cleanup] removed ${removed} expired message(s)`);
      cleanupSessions();
      dbmod.db.exec('PRAGMA optimize;');
    } catch (err) {
      console.error('[cleanup]', err.message);
    }
  };
  housekeeping();
  const timer = setInterval(housekeeping, 60 * 60_000);
  timer.unref();

  const shutdown = (signal) => {
    console.log(`\n[server] ${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});

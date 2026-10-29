'use strict';

/**
 * End-to-end smoke test: boots the server on spare ports, signs into the admin
 * panel, adds a domain, delivers a real SMTP message, then verifies the public
 * API, attachment download, HTTP ingest, forwarding config and deletion.
 *
 *   node test/e2e.js
 */

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const nodemailer = require('nodemailer');

const PORT = 3199;
const SMTP_PORT = 2599;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'goldenmail-test-'));
const ADMIN_PASS = 'test-password-123';

let cookie = '';
let csrf = '';

function log(step) { console.log(`  ✓ ${step}`); }

async function waitFor(fn, { timeout = 15000, interval = 250, label = 'condition' } = {}) {
  const started = Date.now();
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) { /* retry */ }
    if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

async function req(pathname, options = {}) {
  const headers = Object.assign({}, options.headers);
  if (cookie) headers.Cookie = cookie;
  if (csrf && options.method && options.method !== 'GET') headers['X-CSRF-Token'] = csrf;
  if (options.body && typeof options.body === 'object' && !(options.body instanceof Buffer)) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }
  const res = await fetch(BASE + pathname, { ...options, headers });
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (setCookies.length) cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
  return res;
}

async function json(pathname, options) {
  const res = await req(pathname, options);
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

async function main() {
  console.log('GoldenMail end-to-end test');
  console.log('  data dir:', DATA_DIR);

  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PORT),
      SMTP_PORT: String(SMTP_PORT),
      DATA_DIR,
      ADMIN_USER: 'admin',
      ADMIN_PASSWORD: ADMIN_PASS,
      MAIL_HOSTNAME: 'mail.test.local',
      SMTP_ENABLED: '1',
      SECURE_COOKIES: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (d) => process.stdout.write('    [server] ' + d.toString()));
  child.stderr.on('data', (d) => process.stderr.write('    [server] ' + d.toString()));

  try {
    await waitFor(async () => (await json('/api/health')).data.ok, { label: 'HTTP health' });
    log('HTTP server is up');

    /* ---------------- auth ---------------- */
    let res;
    let data;
    ({ res } = await json('/admin/api/session'));
    assert.strictEqual(res.status, 401);
    log('admin API rejects anonymous access');

    ({ res } = await json('/admin/api/login', {
      method: 'POST', body: { username: 'admin', password: 'wrong-password' },
    }));
    assert.strictEqual(res.status, 401);
    log('bad password rejected');

    ({ res, data } = await json('/admin/api/login', {
      method: 'POST', body: { username: 'admin', password: ADMIN_PASS },
    }));
    assert.strictEqual(res.status, 200, JSON.stringify(data));
    assert.ok(cookie.includes('gm_admin='));
    log('admin login succeeded, session cookie set');

    const session = (await json('/admin/api/session')).data;
    assert.strictEqual(session.authenticated, true);
    csrf = session.csrf;
    assert.ok(csrf.length >= 24);
    log('CSRF token issued');

    /* ---------------- domains ---------------- */
    ({ res, data } = await json('/admin/api/domains', {
      method: 'POST', body: { domain: 'example.test', isDefault: true, note: 'e2e' },
    }));
    assert.strictEqual(res.status, 200, JSON.stringify(data));
    log('domain added: example.test');

    ({ res } = await json('/admin/api/domains', {
      method: 'POST', body: { domain: 'not a domain' },
    }));
    assert.strictEqual(res.status, 400);
    log('invalid domain rejected');

    const cfg = (await json('/api/config')).data;
    assert.deepStrictEqual(cfg.domains, ['example.test']);
    assert.strictEqual(cfg.defaultDomain, 'example.test');
    log('public config exposes active domain');

    /* ---------------- inbound SMTP ---------------- */
    const transport = nodemailer.createTransport({
      host: '127.0.0.1', port: SMTP_PORT, secure: false, tls: { rejectUnauthorized: false },
    });
    await transport.sendMail({
      from: 'Alice Sender <alice@outside.test>',
      to: 'duqece667@example.test',
      subject: 'Hello from the E2E test',
      html: '<p>Hi there <b>friend</b></p><script>alert(1)</script><img src="https://example.com/x.png">',
      attachments: [{ filename: 'note.txt', content: Buffer.from('attachment body') }],
    });
    log('SMTP message delivered on :' + SMTP_PORT);

    const messages = await waitFor(async () => {
      const { data } = await json('/api/messages?email=duqece667@example.test');
      return data.messages && data.messages.length ? data.messages : null;
    }, { label: 'message to appear' });

    assert.strictEqual(messages.length, 1);
    assert.strictEqual(messages[0].subject, 'Hello from the E2E test');
    assert.ok(messages[0].from.includes('alice@outside.test'));
    assert.ok(messages[0].bodyHtml.includes('<b>friend</b>'));
    assert.ok(!/script/i.test(messages[0].bodyHtml), 'script tag must be stripped');
    assert.strictEqual(messages[0].attachments.length, 1);
    log('message stored, HTML sanitized, attachment recorded');

    const att = messages[0].attachments[0];
    const download = await fetch(`${BASE}/api/attachment?key=${att.key}`);
    assert.strictEqual(download.status, 200);
    assert.strictEqual(await download.text(), 'attachment body');
    log('attachment download works');

    /* ---------------- forwarding preferences ---------------- */
    ({ res } = await json('/api/forward', {
      method: 'POST', body: { email: 'duqece667@example.test', targetEmail: 'dest@elsewhere.test' },
    }));
    assert.strictEqual(res.status, 200);
    const fwd = (await json('/api/forward?email=duqece667@example.test')).data;
    assert.strictEqual(fwd.targetEmail, 'dest@elsewhere.test');
    log('forwarding preference saved');

    /* ---------------- HTTP ingest ---------------- */
    const settings = (await json('/admin/api/settings')).data.settings;
    const rawMail = [
      'From: "Ingest Bot" <bot@outside.test>',
      'To: ingest@example.test',
      'Subject: Via HTTP ingest',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'This arrived over the HTTP fallback.',
    ].join('\r\n');

    const ingest = await fetch(`${BASE}/api/ingest?to=ingest@example.test&secret=${settings.ingest_secret}`, {
      method: 'POST', headers: { 'Content-Type': 'message/rfc822' }, body: rawMail,
    });
    assert.strictEqual(ingest.status, 200, await ingest.text());
    const ingested = await waitFor(async () => {
      const { data } = await json('/api/messages?email=ingest@example.test');
      return data.messages.length ? data.messages : null;
    }, { label: 'ingested message' });
    assert.strictEqual(ingested[0].subject, 'Via HTTP ingest');
    log('HTTP ingest path works');

    const badIngest = await fetch(`${BASE}/api/ingest?to=ingest@example.test&secret=wrong`, {
      method: 'POST', headers: { 'Content-Type': 'message/rfc822' }, body: rawMail,
    });
    assert.strictEqual(badIngest.status, 401);
    log('HTTP ingest rejects bad secret');

    /* ---------------- stats ---------------- */
    const overview = (await json('/admin/api/overview')).data;
    assert.ok(overview.totals.messages >= 2);
    assert.ok(overview.series.length === 14);
    assert.ok(overview.domainBreakdown.some((d) => d.domain === 'example.test'));
    log('admin stats aggregate correctly');

    /* ---------------- deletion ---------------- */
    res = await req('/api/messages?key=' + encodeURIComponent(messages[0].key), { method: 'DELETE' });
    assert.strictEqual(res.status, 200);
    const after = (await json('/api/messages?email=duqece667@example.test')).data;
    assert.strictEqual(after.messages.length, 0);
    log('message deletion works');

    /* ---------------- admin pages ---------------- */
    const page = await req('/admin');
    assert.strictEqual(page.status, 200);
    assert.ok((await page.text()).includes('Admin'));
    log('protected admin page renders for session');

    const anon = await fetch(`${BASE}/admin`, { redirect: 'manual' });
    assert.strictEqual(anon.status, 302);
    log('anonymous /admin redirects to login');

    console.log('\nAll checks passed ✅');
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 400));
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('\nE2E FAILED:', err);
  process.exit(1);
});

# Installing GoldenMail on cPanel

GoldenMail runs on cPanel through **Setup Node.js App** (Passenger). PHP is only
used by the installer — the application itself is Node.js.

> **Port 25 is not available on shared cPanel hosting** (Exim already owns it).
> Inbound mail therefore uses the built-in HTTPS ingest endpoint, normally fed by
> Cloudflare Email Routing. See [Receiving mail](#4-receiving-mail).

---

## 1. Upload the project

In cPanel → **File Manager**, create a folder outside `public_html`, e.g.
`/home/USER/goldenmail`, and upload/extract the project zip there.

Or from **Terminal**:

```bash
cd ~
git clone https://github.com/ashyamctommy-eng/TEMP-MAIL-SRC.git goldenmail
cd goldenmail
```

The folder must contain `server/index.js`, `package.json` and `installer.php`.

## 2. Run the installer

### Option A — Terminal (recommended)

cPanel → **Terminal** (or SSH):

```bash
cd ~/goldenmail
php installer.php \
  --domain=example.com \
  --site-url=https://mail.example.com \
  --mail-hostname=mail.example.com \
  --admin-user=admin \
  --admin-pass='choose-a-strong-password'
```

Omit `--admin-pass` to be prompted or to auto-generate one. On hosts where
`php` is not in `PATH`, use `/usr/local/bin/php` or
`/opt/cpanel/ea-php83/root/usr/bin/php`.

The installer:

1. writes `.env` (permissions 600),
2. runs `npm install --omit=dev`,
3. creates `data/goldenmail.db` and your admin account,
4. prints the admin URL and credentials,
5. writes `data/installed.lock` so it cannot run twice.

### Option B — Browser wizard

If PHP executes in that folder (for example a temporary subdomain whose docroot
is the project folder), open:

```
https://yourdomain.com/installer.php
```

Fill in the form. If `exec()` is disabled, the wizard writes `.env` and shows
the two terminal commands to finish.

## 3. Create the Node.js application

cPanel → **Setup Node.js App** → **Create Application**:

| Field | Value |
|---|---|
| Node.js version | **22.x or newer** (22.5+ required) |
| Application mode | Production |
| Application root | `goldenmail` |
| Application URL | `mail.example.com` (the domain/subdomain) |
| Application startup file | `server/index.js` |

Then press **Run NPM Install** and **Restart**.

The app reads `.env` by itself — you do **not** need to add environment
variables in the cPanel UI.

Finally enable SSL: cPanel → **SSL/TLS Status** → **Run AutoSSL**, and make sure
`SITE_URL` in `.env` uses `https://`.

> If the app fails to start, check `stderr.log` in the application root and
> confirm the Node version is 22.5+. `node:sqlite` is built into Node, so no
> native compilation is required.

## 4. Receiving mail

Shared hosting cannot listen on port 25, so mail is delivered over HTTPS to:

```
POST https://mail.example.com/api/ingest?to=user@example.com
Header: X-Ingest-Secret: <secret from Admin → Settings>
Body:   raw RFC822 message
```

### Cloudflare Email Routing (recommended)

1. Add the domain to Cloudflare (free plan is enough).
2. **Email → Email Routing** → enable, and add the MX records Cloudflare shows.
3. Create a Worker with the code below and bind it to Email Routing.
4. In the Worker → **Settings → Variables**, add:
   - `INGEST_URL` = `https://mail.example.com/api/ingest`
   - `INGEST_SECRET` = the secret from **Admin → Settings**
5. In cPanel → **Domains**, add the same domain in GoldenMail, then use the
   **DNS** button to verify.

```js
export default {
  async email(message, env) {
    const raw = await new Response(message.raw).arrayBuffer();
    const url = `${env.INGEST_URL}?to=${encodeURIComponent(message.to)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "message/rfc822",
        "X-Ingest-Secret": env.INGEST_SECRET,
      },
      body: raw,
    });
    if (!res.ok) message.setReject("Mailbox unavailable");
  },
};
```

**Tip:** use a dedicated subdomain for temp mail, e.g. `tmp.example.com`, so
Cloudflare MX records do not interfere with the email cPanel hosts for
`example.com`. Add `tmp.example.com` in Admin → Domains.

### If you control WHM/root

You can instead pipe Exim deliveries to the ingest endpoint with a custom
transport/pipe script. This is optional; the Cloudflare path needs no root.

## 5. After installation

- **Admin panel:** `https://mail.example.com/admin`
- Add/disable domains, set the default, and check DNS under **Domains**.
- Adjust branding, retention and polling under **Settings**.
- Delete `installer.php` (the success screen has a button for it).
- Keep `data/` backed up — it holds the SQLite database and attachments.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Node.js 22.5+ was not found` | Create the Node.js app first, then pass `--node=/home/USER/nodevenv/goldenmail/22/bin/node` |
| `npm install failed` | Run it in cPanel Terminal inside the app folder; check disk quota |
| 503 from Passenger | Check `stderr.log`; restart the app after changing `.env` |
| Mail never arrives | Verify the Worker ran (Cloudflare logs) and the domain is **Active** in Admin → Domains |
| `SQLITE_CANTOPEN` | `chmod -R 755 data` and ensure the app user owns it |
| Installer says "Already installed" | Delete `data/installed.lock`, or use `node server/create-admin.js` to reset the password |

## Updating

```bash
cd ~/goldenmail
git pull
npm install --omit=dev
# cPanel → Setup Node.js App → Restart
```

`.env` and `data/` are not touched by updates.

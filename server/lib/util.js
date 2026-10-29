'use strict';

const crypto = require('crypto');
const sanitizeHtml = require('sanitize-html');

function newId(bytes = 12) {
  return crypto.randomBytes(bytes).toString('hex');
}

function isValidEmail(value) {
  return typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function splitEmail(value) {
  const email = normalizeEmail(value);
  const at = email.lastIndexOf('@');
  if (at < 1) return null;
  return { local: email.slice(0, at), domain: email.slice(at + 1), email };
}

/** Sanitize untrusted HTML from an email so it can be rendered safely. */
function cleanEmailHtml(html, { cidMap = {} } = {}) {
  if (!html) return '';
  return sanitizeHtml(String(html), {
    allowVulnerableTags: true,
    allowedTags: [
      ...sanitizeHtml.defaults.allowedTags,
      'html', 'head', 'body', 'meta', 'title', 'style', 'center', 'font', 'img',
      'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'colgroup', 'col',
      'u', 's', 'strike', 'del', 'ins', 'sub', 'sup', 'small', 'big', 'hr', 'abbr',
    ],
    allowedAttributes: {
      '*': ['style', 'class', 'align', 'valign', 'width', 'height', 'bgcolor', 'color', 'dir', 'lang', 'title'],
      a: ['href', 'name', 'target', 'rel'],
      img: ['src', 'alt', 'width', 'height', 'border', 'style', 'class'],
      font: ['color', 'face', 'size'],
      table: ['border', 'cellpadding', 'cellspacing', 'width', 'bgcolor', 'style', 'align'],
      td: ['colspan', 'rowspan', 'width', 'height', 'bgcolor', 'align', 'valign', 'style'],
      th: ['colspan', 'rowspan', 'width', 'height', 'bgcolor', 'align', 'valign', 'style'],
      body: ['style', 'bgcolor'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['http', 'https', 'data', 'cid'] },
    allowProtocolRelative: false,
    transformTags: {
      a: (tagName, attribs) => {
        const href = attribs.href || '';
        if (/^\s*javascript:/i.test(href)) delete attribs.href;
        attribs.target = '_blank';
        attribs.rel = 'noopener noreferrer nofollow';
        return { tagName, attribs };
      },
      img: (tagName, attribs) => {
        const src = attribs.src || '';
        const cid = src.match(/^cid:([^"'>\s]+)$/i);
        if (cid) {
          const key = decodeURIComponent(cid[1]);
          const att = cidMap[key] || cidMap[key.replace(/^<|>$/g, '')];
          if (att) attribs.src = `/api/attachment?key=${encodeURIComponent(att)}`;
          else delete attribs.src;
        }
        if (attribs.src && !/^(https?:|data:)/i.test(attribs.src) && !attribs.src.startsWith('/api/attachment')) {
          delete attribs.src;
        }
        attribs.loading = 'lazy';
        return { tagName, attribs };
      },
    },
    exclusiveFilter: (frame) => ['script', 'iframe', 'object', 'embed', 'form', 'input'].includes(frame.tag),
    disallowedTagsMode: 'discard',
    parser: { lowerCaseTags: true },
  });
}

/** Plain-text fallback that still escapes HTML. */
function plainToHtml(text) {
  return escapeHtml(text || '').replace(/\r?\n/g, '<br>');
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(ts) {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket?.remoteAddress || '';
}

/** Tiny in-memory fixed-window rate limiter. */
function rateLimiter({ windowMs = 60_000, max = 60, keyFn } = {}) {
  const buckets = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of buckets) if (v.reset < now) buckets.delete(k);
  }, windowMs);
  timer.unref?.();

  return function limit(req, res, next) {
    const key = keyFn ? keyFn(req) : clientIp(req);
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.reset < now) {
      bucket = { count: 0, reset: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count++;
    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - bucket.count));
    if (bucket.count > max) {
      res.setHeader('Retry-After', Math.ceil((bucket.reset - now) / 1000));
      return res.status(429).json({ error: 'Too many requests. Please slow down.' });
    }
    next();
  };
}

module.exports = {
  newId, isValidEmail, normalizeEmail, splitEmail,
  cleanEmailHtml, plainToHtml, escapeHtml, formatDate, clientIp, rateLimiter,
};

'use strict';
/*
 * Webhook inbox without Hostwerk: a small HTTP receiver that stores every call, answers as configured, can forward each
 * call to a local target and replay stored calls. Signature checks for GitHub, Stripe, Shopify, Slack, Twilio, Discord and
 * plain HMAC headers. Several paths can have their own answer, forwarding and signature check ("routes").
 *
 * Secrets never lie on disk in plain text: the signature secrets and the sensitive headers of stored calls
 * (Authorization, Cookie, API keys …) are sealed with Hostwerk's key (core "secrets", AES-GCM) – the inbox shows them
 * as "••••••" and only opens them again for forwarding and replaying.
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_BODY = 1024 * 1024; // larger bodies are cut (webhooks are small)
const KEEP = 200;
const MASK = '••••••';
const KINDS = ['github', 'stripe', 'shopify', 'slack', 'twilio', 'discord', 'hmac'];
/** Headers that carry logins – stored sealed, shown masked. */
const SENSITIVE = /^(authorization|proxy-authorization|cookie|x-api-key|api-key|apikey|x-auth-token|x-access-token|x-csrf-token)$/i;
/** Without Hostwerk (tests, own scripts): no sealing – sensitive headers are then dropped instead of stored. */
const NO_SEAL = { seal: null, open: (v) => v };
/** Ed25519 public key (32 bytes, hex) → KeyObject (Discord signs its interactions with Ed25519). */
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Signature check. kind: github | stripe | shopify | slack | twilio | discord | hmac (header name in opts.header, hex or
 * base64). opts.url: the public address as the sender knows it (Twilio signs it). → { ok, why }
 */
function verify(item, secret, kind, opts = {}) {
  if (!secret) return { ok: null, why: 'No secret set' };
  const raw = Buffer.from(item.body || '', item.base64 ? 'base64' : 'utf8');
  const h = (n) => item.headers[String(n).toLowerCase()];
  const same = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  const hmac = (algo, data) => crypto.createHmac(algo, secret).update(data);
  if (kind === 'github') {
    const sig = h('x-hub-signature-256'); if (!sig) return { ok: false, why: 'Header X-Hub-Signature-256 is missing' };
    const want = `sha256=${hmac('sha256', raw).digest('hex')}`;
    return same(sig, want) ? { ok: true, why: 'GitHub signature is valid' } : { ok: false, why: 'GitHub signature does not match' };
  }
  if (kind === 'stripe') {
    const sig = h('stripe-signature'); if (!sig) return { ok: false, why: 'Header Stripe-Signature is missing' };
    const parts = Object.fromEntries(sig.split(',').map((p) => p.split('=')).filter((p) => p.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
    if (!parts.t || !sig.includes('v1=')) return { ok: false, why: 'Stripe-Signature is incomplete' };
    const want = hmac('sha256', `${parts.t}.${raw.toString('utf8')}`).digest('hex');
    const v1s = sig.split(',').filter((p) => p.trim().startsWith('v1=')).map((p) => p.trim().slice(3));
    return v1s.some((v) => same(v, want)) ? { ok: true, why: 'Stripe signature is valid' } : { ok: false, why: 'Stripe signature does not match' };
  }
  if (kind === 'shopify') {
    const sig = h('x-shopify-hmac-sha256'); if (!sig) return { ok: false, why: 'Header X-Shopify-Hmac-Sha256 is missing' };
    return same(sig, hmac('sha256', raw).digest('base64')) ? { ok: true, why: 'Shopify signature is valid' } : { ok: false, why: 'Shopify signature does not match' };
  }
  if (kind === 'slack') {
    const sig = h('x-slack-signature'); const ts = h('x-slack-request-timestamp');
    if (!sig || !ts) return { ok: false, why: 'Header X-Slack-Signature or X-Slack-Request-Timestamp is missing' };
    const want = `v0=${hmac('sha256', `v0:${ts}:${raw.toString('utf8')}`).digest('hex')}`;
    return same(sig, want) ? { ok: true, why: 'Slack signature is valid' } : { ok: false, why: 'Slack signature does not match' };
  }
  if (kind === 'twilio') {
    const sig = h('x-twilio-signature'); if (!sig) return { ok: false, why: 'Header X-Twilio-Signature is missing' };
    // Twilio signs the full address plus all form fields (sorted, name+value glued together)
    let data = opts.url || '';
    if (/x-www-form-urlencoded/i.test(String(h('content-type') || ''))) {
      const params = new URLSearchParams(raw.toString('utf8'));
      data += [...new Set([...params.keys()])].sort().map((k) => params.getAll(k).map((v) => k + v).join('')).join('');
    }
    return same(sig, crypto.createHmac('sha1', secret).update(data).digest('base64')) ? { ok: true, why: 'Twilio signature is valid' } : { ok: false, why: 'Twilio signature does not match – is the public address right?' };
  }
  if (kind === 'discord') {
    const sig = h('x-signature-ed25519'); const ts = h('x-signature-timestamp');
    if (!sig || !ts) return { ok: false, why: 'Header X-Signature-Ed25519 or X-Signature-Timestamp is missing' };
    try {
      const key = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI, Buffer.from(String(secret).trim(), 'hex')]), format: 'der', type: 'spki' });
      const ok = crypto.verify(null, Buffer.concat([Buffer.from(String(ts)), raw]), key, Buffer.from(String(sig), 'hex'));
      return ok ? { ok: true, why: 'Discord signature is valid' } : { ok: false, why: 'Discord signature does not match' };
    } catch { return { ok: false, why: 'The Discord public key is not valid (64 hex characters)' }; }
  }
  const header = opts.header || 'x-signature';
  const sig = h(header); if (!sig) return { ok: false, why: `Header ${header} is missing` };
  const d = hmac(opts.algo || 'sha256', raw).digest();
  const v = String(sig).replace(/^sha(1|256|512)=/, '');
  return same(v, d.toString('hex')) || same(v, d.toString('base64')) ? { ok: true, why: 'Signature is valid' } : { ok: false, why: 'Signature does not match' };
}

/** The address the sender called, as it sees it (behind the tunnel/remote access: forwarded host and protocol). */
function publicUrl(item) {
  const hd = item.headers || {};
  const host = hd['x-forwarded-host'] || hd.host || 'localhost';
  const proto = hd['x-forwarded-proto'] || (/^(localhost|127\.)/.test(host) ? 'http' : 'https');
  return `${proto}://${host}${item.path || '/'}${item.query ? `?${item.query}` : ''}`;
}

/** Send a stored call to a target (http://localhost:8080/hook) → { status, ms, body, contentType } or { error } */
async function sendTo(item, target, { fetchFn = fetch, headers: extra = {} } = {}) {
  let u; try { u = new URL(target); } catch { return { error: 'Invalid target address' }; }
  if (!/^https?:$/.test(u.protocol)) return { error: 'Invalid target address' };
  // Target with its own path (…/stripe/webhook) is used as is; a bare address gets the path of the call
  const q = item.query ? `?${item.query}` : '';
  const finalUrl = u.pathname && u.pathname !== '/' ? `${u.origin}${u.pathname}${q}` : `${u.origin}${item.path || '/'}${q}`;
  const headers = { ...item.headers, ...extra }; for (const k of ['host', 'content-length', 'connection', 'transfer-encoding', 'accept-encoding']) delete headers[k];
  for (const [k, v] of Object.entries(headers)) if (v === MASK) delete headers[k]; // nie die Maske weitergeben
  const t0 = Date.now();
  try {
    const res = await fetchFn(finalUrl, { method: item.method, headers, body: ['GET', 'HEAD'].includes(item.method) ? undefined : Buffer.from(item.body || '', item.base64 ? 'base64' : 'utf8'), redirect: 'manual', signal: AbortSignal.timeout(20000) });
    const text = (await res.text()).slice(0, 4000);
    return { status: res.status, ms: Date.now() - t0, body: text, contentType: res.headers.get('content-type') || null, url: finalUrl };
  } catch (e) { return { error: /ECONNREFUSED|fetch failed/.test(String(e && (e.cause && e.cause.code || e.message))) ? 'Nothing answers at the target – is your project running?' : String(e.message || e), ms: Date.now() - t0, url: finalUrl }; }
}

/** Which route answers a path: the longest matching path prefix ("/stripe" matches "/stripe/…"), else null = default. */
function matchRoute(routes, p) {
  let best = null;
  for (const r of routes || []) {
    const pre = String(r.path || '').replace(/\/+$/, '');
    if (!pre) continue;
    if ((p === pre || String(p).startsWith(`${pre}/`)) && (!best || pre.length > best.path.replace(/\/+$/, '').length)) best = r;
  }
  return best;
}

/** Split headers into what may be shown and what is sealed. */
function splitHeaders(headers) {
  const shown = {}; const hidden = {};
  for (const [k, v] of Object.entries(headers || {})) { if (SENSITIVE.test(k)) { hidden[k] = v; shown[k] = MASK; } else shown[k] = v; }
  return { shown, hidden };
}

class Inbox {
  constructor({ dir, onItem = () => {}, fetchFn = fetch, secrets = NO_SEAL }) {
    this.dir = dir; this.onItem = onItem; this.fetchFn = fetchFn; this.secrets = secrets || NO_SEAL; this.server = null; this.port = null;
    fs.mkdirSync(dir, { recursive: true });
    this.items = this.read('items', []);
    const saved = this.read('settings', {});
    this.cfg = { port: 18780, status: 200, body: '{"ok":true}', contentType: 'application/json', forward: '', secret: '', kind: 'github', header: 'x-signature', url: '', passAnswer: false, ...saved, routes: [] };
    this.cfg.secret = this.open(saved.secret);
    this.cfg.routes = (Array.isArray(saved.routes) ? saved.routes : []).map((r) => ({ ...r, secret: this.open(r.secret) }));
    // Ältere Fassungen speicherten Geheimnis und Kopfzeilen im Klartext – einmal versiegelt neu schreiben
    const plainSecret = (saved.secret && !String(saved.secret).startsWith('enc:')) || (saved.routes || []).some((r) => r.secret && !String(r.secret).startsWith('enc:'));
    if (this.secrets.seal && plainSecret) this.saveSettings();
    if (this.items.some((it) => Object.keys(it.headers || {}).some((k) => SENSITIVE.test(k) && it.headers[k] !== MASK))) {
      this.items = this.items.map((it) => this.protect(it));
      this.write('items', this.items);
    }
  }
  read(n, d) { try { return JSON.parse(fs.readFileSync(path.join(this.dir, `${n}.json`), 'utf8')); } catch { return d; } }
  write(n, v) { const f = path.join(this.dir, `${n}.json`); fs.writeFileSync(`${f}.tmp`, JSON.stringify(v)); fs.renameSync(`${f}.tmp`, f); }
  seal(v) { return v && this.secrets.seal ? this.secrets.seal(v) : v; }
  open(v) { return v ? this.secrets.open(v) || '' : ''; }
  /** Settings on disk: every secret sealed. */
  saveSettings() { this.write('settings', { ...this.cfg, secret: this.seal(this.cfg.secret), routes: this.cfg.routes.map((r) => ({ ...r, secret: this.seal(r.secret) })) }); }
  /** A call as it is stored: sensitive headers masked and sealed (without sealing: dropped). */
  protect(it) {
    const { shown, hidden } = splitHeaders(it.headers);
    const names = Object.keys(hidden);
    if (!names.length) return it;
    const prev = it.sealed ? this.openHeaders(it) : {};
    const all = { ...prev, ...hidden };
    return { ...it, headers: shown, sealed: this.secrets.seal ? this.secrets.seal(JSON.stringify(all)) : undefined, hiddenHeaders: names };
  }
  openHeaders(it) { if (!it.sealed) return {}; try { return JSON.parse(this.secrets.open(it.sealed) || '{}'); } catch { return {}; } }

  /** Checks one answer setting (default or a route) and returns the cleaned values. */
  static clean(p, base = {}) {
    const out = { ...base };
    if (p.status !== undefined) { const n = Number(p.status); if (!Number.isInteger(n) || n < 100 || n > 599) throw Object.assign(new Error('Invalid status code.'), { status: 400 }); out.status = n; }
    for (const k of ['body', 'contentType', 'forward', 'secret', 'header', 'url']) if (typeof p[k] === 'string') out[k] = p[k].slice(0, k === 'body' ? 20000 : 500);
    if (KINDS.includes(p.kind)) out.kind = p.kind;
    if (typeof p.passAnswer === 'boolean') out.passAnswer = p.passAnswer;
    if (out.forward && !/^https?:\/\//.test(out.forward)) throw Object.assign(new Error('Invalid target address'), { status: 400 });
    return out;
  }
  settings(patch) {
    if (patch) {
      const p = patch;
      if (p.port !== undefined) { const n = Number(p.port); if (!Number.isInteger(n) || n < 1024 || n > 65535) throw Object.assign(new Error('The port must be between 1024 and 65535.'), { status: 400 }); this.cfg.port = n; }
      const keep = { ...p }; if (keep.secret === MASK) delete keep.secret; // unverändert
      Object.assign(this.cfg, Inbox.clean(keep, this.cfg));
      if (Array.isArray(p.routes)) {
        const seen = new Set();
        this.cfg.routes = p.routes.slice(0, 20).map((r) => {
          const pth = `/${String(r.path || '').trim().replace(/^\/+/, '').replace(/\/+$/, '')}`;
          if (pth === '/' || !/^\/[\w\-./~%]+$/.test(pth)) throw Object.assign(new Error('A path starts with / and has letters, digits, - _ . ~ – e.g. /stripe'), { status: 400 });
          if (seen.has(pth)) throw Object.assign(new Error(`Two paths are the same: ${pth}`), { status: 400 });
          seen.add(pth);
          const old = this.cfg.routes.find((x) => x.id && x.id === r.id);
          const rr = { ...r }; if (rr.secret === MASK) rr.secret = old ? old.secret : '';
          return { ...Inbox.clean(rr, { status: 200, body: '{"ok":true}', contentType: 'application/json', forward: '', secret: '', kind: 'github', header: 'x-signature', url: '', passAnswer: false }), id: old ? old.id : (typeof r.id === 'string' && /^[a-f0-9]{8}$/.test(r.id) ? r.id : crypto.randomBytes(4).toString('hex')), path: pth, name: String(r.name || '').slice(0, 60) };
        });
      }
      this.saveSettings();
    }
    return this.cfg;
  }
  /** Settings for the page: secrets only as a mask. */
  publicSettings() {
    const m = (s) => (s ? MASK : '');
    return { ...this.cfg, secret: m(this.cfg.secret), routes: this.cfg.routes.map((r) => ({ ...r, secret: m(r.secret) })) };
  }
  async start() {
    if (this.server) return;
    const srv = http.createServer((req, res) => this.handle(req, res));
    await new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(this.cfg.port, '127.0.0.1', resolve); }).catch((e) => {
      throw Object.assign(new Error(e.code === 'EADDRINUSE' ? `Port ${this.cfg.port} is in use – choose another one.` : e.message), { status: 409 });
    });
    this.server = srv; this.port = this.cfg.port;
  }
  async stop() { if (!this.server) return; const s = this.server; this.server = null; this.port = null; await new Promise((r) => s.close(() => r())); }
  store(item) { const i = this.items.findIndex((x) => x.id === item.id); if (i >= 0) this.items[i] = item; else { this.items.unshift(item); this.items = this.items.slice(0, KEEP); } this.write('items', this.items); try { this.onItem(item); } catch { /* egal */ } }
  handle(req, res) {
    const chunks = []; let size = 0; let cut = false;
    req.on('data', (d) => { size += d.length; if (size <= MAX_BODY) chunks.push(d); else cut = true; });
    req.on('end', async () => {
      const buf = Buffer.concat(chunks);
      const ct = String(req.headers['content-type'] || '');
      const textual = !ct || /json|text|xml|x-www-form-urlencoded|javascript/i.test(ct);
      const u = new URL(req.url, 'http://x');
      const full = { id: crypto.randomBytes(6).toString('hex'), t: Date.now(), method: req.method, path: u.pathname, query: u.search.slice(1), headers: req.headers, size, cut, base64: !textual, body: textual ? buf.toString('utf8') : buf.toString('base64'), from: req.headers['cf-connecting-ip'] || req.socket.remoteAddress };
      const route = matchRoute(this.cfg.routes, full.path);
      const cfg = route || this.cfg;
      if (route) full.route = route.id;
      if (cfg.secret) full.verified = verify(full, cfg.secret, cfg.kind, { header: cfg.header, url: cfg.url || publicUrl(full) });
      // Ab hier nie mehr mit Klartext-Kopfzeilen speichern; weitergeleitet wird mit allen (aus dem Original)
      const item = this.protect(full);
      const answer = () => { res.writeHead(cfg.status, { 'content-type': cfg.contentType || 'text/plain' }); res.end(cfg.body || ''); };
      if (!cfg.forward) { this.store(item); answer(); return; }
      if (cfg.passAnswer) {
        // Auf Wunsch: Antwort des Projekts zurückgeben (wartet auf das Projekt – manche Absender werten langes Warten als Fehler)
        item.forwarded = await sendTo(full, cfg.forward, { fetchFn: this.fetchFn });
        this.store(item);
        if (item.forwarded.status) { res.writeHead(item.forwarded.status, { 'content-type': item.forwarded.contentType || 'text/plain; charset=utf-8' }); res.end(item.forwarded.body || ''); return; }
        answer(); return;
      }
      // Standard: sofort antworten (GitHub, Stripe & Co. warten nur wenige Sekunden), danach weiterleiten
      item.forwarded = { pending: true, url: cfg.forward };
      this.store(item);
      answer();
      item.forwarded = await sendTo(full, cfg.forward, { fetchFn: this.fetchFn });
      this.store(item);
    });
  }
  list() {
    return this.items.map(({ body, headers, sealed, ...rest }) => ({ ...rest, event: eventOf(headers || {}, body) }));
  }
  /** One call for the page – sensitive headers stay masked. */
  get(id) { const it = this.items.find((x) => x.id === id); if (!it) throw Object.assign(new Error('Call not found'), { status: 404 }); const { sealed, ...rest } = it; return rest; }
  /** One call with everything for sending it again (sealed headers opened). */
  full(id) { const it = this.items.find((x) => x.id === id); if (!it) throw Object.assign(new Error('Call not found'), { status: 404 }); return { ...it, headers: { ...it.headers, ...this.openHeaders(it) } }; }
  clear() { this.items = []; this.write('items', []); }
  async replay(id, target) {
    const it = this.items.find((x) => x.id === id);
    const r = await sendTo(this.full(id), target || this.cfg.forward, { fetchFn: this.fetchFn });
    it.replays = [...(it.replays || []), { t: Date.now(), ...r }].slice(-5); this.write('items', this.items);
    return r;
  }
}

/** Name of the event a call carries (GitHub, Stripe, Shopify, Slack, Discord …), else null. */
function eventOf(headers, body) {
  const h = headers || {};
  if (h['x-github-event']) return h['x-github-event'];
  if (h['x-shopify-topic']) return h['x-shopify-topic'];
  if (h['stripe-event']) return h['stripe-event'];
  try {
    const j = JSON.parse(body);
    if (j && typeof j === 'object') return j.type === 'event_callback' && j.event && j.event.type ? j.event.type : j.type != null ? String(j.type) : j.event && typeof j.event === 'string' ? j.event : null;
  } catch { /* kein JSON */ }
  return null;
}

module.exports = { Inbox, verify, sendTo, matchRoute, splitHeaders, eventOf, publicUrl, MASK, KINDS };

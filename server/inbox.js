'use strict';
/*
 * Webhook inbox without Hostwerk: a small HTTP receiver that stores every call, answers as configured, can forward each
 * call to a local target and replay stored calls. Signature checks for GitHub, Stripe and plain HMAC headers.
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_BODY = 1024 * 1024; // larger bodies are cut (webhooks are small)
const KEEP = 200;

/** Signature check. kind: github | stripe | hmac (header name in opts.header, hex or base64). → { ok, why } */
function verify(item, secret, kind, opts = {}) {
  if (!secret) return { ok: null, why: 'No secret set' };
  const raw = Buffer.from(item.body || '', item.base64 ? 'base64' : 'utf8');
  const h = (n) => item.headers[String(n).toLowerCase()];
  const same = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  if (kind === 'github') {
    const sig = h('x-hub-signature-256'); if (!sig) return { ok: false, why: 'Header X-Hub-Signature-256 is missing' };
    const want = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
    return same(sig, want) ? { ok: true, why: 'GitHub signature is valid' } : { ok: false, why: 'GitHub signature does not match' };
  }
  if (kind === 'stripe') {
    const sig = h('stripe-signature'); if (!sig) return { ok: false, why: 'Header Stripe-Signature is missing' };
    const parts = Object.fromEntries(sig.split(',').map((p) => p.split('=')).filter((p) => p.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
    if (!parts.t || !sig.includes('v1=')) return { ok: false, why: 'Stripe-Signature is incomplete' };
    const want = crypto.createHmac('sha256', secret).update(`${parts.t}.${raw.toString('utf8')}`).digest('hex');
    const v1s = sig.split(',').filter((p) => p.trim().startsWith('v1=')).map((p) => p.trim().slice(3));
    return v1s.some((v) => same(v, want)) ? { ok: true, why: 'Stripe signature is valid' } : { ok: false, why: 'Stripe signature does not match' };
  }
  const header = opts.header || 'x-signature';
  const sig = h(header); if (!sig) return { ok: false, why: `Header ${header} is missing` };
  const mac = crypto.createHmac(opts.algo || 'sha256', secret).update(raw);
  const v = String(sig).replace(/^sha(1|256|512)=/, '');
  const d = mac.digest();
  return same(v, d.toString('hex')) || same(v, d.toString('base64')) ? { ok: true, why: 'Signature is valid' } : { ok: false, why: 'Signature does not match' };
}

/** Send a stored call to a target (http://localhost:8080/hook) → { status, ms, body } or { error } */
async function sendTo(item, target, { fetchFn = fetch } = {}) {
  let u; try { u = new URL(target); } catch { return { error: 'Invalid target address' }; }
  if (!/^https?:$/.test(u.protocol)) return { error: 'Invalid target address' };
  // Target with its own path (…/stripe/webhook) is used as is; a bare address gets the path of the call
  const q = item.query ? `?${item.query}` : '';
  const finalUrl = u.pathname && u.pathname !== '/' ? `${u.origin}${u.pathname}${q}` : `${u.origin}${item.path || '/'}${q}`;
  const headers = { ...item.headers }; for (const k of ['host', 'content-length', 'connection', 'transfer-encoding', 'accept-encoding']) delete headers[k];
  const t0 = Date.now();
  try {
    const res = await fetchFn(finalUrl, { method: item.method, headers, body: ['GET', 'HEAD'].includes(item.method) ? undefined : Buffer.from(item.body || '', item.base64 ? 'base64' : 'utf8'), redirect: 'manual', signal: AbortSignal.timeout(20000) });
    const text = (await res.text()).slice(0, 4000);
    return { status: res.status, ms: Date.now() - t0, body: text, url: finalUrl };
  } catch (e) { return { error: /ECONNREFUSED|fetch failed/.test(String(e && (e.cause && e.cause.code || e.message))) ? 'Nothing answers at the target – is your project running?' : String(e.message || e), ms: Date.now() - t0, url: finalUrl }; }
}

class Inbox {
  constructor({ dir, onItem = () => {}, fetchFn = fetch }) {
    this.dir = dir; this.onItem = onItem; this.fetchFn = fetchFn; this.server = null; this.port = null;
    fs.mkdirSync(dir, { recursive: true });
    this.items = this.read('items', []);
    this.cfg = { port: 18780, status: 200, body: '{"ok":true}', contentType: 'application/json', forward: '', secret: '', kind: 'github', header: 'x-signature', ...this.read('settings', {}) };
  }
  read(n, d) { try { return JSON.parse(fs.readFileSync(path.join(this.dir, `${n}.json`), 'utf8')); } catch { return d; } }
  write(n, v) { const f = path.join(this.dir, `${n}.json`); fs.writeFileSync(`${f}.tmp`, JSON.stringify(v)); fs.renameSync(`${f}.tmp`, f); }
  settings(patch) {
    if (patch) {
      const p = patch;
      if (p.port !== undefined) { const n = Number(p.port); if (!Number.isInteger(n) || n < 1024 || n > 65535) throw Object.assign(new Error('The port must be between 1024 and 65535.'), { status: 400 }); this.cfg.port = n; }
      if (p.status !== undefined) { const n = Number(p.status); if (!Number.isInteger(n) || n < 100 || n > 599) throw Object.assign(new Error('Invalid status code.'), { status: 400 }); this.cfg.status = n; }
      for (const k of ['body', 'contentType', 'forward', 'secret', 'header']) if (typeof p[k] === 'string') this.cfg[k] = p[k].slice(0, k === 'body' ? 20000 : 500);
      if (['github', 'stripe', 'hmac'].includes(p.kind)) this.cfg.kind = p.kind;
      if (this.cfg.forward && !/^https?:\/\//.test(this.cfg.forward)) throw Object.assign(new Error('Invalid target address'), { status: 400 });
      this.write('settings', this.cfg);
    }
    return this.cfg;
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
  handle(req, res) {
    const chunks = []; let size = 0; let cut = false;
    req.on('data', (d) => { size += d.length; if (size <= MAX_BODY) chunks.push(d); else cut = true; });
    req.on('end', async () => {
      const buf = Buffer.concat(chunks);
      const ct = String(req.headers['content-type'] || '');
      const textual = !ct || /json|text|xml|x-www-form-urlencoded|javascript/i.test(ct);
      const u = new URL(req.url, 'http://x');
      const item = { id: crypto.randomBytes(6).toString('hex'), t: Date.now(), method: req.method, path: u.pathname, query: u.search.slice(1), headers: req.headers, size, cut, base64: !textual, body: textual ? buf.toString('utf8') : buf.toString('base64'), from: req.headers['cf-connecting-ip'] || req.socket.remoteAddress };
      if (this.cfg.secret) item.verified = verify(item, this.cfg.secret, this.cfg.kind, { header: this.cfg.header });
      if (this.cfg.forward) item.forwarded = await sendTo(item, this.cfg.forward, { fetchFn: this.fetchFn });
      this.items.unshift(item); this.items = this.items.slice(0, KEEP); this.write('items', this.items);
      try { this.onItem(item); } catch { /* egal */ }
      // Forwarding: hand the project's answer back to the sender; otherwise the configured answer
      if (item.forwarded && item.forwarded.status) { res.writeHead(item.forwarded.status, { 'content-type': 'text/plain; charset=utf-8' }); res.end(item.forwarded.body || ''); return; }
      res.writeHead(this.cfg.status, { 'content-type': this.cfg.contentType || 'text/plain' });
      res.end(this.cfg.body || '');
    });
  }
  list() { return this.items.map(({ body, headers, ...rest }) => ({ ...rest, event: headers['x-github-event'] || headers['stripe-event'] || (() => { try { return JSON.parse(body).type || null; } catch { return null; } })() })); }
  get(id) { const it = this.items.find((x) => x.id === id); if (!it) throw Object.assign(new Error('Call not found'), { status: 404 }); return it; }
  clear() { this.items = []; this.write('items', []); }
  async replay(id, target) {
    const it = this.get(id);
    const r = await sendTo(it, target || this.cfg.forward, { fetchFn: this.fetchFn });
    it.replays = [...(it.replays || []), { t: Date.now(), ...r }].slice(-5); this.write('items', this.items);
    return r;
  }
}

module.exports = { Inbox, verify, sendTo };

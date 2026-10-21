'use strict';
/*
 * Webhook inbox – server part (SDK 2.7 native extension).
 *   GET    /api/webhook-inbox                  → { settings, running, port, public, items }
 *   GET    /api/webhook-inbox/items/:id        → one call with headers and body
 *   DELETE /api/webhook-inbox/items            → clear
 *   PUT    /api/webhook-inbox/settings         → port, answer (status, body, contentType), forward target, passAnswer, secret,
 *                                                kind, routes (own answer/forwarding/signature per path)
 *   POST   /api/webhook-inbox/start | stop     → local receiver on 127.0.0.1:<port>
 *   POST   /api/webhook-inbox/share | unshare  → public address through Hostwerk's tunnel (cloudflared)
 *   POST   /api/webhook-inbox/items/:id/replay → { target } → answer of the target
 *   POST   /api/webhook-inbox/items/:id/to-api-tester → { col, req } (needs the API tester extension)
 *   POST   /api/webhook-inbox/fixed            → { on, rotate } fixed address through Hostwerk's remote access (own domain)
 *   ANY    /api/webhook-inbox/in/<token>/…     → public: passed on to the local receiver (only while the token is set)
 * New calls are announced with the live event "webhook-inbox".
 */
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { Inbox } = require('./inbox');

let inbox = null;

function activate(host) {
  const { ctx } = host;
  // Geheimnisse (Signatur-Schlüssel, Anmelde-Kopfzeilen gespeicherter Aufrufe) versiegelt mit Hostwerks Schlüssel
  inbox = new Inbox({ dir: path.join(ctx.paths.data, 'webhook-inbox'), secrets: host.core('secrets'), onItem: (it) => host.broadcast({ type: 'webhook-inbox', id: it.id }) });
  const tunnelKey = () => `localhost-${inbox.cfg.port}`;
  const tunnel = () => (ctx.tunnels ? ctx.tunnels.list().find((t) => t.key === tunnelKey()) : null);
  // Feste Adresse: nur mit laufendem Fernzugriff und eigener Domain (Livebetrieb → Domains & HTTPS / Fernzugriff)
  const fixedState = () => {
    const tok = inbox.read('fixed', null);
    const r = ctx.remote && ctx.remote.status ? ctx.remote.status() : null;
    const base = r && r.running && r.domain ? `https://${r.domain}${r.port && r.port !== 443 ? `:${r.port}` : ''}` : null;
    return { on: !!tok, url: tok && base ? `${base}/api/webhook-inbox/in/${tok}` : null, domain: (r && r.domain) || null, remoteRunning: !!(r && r.running) };
  };
  const state = () => {
    const t = tunnel();
    return { settings: inbox.publicSettings(), hasSecret: !!inbox.cfg.secret, running: !!inbox.server, port: inbox.port || inbox.cfg.port, public: t && t.publicUrl ? t.publicUrl : null, tunnelReady: !!(ctx.tunnels && ctx.tunnels.installed()), fixed: fixedState(), apiTester: !!(ctx.apiTester && ctx.apiTester.addRequest), items: inbox.list() };
  };
  // Was running before the restart → start again
  if (inbox.read('running', false)) inbox.start().catch((e) => host.log('start failed:', e.message));

  host.router.get('/webhook-inbox', (req, res) => res.json(state()));
  host.router.get('/webhook-inbox/items/:id', (req, res) => res.json(inbox.get(req.params.id)));
  host.router.delete('/webhook-inbox/items', (req, res) => { inbox.clear(); res.json(state()); });
  host.router.put('/webhook-inbox/settings', async (req, res) => {
    const b = { ...(req.body || {}) };
    const portBefore = inbox.cfg.port;
    inbox.settings(b);
    if (inbox.server && inbox.cfg.port !== portBefore) { await inbox.stop(); await inbox.start(); }
    res.json(state());
  });
  host.router.post('/webhook-inbox/start', async (req, res) => { await inbox.start(); inbox.write('running', true); res.json(state()); });
  host.router.post('/webhook-inbox/stop', async (req, res) => {
    const t = tunnel(); if (t && ctx.tunnels) await ctx.tunnels.stop(t.key);
    await inbox.stop(); inbox.write('running', false); res.json(state());
  });
  host.router.post('/webhook-inbox/share', async (req, res) => {
    if (!ctx.tunnels) throw host.error(409, 'Sharing is not available in this Hostwerk.');
    if (!ctx.tunnels.installed()) throw host.error(409, 'The tunnel program is not installed yet – set it up under Live → Share.');
    if (!inbox.server) { await inbox.start(); inbox.write('running', true); }
    await ctx.tunnels.start({ port: inbox.cfg.port, label: host.t('Webhook inbox') });
    res.json(state());
  });
  host.router.post('/webhook-inbox/unshare', async (req, res) => { const t = tunnel(); if (t) await ctx.tunnels.stop(t.key); res.json(state()); });

  // Synergie mit dem API-Tester: empfangenen Aufruf als Anfrage in die Sammlung „Webhook-Postfach“ legen – zum Ändern
  // und erneut Senden. Ziel: die Weiterleitung (dein Projekt) bzw. der Empfänger auf diesem PC.
  host.router.post('/webhook-inbox/items/:id/to-api-tester', (req, res) => {
    const at = ctx.apiTester;
    if (!at || typeof at.addRequest !== 'function') throw host.error(409, 'Install the API tester first (Extensions → Discover).');
    const it = inbox.full(req.params.id); // im eigenen API-Tester mit allen Kopfzeilen
    const base = (inbox.cfg.forward || `http://127.0.0.1:${inbox.port || inbox.cfg.port}`).replace(/\/$/, '');
    const skip = /^(host|content-length|connection|cookie|accept-encoding|x-forwarded-.*|cf-.*|transfer-encoding)$/i;
    const headers = Object.entries(it.headers || {}).filter(([k]) => !skip.test(k)).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v)]);
    const ct = String((it.headers || {})['content-type'] || '');
    const r = at.addRequest({ name: `${it.method} ${it.path}${(it.headers || {})['x-github-event'] ? ` (${it.headers['x-github-event']})` : ''}`, method: it.method, url: `${base}${it.path}${it.query ? `?${it.query}` : ''}`, headers, body: it.base64 ? '' : it.body || '', bodyType: /json/.test(ct) ? 'json' : /x-www-form-urlencoded/.test(ct) ? 'form' : 'text' }, { collection: 'Webhook inbox' });
    res.json(r);
  });

  // Feste Adresse über Hostwerks Fernzugriff mit eigener Domain (Livebetrieb): https://<domain>/api/webhook-inbox/in/<token>/…
  // Bleibt gleich, solange die Domain bleibt – anders als die Tunnel-Adresse. Der Schlüssel im Pfad ist das Geheimnis.
  host.router.post('/webhook-inbox/fixed', (req, res) => {
    const on = !!(req.body || {}).on;
    if (!on) inbox.write('fixed', null);
    else if (!inbox.read('fixed', null) || (req.body || {}).rotate) inbox.write('fixed', crypto.randomBytes(16).toString('hex'));
    res.json(state());
  });
  host.publicRouter.use('/webhook-inbox/in/:token', (req, res) => {
    const tok = inbox.read('fixed', null);
    const given = String(req.params.token || '');
    if (!tok || given.length !== tok.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(tok))) return res.status(404).json({ error: 'Not found' });
    if (!inbox.server) return res.status(503).json({ error: host.t('The webhook inbox is not running.') });
    // An den Empfänger auf diesem PC weiterreichen – dieselbe Logik (Prüfen, Weiterleiten, Antwort) wie lokal und im Tunnel
    const headers = { ...req.headers };
    for (const k of ['host', 'cookie', 'content-length', 'connection']) delete headers[k];
    const consumed = req.readableEnded || req.complete;
    let body = null;
    if (req.rawBody) body = req.rawBody;
    else if (consumed && req.body !== undefined && !['GET', 'HEAD'].includes(req.method)) body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));
    if (body) headers['content-length'] = String(body.length);
    else if (!consumed && req.headers['content-length']) headers['content-length'] = req.headers['content-length'];
    headers['x-forwarded-for'] = req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '';
    const up = http.request({ host: '127.0.0.1', port: inbox.port, method: req.method, path: req.url || '/', headers, timeout: 30000 }, (r) => { res.writeHead(r.statusCode || 502, r.headers); r.pipe(res); });
    up.on('timeout', () => up.destroy(new Error('timeout')));
    up.on('error', (e) => { if (!res.headersSent) res.status(502).json({ error: e.message }); });
    if (body) up.end(body); else if (!consumed) req.pipe(up); else up.end();
    return undefined;
  });
  host.router.post('/webhook-inbox/items/:id/replay', async (req, res) => {
    const target = String((req.body || {}).target || inbox.cfg.forward || '');
    if (!target) throw host.error(400, 'Please enter a target address, e.g. http://localhost:8080/webhook');
    res.json(await inbox.replay(req.params.id, target));
  });
  host.on('shutdown', () => inbox && inbox.stop());
}

function deactivate() { if (inbox) inbox.stop(); inbox = null; }

module.exports = { activate, deactivate };

'use strict';
/*
 * Webhook inbox – server part (SDK 2.7 native extension).
 *   GET    /api/webhook-inbox                  → { settings, running, port, public, items }
 *   GET    /api/webhook-inbox/items/:id        → one call with headers and body
 *   DELETE /api/webhook-inbox/items            → clear
 *   PUT    /api/webhook-inbox/settings         → port, answer (status, body, contentType), forward target, secret, kind
 *   POST   /api/webhook-inbox/start | stop     → local receiver on 127.0.0.1:<port>
 *   POST   /api/webhook-inbox/share | unshare  → public address through Hostwerk's tunnel (cloudflared)
 *   POST   /api/webhook-inbox/items/:id/replay → { target } → answer of the target
 * New calls are announced with the live event "webhook-inbox".
 */
const path = require('path');
const { Inbox } = require('./inbox');

let inbox = null;

function activate(host) {
  const { ctx } = host;
  inbox = new Inbox({ dir: path.join(ctx.paths.data, 'webhook-inbox'), onItem: (it) => host.broadcast({ type: 'webhook-inbox', id: it.id }) });
  const tunnelKey = () => `localhost-${inbox.cfg.port}`;
  const tunnel = () => (ctx.tunnels ? ctx.tunnels.list().find((t) => t.key === tunnelKey()) : null);
  const state = () => {
    const t = tunnel();
    return { settings: { ...inbox.cfg, secret: inbox.cfg.secret ? '••••••' : '' }, hasSecret: !!inbox.cfg.secret, running: !!inbox.server, port: inbox.port || inbox.cfg.port, public: t && t.publicUrl ? t.publicUrl : null, tunnelReady: !!(ctx.tunnels && ctx.tunnels.installed()), items: inbox.list() };
  };
  // Was running before the restart → start again
  if (inbox.read('running', false)) inbox.start().catch((e) => host.log('start failed:', e.message));

  host.router.get('/webhook-inbox', (req, res) => res.json(state()));
  host.router.get('/webhook-inbox/items/:id', (req, res) => res.json(inbox.get(req.params.id)));
  host.router.delete('/webhook-inbox/items', (req, res) => { inbox.clear(); res.json(state()); });
  host.router.put('/webhook-inbox/settings', async (req, res) => {
    const b = { ...(req.body || {}) };
    if (b.secret === '••••••') delete b.secret; // unchanged
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
  host.router.post('/webhook-inbox/items/:id/replay', async (req, res) => {
    const target = String((req.body || {}).target || inbox.cfg.forward || '');
    if (!target) throw host.error(400, 'Please enter a target address, e.g. http://localhost:8080/webhook');
    res.json(await inbox.replay(req.params.id, target));
  });
  host.on('shutdown', () => inbox && inbox.stop());
}

function deactivate() { if (inbox) inbox.stop(); inbox = null; }

module.exports = { activate, deactivate };

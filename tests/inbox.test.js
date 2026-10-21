'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Inbox, verify, sendTo, matchRoute, eventOf, MASK } = require('../server/inbox');
const de = require('../locales/de.json');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'whi-'));
const freePort = () => new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

test('receives a call, stores it, answers as configured', async () => {
  const got = [];
  const box = new Inbox({ dir: tmp(), onItem: (it) => got.push(it.id) });
  box.settings({ port: await freePort(), status: 202, body: 'thanks', contentType: 'text/plain' });
  await box.start();
  const res = await fetch(`http://127.0.0.1:${box.port}/hooks/stripe?x=1`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': 'push' }, body: '{"type":"checkout.session.completed"}' });
  assert.strictEqual(res.status, 202); assert.strictEqual(await res.text(), 'thanks');
  await box.stop();
  const l = box.list();
  assert.strictEqual(l.length, 1); assert.strictEqual(l[0].path, '/hooks/stripe'); assert.strictEqual(l[0].query, 'x=1'); assert.strictEqual(l[0].event, 'push');
  assert.strictEqual(got.length, 1);
  const full = box.get(l[0].id); assert.strictEqual(JSON.parse(full.body).type, 'checkout.session.completed');
  // survives a restart
  const again = new Inbox({ dir: box.dir }); assert.strictEqual(again.list().length, 1); assert.strictEqual(again.cfg.status, 202);
});

test('port in use gives a clear message; settings are checked', async () => {
  const blocker = http.createServer(); await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const box = new Inbox({ dir: tmp() }); box.settings({ port: blocker.address().port });
  await assert.rejects(box.start(), /in use/); blocker.close();
  assert.throws(() => box.settings({ port: 80 }), /1024/); assert.throws(() => box.settings({ forward: 'ftp://x' }), /Invalid target/);
});

test('forwarding with "pass answer": the project gets the call, the sender gets the project answer; replay later', async () => {
  const seen = [];
  const app = http.createServer((q, res) => { let b = ''; q.on('data', (d) => { b += d; }); q.on('end', () => { seen.push({ url: q.url, b, sig: q.headers['stripe-signature'] }); res.writeHead(201); res.end('stored'); }); });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const box = new Inbox({ dir: tmp() }); box.settings({ port: await freePort(), forward: `http://127.0.0.1:${app.address().port}/webhook`, passAnswer: true });
  await box.start();
  const res = await fetch(`http://127.0.0.1:${box.port}/any/path`, { method: 'POST', headers: { 'stripe-signature': 't=1,v1=x' }, body: 'hello' });
  assert.strictEqual(res.status, 201); assert.strictEqual(await res.text(), 'stored');
  assert.deepStrictEqual(seen[0], { url: '/webhook', b: 'hello', sig: 't=1,v1=x' });
  const id = box.list()[0].id;
  const r = await box.replay(id, `http://127.0.0.1:${app.address().port}`);
  assert.strictEqual(r.status, 201); assert.strictEqual(seen[1].url, '/any/path', 'bare target gets the path of the call');
  await box.stop(); app.close();
  const down = await sendTo(box.get(id), 'http://127.0.0.1:1/');
  assert.ok(/Nothing answers|ECONN/.test(down.error), down.error);
});

test('signatures: GitHub, Stripe, HMAC header (hex and base64)', () => {
  const body = '{"a":1}';
  const gh = { headers: { 'x-hub-signature-256': `sha256=${crypto.createHmac('sha256', 's3').update(body).digest('hex')}` }, body };
  assert.strictEqual(verify(gh, 's3', 'github').ok, true); assert.strictEqual(verify(gh, 'wrong', 'github').ok, false);
  const t = 1700000000;
  const st = { headers: { 'stripe-signature': `t=${t},v1=${crypto.createHmac('sha256', 'whsec_x').update(`${t}.${body}`).digest('hex')}` }, body };
  assert.strictEqual(verify(st, 'whsec_x', 'stripe').ok, true); assert.strictEqual(verify({ headers: {}, body }, 'whsec_x', 'stripe').ok, false);
  const b64 = { headers: { 'x-shopify-hmac-sha256': crypto.createHmac('sha256', 'k').update(body).digest('base64') }, body };
  assert.strictEqual(verify(b64, 'k', 'hmac', { header: 'X-Shopify-Hmac-Sha256' }).ok, true);
  assert.strictEqual(verify(gh, '', 'github').ok, null);
});

test('messages have German', () => {
  for (const s of ['GitHub signature is valid', 'Stripe signature does not match', 'Nothing answers at the target – is your project running?', 'The port must be between 1024 and 65535.', 'Shopify signature is valid', 'Slack signature does not match', 'Twilio signature does not match – is the public address right?', 'Discord signature is valid', 'The Discord public key is not valid (64 hex characters)', 'A path starts with / and has letters, digits, - _ . ~ – e.g. /stripe']) assert.ok(de[s], s);
});

// Fake sealing like Hostwerk's core "secrets" (AES-GCM there) – enough to see that nothing lands on disk in plain text
const fakeSecrets = { seal: (v) => 'enc:' + Buffer.from(String(v)).toString('base64'), open: (v) => (String(v).startsWith('enc:') ? Buffer.from(String(v).slice(4), 'base64').toString() : v) };
const waitFor = async (fn, ms = 3000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 20)); } };

test('forwarding answers at once – a slow project never holds the sender up; result arrives later', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const app = http.createServer(async (q, res) => { q.resume(); await gate; res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"err":1}'); });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const updates = [];
  const box = new Inbox({ dir: tmp(), onItem: (it) => updates.push(it.forwarded && it.forwarded.pending ? 'pending' : 'done') });
  box.settings({ port: await freePort(), forward: 'http://127.0.0.1:' + app.address().port + '/hook', status: 202, body: 'ok', contentType: 'text/plain' });
  await box.start();
  const t0 = Date.now();
  const res = await fetch('http://127.0.0.1:' + box.port + '/x', { method: 'POST', body: 'hi' });
  assert.strictEqual(res.status, 202); assert.strictEqual(await res.text(), 'ok');
  assert.ok(Date.now() - t0 < 1500, 'answered without waiting for the project');
  assert.ok(box.get(box.list()[0].id).forwarded.pending);
  release();
  await waitFor(() => box.items[0].forwarded && box.items[0].forwarded.status);
  assert.strictEqual(box.items[0].forwarded.status, 500);
  assert.deepStrictEqual(updates, ['pending', 'done']);
  await box.stop(); app.close();
});

test('pass answer keeps the content type of the project', async () => {
  const app = http.createServer((q, res) => { q.resume(); q.on('end', () => { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end('{"ok":true}'); }); });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const box = new Inbox({ dir: tmp() }); box.settings({ port: await freePort(), forward: 'http://127.0.0.1:' + app.address().port + '/', passAnswer: true });
  await box.start();
  const res = await fetch('http://127.0.0.1:' + box.port + '/x', { method: 'POST', body: '{}' });
  assert.match(res.headers.get('content-type'), /application\/json/);
  await box.stop(); app.close();
});

test('secrets: signature secret and login headers are sealed on disk, masked for the page, sent again on replay', async () => {
  const dir = tmp();
  const seen = [];
  const app = http.createServer((q, res) => { q.resume(); seen.push(q.headers.authorization); res.end('ok'); });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const box = new Inbox({ dir, secrets: fakeSecrets });
  box.settings({ port: await freePort(), secret: 'gh-secret', routes: [{ path: '/stripe', kind: 'stripe', secret: 'whsec_route' }] });
  await box.start();
  await fetch('http://127.0.0.1:' + box.port + '/hook', { method: 'POST', headers: { authorization: 'Bearer top-secret', 'x-api-key': 'k123', 'content-type': 'application/json' }, body: '{}' });
  await box.stop();
  const disk = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8') + fs.readFileSync(path.join(dir, 'items.json'), 'utf8');
  for (const plain of ['gh-secret', 'whsec_route', 'top-secret', 'k123']) assert.ok(!disk.includes(plain), plain + ' on disk');
  const id = box.list()[0].id;
  assert.strictEqual(box.get(id).headers.authorization, MASK);
  assert.ok(!('sealed' in box.get(id)) && !('sealed' in box.list()[0]), 'sealed blob never leaves the server');
  assert.deepStrictEqual(box.publicSettings().routes.map((r) => r.secret), [MASK]);
  assert.strictEqual(box.publicSettings().secret, MASK);
  await box.replay(id, 'http://127.0.0.1:' + app.address().port + '/');
  assert.strictEqual(seen[0], 'Bearer top-secret');
  app.close();
  // Neustart: Geheimnisse wieder lesbar, Maske beim Speichern = unverändert
  const again = new Inbox({ dir, secrets: fakeSecrets });
  assert.strictEqual(again.cfg.secret, 'gh-secret');
  again.settings({ secret: MASK, routes: [{ ...again.publicSettings().routes[0] }] });
  assert.strictEqual(again.cfg.routes[0].secret, 'whsec_route');
});

test('without sealing (no Hostwerk) login headers are dropped, never stored in plain text', async () => {
  const box = new Inbox({ dir: tmp() });
  box.settings({ port: await freePort() });
  await box.start();
  await fetch('http://127.0.0.1:' + box.port + '/h', { method: 'POST', headers: { authorization: 'Bearer x1' }, body: '' });
  await box.stop();
  assert.ok(!JSON.stringify(box.items).includes('Bearer x1'));
});

test('older inboxes: plain secrets and headers get sealed on the first start', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ port: 18999, secret: 'old-plain' }));
  fs.writeFileSync(path.join(dir, 'items.json'), JSON.stringify([{ id: 'a1', t: 1, method: 'POST', path: '/', headers: { cookie: 'sid=1' }, body: '' }]));
  const box = new Inbox({ dir, secrets: fakeSecrets });
  const disk = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8') + fs.readFileSync(path.join(dir, 'items.json'), 'utf8');
  assert.ok(!disk.includes('old-plain') && !disk.includes('sid=1'));
  assert.strictEqual(box.full('a1').headers.cookie, 'sid=1');
});

test('routes: own answer per path, longest prefix wins, checked paths', async () => {
  const routes = [{ path: '/shop' }, { path: '/shop/orders' }];
  assert.strictEqual(matchRoute(routes, '/shop/orders/1').path, '/shop/orders');
  assert.strictEqual(matchRoute(routes, '/shop').path, '/shop');
  assert.strictEqual(matchRoute(routes, '/shopify'), null, 'not just a string prefix');
  const box = new Inbox({ dir: tmp() });
  assert.throws(() => box.settings({ routes: [{ path: '/' }] }), /path starts/);
  assert.throws(() => box.settings({ routes: [{ path: '/a' }, { path: 'a/' }] }), /same/);
  box.settings({ port: await freePort(), routes: [{ path: 'github/', status: 204, body: '' }] });
  assert.strictEqual(box.cfg.routes[0].path, '/github');
  await box.start();
  const a = await fetch('http://127.0.0.1:' + box.port + '/github/push', { method: 'POST', body: '{}' });
  const b = await fetch('http://127.0.0.1:' + box.port + '/other', { method: 'POST', body: '{}' });
  assert.deepStrictEqual([a.status, b.status], [204, 200]);
  assert.strictEqual(box.list().find((x) => x.path === '/github/push').route, box.cfg.routes[0].id);
  await box.stop();
});

test('more signatures: Shopify, Slack, Twilio, Discord', () => {
  const body = '{"a":1}';
  const sh = { headers: { 'x-shopify-hmac-sha256': crypto.createHmac('sha256', 'shp').update(body).digest('base64') }, body };
  assert.strictEqual(verify(sh, 'shp', 'shopify').ok, true); assert.strictEqual(verify(sh, 'x', 'shopify').ok, false);
  const ts = '1700000000';
  const sl = { headers: { 'x-slack-request-timestamp': ts, 'x-slack-signature': 'v0=' + crypto.createHmac('sha256', 'slk').update('v0:' + ts + ':' + body).digest('hex') }, body };
  assert.strictEqual(verify(sl, 'slk', 'slack').ok, true); assert.strictEqual(verify({ headers: {}, body }, 'slk', 'slack').ok, false);
  const form = 'To=%2B49&From=%2B1&Body=Hi';
  const url = 'https://example.com/sms';
  const twSig = crypto.createHmac('sha1', 'tw').update(url + 'BodyHiFrom+1To+49').digest('base64');
  const tw = { headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twSig }, body: form };
  assert.strictEqual(verify(tw, 'tw', 'twilio', { url }).ok, true);
  assert.strictEqual(verify(tw, 'tw', 'twilio', { url: 'https://other.example/sms' }).ok, false);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubHex = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
  const dsig = crypto.sign(null, Buffer.from(ts + body), privateKey).toString('hex');
  const dc = { headers: { 'x-signature-ed25519': dsig, 'x-signature-timestamp': ts }, body };
  assert.strictEqual(verify(dc, pubHex, 'discord').ok, true);
  assert.strictEqual(verify({ ...dc, body: '{"a":2}' }, pubHex, 'discord').ok, false);
  assert.strictEqual(verify(dc, 'nothex', 'discord').ok, false);
});

test('events for filtering: GitHub, Shopify, Stripe, Slack, Discord', () => {
  assert.strictEqual(eventOf({ 'x-github-event': 'push' }, ''), 'push');
  assert.strictEqual(eventOf({ 'x-shopify-topic': 'orders/create' }, ''), 'orders/create');
  assert.strictEqual(eventOf({}, '{"type":"invoice.paid"}'), 'invoice.paid');
  assert.strictEqual(eventOf({}, '{"type":"event_callback","event":{"type":"app_mention"}}'), 'app_mention');
  assert.strictEqual(eventOf({}, '{"type":1}'), '1');
  assert.strictEqual(eventOf({}, 'not json'), null);
});

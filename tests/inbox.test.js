'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Inbox, verify, sendTo } = require('../server/inbox');
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

test('forwarding: the project gets the call, the sender gets the project answer; replay later', async () => {
  const seen = [];
  const app = http.createServer((q, res) => { let b = ''; q.on('data', (d) => { b += d; }); q.on('end', () => { seen.push({ url: q.url, b, sig: q.headers['stripe-signature'] }); res.writeHead(201); res.end('stored'); }); });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const box = new Inbox({ dir: tmp() }); box.settings({ port: await freePort(), forward: `http://127.0.0.1:${app.address().port}/webhook` });
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
  for (const s of ['GitHub signature is valid', 'Stripe signature does not match', 'Nothing answers at the target – is your project running?', 'The port must be between 1024 and 65535.']) assert.ok(de[s], s);
});

'use strict';
/* curl command of a stored call (page of the webhook inbox; CommonJS so the tests can load it too). */
const MASK = '••••••';

/** A call as curl command (to try it in the terminal). Masked login headers are left out; target = forwarding or receiver. */
function toCurl(item, base) {
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const skip = /^(host|content-length|connection|accept-encoding|transfer-encoding|expect|keep-alive|upgrade|te|trailer|proxy-connection|x-forwarded-.*|cf-.*|cdn-loop)$/i;
  // wie beim Weiterleiten: ein Ziel mit eigenem Pfad (…/webhook) gilt so, eine bloße Adresse bekommt den Pfad des Aufrufs
  let u = null; try { u = new URL(String(base || '')); } catch { /* keine Adresse */ }
  const qs = item.query ? `?${item.query}` : '';
  const url = u && u.pathname && u.pathname !== '/' ? `${u.origin}${u.pathname}${qs}` : `${u ? u.origin : String(base || '').replace(/\/+$/, '')}${item.path || '/'}${qs}`;
  const parts = ['curl', '-X', item.method || 'GET', q(url)];
  for (const [k, v] of Object.entries(item.headers || {})) { if (skip.test(k) || v === MASK) continue; for (const x of Array.isArray(v) ? v : [v]) parts.push('-H', q(`${k}: ${x}`)); }
  if (item.body && !['GET', 'HEAD'].includes(item.method)) {
    if (item.base64) parts.push('--data-binary', '@body.bin');
    else parts.push('--data-binary', q(item.body));
  }
  return parts.join(' ');
}

module.exports = { toCurl };

import { createElement, useEffect, useMemo, useRef, useState } from 'react';
import { Inbox, Play, Square, Globe, Copy, Trash2, RotateCcw, ShieldCheck, ShieldAlert, Settings2, ArrowRight, Link2, RefreshCw, Zap, Plus, Pencil, Lock, Search, Terminal } from 'lucide-react';
import { get, post, put, del, useApi, on } from '@hostwerk/api';
import { Btn, Tabs, Seg, Empty, Loading, Callout, InfoTip, Field, Modal, toast, confirmDialog } from '@hostwerk/ui';
import { toCurl } from './curl.js';
import './style.css';

/*
 * Webhook inbox: receiver on/off and public address at the top, calls on the left, the selected call on the right.
 * Texts are English; German comes from locales/de.json (also inside JSX).
 */
// Zeiten in Hostwerks Sprache, nicht in der des Systems
const locale = () => (document.documentElement.lang === 'en' ? 'en-GB' : 'de-DE');
const fmtTime = (t) => new Date(t).toLocaleTimeString(locale());
const fmtWhen = (t) => new Date(t).toLocaleString(locale());
const MASK = '••••••';
const KINDS = [{ id: 'github', label: 'GitHub' }, { id: 'stripe', label: 'Stripe' }, { id: 'shopify', label: 'Shopify' }, { id: 'slack', label: 'Slack' }, { id: 'twilio', label: 'Twilio' }, { id: 'discord', label: 'Discord' }, { id: 'hmac', label: 'HMAC header' }];
const SECRET_HINT = { discord: 'Public key of your Discord app (64 hex characters)', twilio: 'Auth token of your Twilio account' };
// Empfangene Daten (Inhalt, Pfade, Ereignisse, Kopfzeilen) nie durch Hostwerks JSX-Übersetzung schicken – ein Ereignis
// „Delete“ hieße sonst „Löschen“, ein Inhalt „Saved“ „Gespeichert“. Gleicher Mechanismus wie Hostwerks <Keep>, ohne @hostwerk/kit.
const KEEP = Symbol.for('hostwerk.keep');
function Keep({ children }) { return children === undefined ? null : children; }
Keep[KEEP] = true;
function Raw({ as = 'span', ...props }) { return createElement(as, props); }
Raw[KEEP] = true;
const copy = async (text, what) => { try { await navigator.clipboard.writeText(text); toast.success(`${what} copied`); } catch { toast.error('Could not copy'); } };

/** Answer, forwarding and signature check – the same fields for the default and for every own path. */
function AnswerFields({ f, setF }) {
  const set = (k) => (e) => setF({ ...f, [k]: e && e.target ? e.target.value : e });
  return (
    <>
      <Field label="Forward every call to" hint="e.g. http://localhost:8080/webhook – the sender gets the answer below at once, your project gets the call right after."><input className="input mono" value={f.forward || ''} placeholder="http://localhost:8080/webhook" onChange={set('forward')} /></Field>
      {f.forward ? (
        <label className="row-tight small whi-check">
          <input type="checkbox" checked={!!f.passAnswer} onChange={(e) => setF({ ...f, passAnswer: e.target.checked })} />
          <span className="grow">Pass on your project's answer</span>
          <InfoTip pop title="Pass on your project's answer">The sender then waits for your project (up to 20 seconds). GitHub, Stripe and others count a slow answer as a failure – leave it off unless you need the real answer.</InfoTip>
        </label>
      ) : null}
      <div className="grid grid-2">
        <Field label="Answer status"><input className="input" inputMode="numeric" value={f.status} onChange={set('status')} /></Field>
        <Field label="Answer type"><input className="input mono" value={f.contentType || ''} onChange={set('contentType')} /></Field>
      </div>
      <Field label="Answer body"><textarea className="input mono" rows={3} value={f.body || ''} onChange={set('body')} /></Field>
      <Field label="Signature check" hint="The secret from the sender's webhook settings. Stored encrypted on this PC.">
        <select className="select" value={f.kind} onChange={set('kind')} aria-label="Signature check">{KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}</select>
      </Field>
      {f.kind === 'hmac' && <Field label="Header name"><input className="input mono" value={f.header || ''} onChange={set('header')} /></Field>}
      {f.kind === 'twilio' && <Field label="Public address as Twilio knows it" hint="Twilio signs the full address. Empty = the address the call came in on."><input className="input mono" value={f.url || ''} placeholder="https://…/sms" onChange={set('url')} /></Field>}
      <Field label={f.kind === 'discord' ? 'Public key' : 'Secret'} hint={SECRET_HINT[f.kind]}><input className="input mono" type="password" autoComplete="off" value={f.secret || ''} placeholder={f.kind === 'discord' ? 'a1b2c3…' : 'whsec_… / your GitHub secret'} onChange={set('secret')} /></Field>
      <label className="row-tight small whi-check">
        <input type="checkbox" checked={!!f.rejectInvalid} disabled={!f.secret} onChange={(e) => setF({ ...f, rejectInvalid: e.target.checked })} />
        <span className="grow">Reject invalid signatures (401)</span>
        <InfoTip pop title="Reject invalid signatures (401)">Calls with a wrong or too old signature get 401 and are not forwarded – the sender sees the error at once. They still show up here.</InfoTip>
      </label>
    </>
  );
}

const NEW_ROUTE = { path: '', name: '', status: 200, body: '{"ok":true}', contentType: 'application/json', forward: '', kind: 'github', header: 'x-signature', secret: '', url: '', passAnswer: false };

function Settings({ s, onClose, onSaved }) {
  const [f, setF] = useState({ ...s.settings, routes: s.settings.routes || [] });
  const [editing, setEditing] = useState(null); // Index eines Pfads oder -1 für einen neuen
  const [draft, setDraft] = useState(null);
  const save = async () => { try { onSaved(await put('/webhook-inbox/settings', f)); toast.success('Saved'); onClose(); } catch (e) { toast.error(e); } };
  const openRoute = (i) => { setEditing(i); setDraft(i < 0 ? { ...NEW_ROUTE } : { ...f.routes[i] }); };
  const back = () => { setEditing(null); setDraft(null); };
  const keepRoute = () => {
    if (!String(draft.path || '').replace(/\//g, '').trim()) { toast.error('Enter a path, e.g. /stripe'); return; }
    const routes = editing < 0 ? [...f.routes, draft] : f.routes.map((r, i) => (i === editing ? draft : r));
    setF({ ...f, routes }); back();
  };
  const dropRoute = (i) => setF({ ...f, routes: f.routes.filter((_, j) => j !== i) });
  if (draft) {
    return (
      <Modal title={editing < 0 ? 'New path' : 'Edit path'} onClose={back} footer={<><Btn onClick={back}>Back</Btn><Btn className="primary" onClick={keepRoute}>Apply</Btn></>}>
        <div className="stack">
          <div className="grid grid-2">
            <Field label="Path" hint="Calls to this path and everything below it, e.g. /stripe → /stripe/…"><input className="input mono" value={draft.path} placeholder="/stripe" onChange={(e) => setDraft({ ...draft, path: e.target.value })} /></Field>
            <Field label="Name (optional)"><input className="input" value={draft.name || ''} placeholder="Shop payments" onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
          </div>
          <AnswerFields f={draft} setF={setDraft} />
        </div>
      </Modal>
    );
  }
  return (
    <Modal title="Inbox settings" onClose={onClose} footer={<><Btn onClick={onClose}>Cancel</Btn><Btn className="primary" onClick={save}>Save</Btn></>}>
      <div className="stack">
        <Field label="Port on this PC" hint="Only reachable from this PC – public only through “Make public”."><input className="input" inputMode="numeric" value={f.port} onChange={(e) => setF({ ...f, port: e.target.value })} /></Field>
        <h3 className="whi-sub">For all other paths</h3>
        <AnswerFields f={f} setF={setF} />
        <div className="row-tight"><h3 className="whi-sub grow">Own paths</h3><InfoTip pop title="Own paths">Several senders on one inbox: each path gets its own answer, forwarding and signature check – e.g. /stripe for payments and /github for pushes.</InfoTip><Btn className="sm" icon={Plus} onClick={() => openRoute(-1)}>Add path</Btn></div>
        {f.routes.length ? (
          <div className="stack whi-routes">{f.routes.map((r, i) => (
            <div key={r.id || `new-${i}`} className="list-item row-tight">
              <code className="grow ellipsis"><Keep>{r.path}</Keep></code>
              {r.name ? <span className="small muted ellipsis"><Keep>{r.name}</Keep></span> : null}
              <span className="badge">{(KINDS.find((k) => k.id === r.kind) || {}).label || r.kind}</span>
              {r.forward ? <ArrowRight size={13} className="muted" aria-label="Forwards" /> : null}
              <button type="button" className="btn ghost xs icon" title="Edit path" aria-label={`Edit path ${r.path}`} onClick={() => openRoute(i)}><Pencil size={12} /></button>
              <button type="button" className="btn ghost xs icon" title="Remove path" aria-label={`Remove path ${r.path}`} onClick={() => dropRoute(i)}><Trash2 size={12} /></button>
            </div>
          ))}</div>
        ) : <p className="small muted">No own paths – every call gets the answer above.</p>}
      </div>
    </Modal>
  );
}

function Detail({ id, s, rev, onRemove }) {
  const [it, setIt] = useState(null);
  const [tab, setTab] = useState('body');
  // Ziel: die Weiterleitung des Pfads, über den der Aufruf kam – sonst die allgemeine
  const [target, setTarget] = useState(() => { const cur = s.items.find((x) => x.id === id); const r = cur && cur.route ? (s.settings.routes || []).find((x) => x.id === cur.route) : null; return (r && r.forward) || s.settings.forward || ''; });
  const [busy, setBusy] = useState(false);
  const [replayed, setReplayed] = useState(null);
  useEffect(() => { setIt(null); setReplayed(null); }, [id]);
  // Neu laden, sobald sich der Aufruf ändert (Weiterleitung fertig, erneut abgespielt) – sonst bliebe „Wird weitergeleitet …“ stehen
  // rev in der Adresse: Hostwerks get() merkt sich Antworten 1 s – ohne sie käme kurz nach „wird weitergeleitet“ der alte Stand zurück
  useEffect(() => { get(`/webhook-inbox/items/${id}?rev=${encodeURIComponent(rev || '')}`).then(setIt).catch((e) => toast.error(e)); }, [id, rev]);
  const pretty = useMemo(() => { if (!it || it.base64) return null; try { return JSON.stringify(JSON.parse(it.body), null, 2); } catch { return it.body; } }, [it]);
  if (!it) return <Loading />;
  // Synergie: im API-Tester öffnen (ändern, erneut senden, als Sammlung behalten)
  const toApiTester = async () => { try { const r = await post(`/webhook-inbox/items/${id}/to-api-tester`); location.hash = `/ext/api-tester?col=${encodeURIComponent(r.col)}&req=${encodeURIComponent(r.req)}`; } catch (e) { toast.error(e); } };
  const replay = async () => { setBusy(true); try { setReplayed(await post(`/webhook-inbox/items/${id}/replay`, { target })); } catch (e) { toast.error(e); } setBusy(false); };
  const v = it.verified;
  const base = target || `http://localhost:${s.port}`;
  return (
    <div className="stack" style={{ gap: 'var(--sp-3)' }}>
      <div className="row-tight" style={{ flexWrap: 'wrap' }}>
        <span className="badge accent">{it.method}</span><code className="ellipsis whi-path"><Keep>{`${it.path}${it.query ? `?${it.query}` : ''}`}</Keep></code>
        <span className="small muted whi-when">{fmtWhen(it.t)} · {it.size} B{it.cut ? ' · cut at 1 MB' : ''}</span>
      </div>
      {v && <Callout kind={v.ok ? 'ok' : v.ok === false ? 'err' : 'info'} icon={v.ok ? ShieldCheck : ShieldAlert}>{v.why}</Callout>}
      {it.answered === 401 && <Callout kind="warn">Rejected with 401 – not forwarded.</Callout>}
      {it.tooLarge && <Callout kind="warn">Too large – the receiver stopped reading at 8 MB and answered 413.</Callout>}
      {/* Ein Text statt mehrerer Teile – nur so greifen die Muster in locales/de.json („Forwarded to {}: {}“) */}
      {it.forwarded && (it.forwarded.pending ? <Callout kind="info">{`Being forwarded to ${it.forwarded.url} …`}</Callout>
        : <Callout kind={it.forwarded.error || it.forwarded.status >= 400 ? 'err' : 'ok'}>{`Forwarded to ${it.forwarded.url}: ${it.forwarded.error || `${it.forwarded.status} in ${it.forwarded.ms} ms`}`}</Callout>)}
      {it.hiddenHeaders && it.hiddenHeaders.length ? <div className="small muted row-tight"><Lock size={13} />Login headers are stored encrypted and only sent again when forwarding or replaying.</div> : null}
      <div className="row-tight whi-tools">
        <Tabs tabs={[{ id: 'body', label: 'Body' }, { id: 'headers', label: `Headers (${Object.keys(it.headers).length})` }]} value={tab} onChange={setTab} />
        <span className="grow" />
        {!it.base64 && it.body ? <Btn className="xs ghost" icon={Copy} onClick={() => copy(pretty || it.body, 'Body')}>Copy body</Btn> : null}
        <Btn className="xs ghost" icon={Terminal} title={it.hiddenHeaders && it.hiddenHeaders.length ? 'Login headers are left out – add them yourself.' : undefined} onClick={() => copy(toCurl(it, base), 'curl command')}>Copy as curl</Btn>
        <Btn className="xs ghost icon" icon={Trash2} title="Delete this call" aria-label="Delete this call" onClick={onRemove} />
      </div>
      {tab === 'body' ? (it.base64 ? <div className="small muted">Binary content – not shown.</div> : <pre className="code-block whi-pre">{pretty ? <Keep>{pretty}</Keep> : '(empty)'}</pre>)
        : <table className="table"><tbody>{Object.entries(it.headers).map(([k, x]) => <tr key={k}><td className="mono small"><Keep>{k}</Keep></td><td className="mono small whi-break"><Keep>{String(x)}</Keep></td></tr>)}</tbody></table>}
      <div className="card"><div className="card-body stack" style={{ gap: 'var(--sp-2)' }}>
        <div className="row-tight"><b className="small grow">Replay this call</b><InfoTip pop title="Replay">Sends exactly this call again – same method, headers and body – for example after you fixed your webhook code.</InfoTip></div>
        <div className="row-tight"><input className="input sm mono grow" value={target} aria-label="Target address" placeholder="http://localhost:8080/webhook" onChange={(e) => setTarget(e.target.value)} /><Btn className="sm primary" icon={RotateCcw} busy={busy} onClick={replay}>Replay</Btn></div>
        {s.apiTester && <div className="row-tight"><Btn className="sm" icon={Zap} onClick={toApiTester}>Open in API tester</Btn><span className="tiny muted">Change it there and send it again.</span></div>}
        {replayed && <div className={`small ${replayed.error || replayed.status >= 400 ? 'c-err' : 'c-ok'}`}>{replayed.error || `${replayed.status} in ${replayed.ms} ms`}{replayed.body ? <pre className="code-block whi-pre" style={{ marginTop: 'var(--sp-2)', maxHeight: 160 }}><Keep>{replayed.body}</Keep></pre> : null}</div>}
      </div></div>
    </div>
  );
}

function WebhookInboxPage() {
  const st = useApi('/webhook-inbox', [], { live: false });
  const [sel, setSel] = useState(null);
  const [edit, setEdit] = useState(false);
  const [q, setQ] = useState('');
  const [ev, setEv] = useState('');
  const listRef = useRef(null);
  const s = st.data;
  const events = useMemo(() => (s ? [...new Set(s.items.map((it) => it.event).filter(Boolean))].sort() : []), [s]);
  const shown = useMemo(() => (s ? s.items.filter((it) => (!ev || it.event === ev) && (!q || `${it.method} ${it.path} ${it.query} ${it.event || ''}`.toLowerCase().includes(q.toLowerCase()))) : []), [s, q, ev]);
  // Neue Aufrufe: gebündelt (höchstens alle 300 ms) und immer frisch laden – Hostwerks get() liefert innerhalb 1 s die gemerkte
  // Antwort, nach vielen Aufrufen am Stück fehlten sonst die letzten, bis der nächste kam
  useEffect(() => {
    let timer = null; let n = 0;
    const fresh = () => { timer = null; const k = ++n; get(`/webhook-inbox?fresh=${Date.now()}`).then((d) => { if (k === n) st.setData(d); }).catch(() => {}); };
    const off = on('webhook-inbox', () => { if (!timer) timer = setTimeout(fresh, 300); });
    return () => { off(); clearTimeout(timer); };
  }, [st.setData]); // eslint-disable-line react-hooks/exhaustive-deps
  // Erster Aufruf vorausgewählt – auch wenn der gewählte inzwischen herausgefallen ist (nur die letzten 200 bleiben)
  useEffect(() => { if (s && (!sel || !s.items.some((x) => x.id === sel)) && s.items[0]) setSel(s.items[0].id); }, [s]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!s) return <Loading />;
  const act = async (p) => { try { st.setData(await post(`/webhook-inbox/${p}`)); } catch (e) { toast.error(e); } };
  const fixed = async (on, rotate = false) => { if (rotate && !(await confirmDialog({ title: 'New fixed address?', text: 'The old address stops working at once – update it at the sender (GitHub, Stripe …).', confirm: 'New address' }))) return; try { st.setData(await post('/webhook-inbox/fixed', { on, rotate })); } catch (e) { toast.error(e); } };
  const focusId = shown.some((x) => x.id === sel) ? sel : (shown[0] || {}).id; // nur ein Eintrag per Tab erreichbar, die Pfeiltasten wechseln
  const removeOne = async (id) => { try { const i = shown.findIndex((x) => x.id === id); const d = await del(`/webhook-inbox/items/${id}`); st.setData(d); const next = shown[i + 1] || shown[i - 1]; setSel(next ? next.id : null); } catch (e) { toast.error(e); } };
  // ↑/↓ (und Pos1/Ende) in der Aufrufliste wechseln die Auswahl; Entf löscht den gewählten Aufruf
  const onListKey = (e) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Delete'].includes(e.key) || e.target.closest('input, select')) return;
    e.preventDefault();
    if (e.key === 'Delete') { if (sel) removeOne(sel); return; }
    const i = shown.findIndex((x) => x.id === sel);
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? shown.length - 1 : Math.max(0, Math.min(shown.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
    if (!shown[j]) return;
    setSel(shown[j].id);
    const el = listRef.current && listRef.current.querySelector(`[data-id="${shown[j].id}"]`); if (el) el.focus();
  };
  const clear = async () => { if (await confirmDialog({ title: 'Delete all stored calls?', confirm: 'Delete', danger: true })) { try { st.setData(await del('/webhook-inbox/items')); setSel(null); } catch (e) { toast.error(e); } } };
  const local = `http://localhost:${s.port}`;
  const cur = s.items.find((x) => x.id === sel);
  const rev = cur ? `${cur.forwarded ? (cur.forwarded.pending ? 'p' : cur.forwarded.status || cur.forwarded.error || 'd') : ''}:${(cur.replays || []).length}` : '';
  return (
    <div className="page fade-in whi">
      <div className="page-head">
        <div>
          <h1><Inbox /> Webhook inbox</h1>
          <p>Receive webhooks from Stripe, GitHub & co., look inside, check signatures and pass them on to your project.</p>
        </div>
        <div className="actions">
          <Btn className="sm ghost" icon={Settings2} onClick={() => setEdit(true)}>Settings</Btn>
          {s.running ? <Btn className="sm" icon={Square} onClick={() => act('stop')}>Stop</Btn> : <Btn className="sm primary" icon={Play} onClick={() => act('start')}>Start receiver</Btn>}
        </div>
      </div>
      <div className="card mb">
        <div className="card-body stack" style={{ gap: 'var(--sp-3)' }}>
          <div className="row-tight whi-addr">
            <span className={`badge ${s.running ? 'ok' : ''}`}>{s.running ? 'Receiving' : 'Off'}</span>
            <span className="small muted">On this PC:</span><code>{local}/…</code><button type="button" className="btn ghost xs icon" title="Copy" aria-label="Copy" onClick={() => copy(local, 'Address')}><Copy size={12} /></button>
          </div>
          <div className="row-tight whi-addr">
            <Globe size={14} className="muted" />
            {s.public ? (<><span className="small muted">Public:</span><code className="ellipsis"><Keep>{s.public}</Keep></code><button type="button" className="btn ghost xs icon" title="Copy" aria-label="Copy" onClick={() => copy(s.public, 'Address')}><Copy size={12} /></button><Btn className="sm ghost" onClick={() => act('unshare')}>Close public address</Btn></>)
              : (<><span className="small muted grow">Senders on the internet need a public address. Hostwerk opens one through its tunnel – it stays only while it runs, and emergency mode closes it.</span><Btn className="sm" icon={Globe} disabled={!s.tunnelReady} title={s.tunnelReady ? '' : 'Set up the tunnel under Go live → Online first'} onClick={() => act('share')}>Make public</Btn></>)}
          </div>
          {/* Feste Adresse über die eigene Domain (Fernzugriff im Livebetrieb) – bleibt gleich, anders als die Tunnel-Adresse */}
          <div className="row-tight whi-addr">
            <Link2 size={14} className="muted" />
            {s.fixed && s.fixed.url ? (<><span className="small muted">Fixed:</span><code className="ellipsis">{`${s.fixed.url}/…`}</code><button type="button" className="btn ghost xs icon" title="Copy" aria-label="Copy" onClick={() => copy(s.fixed.url, 'Address')}><Copy size={12} /></button><Btn className="sm ghost" icon={RefreshCw} onClick={() => fixed(true, true)}>New address</Btn><Btn className="sm ghost" onClick={() => fixed(false)}>Turn off</Btn></>)
              : s.fixed && s.fixed.on ? (<><span className="small c-warn grow">The fixed address needs remote access with your own domain – set it up under Go live → Online → Addresses and Go live → Access → Remote access.</span><a className="btn sm" href="#/live/zugriff/fernzugriff">Open Live</a><Btn className="sm ghost" onClick={() => fixed(false)}>Turn off</Btn></>)
                : (<><span className="small muted grow">With your own domain (Go live → Access → Remote access) the inbox gets an address that never changes – nice for GitHub, Stripe &amp; Co.</span><Btn className="sm" icon={Link2} onClick={() => fixed(true)}>Fixed address</Btn></>)}
          </div>
          {s.settings.forward && <div className="small muted row-tight"><ArrowRight size={13} />Every call goes on to <code><Keep>{s.settings.forward}</Keep></code></div>}
          {s.settings.routes && s.settings.routes.length ? <div className="small muted row-tight" style={{ flexWrap: 'wrap' }}>Own paths: {s.settings.routes.map((r) => <code key={r.id}><Keep>{r.path}</Keep></code>)}</div> : null}
        </div>
      </div>
      {!s.items.length ? <Empty icon={Inbox} title="No calls yet" text={s.running ? `Send a webhook to ${local}/your-path – it shows up here at once.` : 'Start the receiver, then point the webhook of your service to the address above.'} /> : (
        <div className="whi-grid">
          <div className="card whi-list" aria-label="Calls" ref={listRef} onKeyDown={onListKey}>
            <div className="card-head"><h3>Calls</h3><span className="badge">{shown.length === s.items.length ? s.items.length : `${shown.length} / ${s.items.length}`}</span><div className="right"><Btn className="xs ghost" icon={Trash2} onClick={clear}>Clear</Btn></div></div>
            <div className="whi-filter row-tight">
              <Search size={13} className="muted" />
              <input className="input sm grow" value={q} placeholder="Search path or event …" aria-label="Search calls" onChange={(e) => setQ(e.target.value)} />
              {events.length ? <select className="select sm" value={ev} aria-label="Event" onChange={(e) => setEv(e.target.value)}><option value="">All events</option>{events.map((x) => <Raw as="option" key={x} value={x}>{x}</Raw>)}</select> : null}
            </div>
            {!shown.length ? <p className="small muted whi-none">No call matches the filter.</p> : null}
            {shown.map((it) => (
              <button type="button" key={it.id} data-id={it.id} className={`list-item whi-item ${it.id === sel ? 'active' : ''}`} aria-current={it.id === sel ? 'true' : undefined} tabIndex={it.id === focusId ? 0 : -1} onClick={() => setSel(it.id)}>
                <span className="badge">{it.method}</span>
                <span className="grow ellipsis small"><Keep>{it.event || it.path}</Keep></span>
                {it.answered ? <span className="badge err">{it.answered}</span> : null}
                {it.verified && (it.verified.ok ? <ShieldCheck size={13} className="c-ok" aria-label="Signature valid" /> : it.verified.ok === false ? <ShieldAlert size={13} className="c-err" aria-label="Signature invalid" /> : null)}
                <span className="tiny muted">{fmtTime(it.t)}</span>
              </button>
            ))}
          </div>
          <div className="card"><div className="card-body">{sel ? <Detail key={sel} id={sel} s={s} rev={rev} onRemove={() => removeOne(sel)} /> : null}</div></div>
        </div>
      )}
      {edit && <Settings s={s} onClose={() => setEdit(false)} onSaved={(d) => st.setData(d)} />}
    </div>
  );
}

export default {
  pages: { main: WebhookInboxPage },
  slots: {
    // Seit Hostwerk 3.0 (SDK 3.2) ohne eigenen Seitenleisten-Eintrag ("nav": false) – die ganze Seite als Reiter im passenden Bereich;
    // Hostwerk blendet dabei ihren Titel aus (Reiter + Herkunftszeile sagen schon, was es ist), die Knöpfe bleiben
    'projects.tabs': [{ id: 'webhooks', title: 'Webhooks', icon: Inbox, Component: WebhookInboxPage, order: 45 }],
  },
};

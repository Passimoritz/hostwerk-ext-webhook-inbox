import { useEffect, useMemo, useState } from 'react';
import { Inbox, Play, Square, Globe, Copy, Trash2, RotateCcw, ShieldCheck, ShieldAlert, Settings2, ArrowRight, Link2, RefreshCw, Zap } from 'lucide-react';
import { get, post, put, del, useApi, on } from '@hostwerk/api';
import { Btn, Tabs, Seg, Empty, Loading, Callout, InfoTip, Field, Modal, toast, confirmDialog } from '@hostwerk/ui';
import './style.css';

/*
 * Webhook inbox: receiver on/off and public address at the top, calls on the left, the selected call on the right.
 * Texts are English; German comes from locales/de.json (also inside JSX).
 */
const fmtTime = (t) => new Date(t).toLocaleTimeString();
const copy = async (text, what) => { try { await navigator.clipboard.writeText(text); toast.success(`${what} copied`); } catch { toast.error('Could not copy'); } };

function Settings({ s, onClose, onSaved }) {
  const [f, setF] = useState({ ...s.settings });
  const set = (k) => (e) => setF({ ...f, [k]: e && e.target ? e.target.value : e });
  const save = async () => { try { onSaved(await put('/webhook-inbox/settings', f)); toast.success('Saved'); onClose(); } catch (e) { toast.error(e); } };
  return (
    <Modal title="Inbox settings" onClose={onClose} footer={<><Btn onClick={onClose}>Cancel</Btn><Btn className="primary" onClick={save}>Save</Btn></>}>
      <div className="stack">
        <Field label="Port on this PC" hint="Only reachable from this PC – public only through “Make public”."><input className="input" inputMode="numeric" value={f.port} onChange={set('port')} /></Field>
        <Field label="Forward every call to" hint="e.g. http://localhost:8080/webhook – the sender then gets your project's answer. Empty = the answer below."><input className="input mono" value={f.forward} placeholder="http://localhost:8080/webhook" onChange={set('forward')} /></Field>
        <div className="grid grid-2">
          <Field label="Answer status"><input className="input" inputMode="numeric" value={f.status} onChange={set('status')} /></Field>
          <Field label="Answer type"><input className="input mono" value={f.contentType} onChange={set('contentType')} /></Field>
        </div>
        <Field label="Answer body"><textarea className="input mono" rows={3} value={f.body} onChange={set('body')} /></Field>
        <Field label="Signature check" hint="The secret from the sender's webhook settings. Stays on this PC.">
          <Seg options={[{ id: 'github', label: 'GitHub' }, { id: 'stripe', label: 'Stripe' }, { id: 'hmac', label: 'HMAC header' }]} value={f.kind} onChange={(kind) => setF({ ...f, kind })} />
        </Field>
        {f.kind === 'hmac' && <Field label="Header name"><input className="input mono" value={f.header} onChange={set('header')} /></Field>}
        <Field label="Secret"><input className="input mono" type="password" value={f.secret} placeholder="whsec_… / your GitHub secret" onChange={set('secret')} /></Field>
      </div>
    </Modal>
  );
}

function Detail({ id, s }) {
  const [it, setIt] = useState(null);
  const [tab, setTab] = useState('body');
  const [target, setTarget] = useState(s.settings.forward || '');
  const [busy, setBusy] = useState(false);
  const [replayed, setReplayed] = useState(null);
  useEffect(() => { setIt(null); setReplayed(null); get(`/webhook-inbox/items/${id}`).then(setIt).catch((e) => toast.error(e)); }, [id]);
  const pretty = useMemo(() => { if (!it || it.base64) return null; try { return JSON.stringify(JSON.parse(it.body), null, 2); } catch { return it.body; } }, [it]);
  if (!it) return <Loading />;
  // Synergie: im API-Tester öffnen (ändern, erneut senden, als Sammlung behalten)
  const toApiTester = async () => { try { const r = await post(`/webhook-inbox/items/${id}/to-api-tester`); location.hash = `/ext/api-tester?col=${encodeURIComponent(r.col)}&req=${encodeURIComponent(r.req)}`; } catch (e) { toast.error(e); } };
  const replay = async () => { setBusy(true); try { setReplayed(await post(`/webhook-inbox/items/${id}/replay`, { target })); } catch (e) { toast.error(e); } setBusy(false); };
  const v = it.verified;
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="row-tight" style={{ flexWrap: 'wrap' }}>
        <span className="badge accent">{it.method}</span><code className="grow ellipsis">{it.path}{it.query ? `?${it.query}` : ''}</code>
        <span className="small muted">{new Date(it.t).toLocaleString()} · {it.size} B{it.cut ? ' · cut at 1 MB' : ''}</span>
      </div>
      {v && <Callout kind={v.ok ? 'ok' : v.ok === false ? 'err' : 'info'}>{v.ok ? <ShieldCheck size={14} /> : <ShieldAlert size={14} />} {v.why}</Callout>}
      {it.forwarded && <Callout kind={it.forwarded.error || it.forwarded.status >= 400 ? 'err' : 'ok'}>Forwarded to {it.forwarded.url}: {it.forwarded.error || `${it.forwarded.status} in ${it.forwarded.ms} ms`}</Callout>}
      <Tabs tabs={[{ id: 'body', label: 'Body' }, { id: 'headers', label: `Headers (${Object.keys(it.headers).length})` }]} value={tab} onChange={setTab} />
      {tab === 'body' ? (it.base64 ? <div className="small muted">Binary content – not shown.</div> : <pre className="code-block whi-pre">{pretty || '(empty)'}</pre>)
        : <table className="table"><tbody>{Object.entries(it.headers).map(([k, x]) => <tr key={k}><td className="mono small">{k}</td><td className="mono small whi-break">{String(x)}</td></tr>)}</tbody></table>}
      <div className="card"><div className="card-body stack" style={{ gap: 8 }}>
        <div className="row-tight"><b className="small grow">Replay this call</b><InfoTip pop title="Replay">Sends exactly this call again – same method, headers and body – for example after you fixed your webhook code.</InfoTip></div>
        <div className="row-tight"><input className="input sm mono grow" value={target} aria-label="Target address" placeholder="http://localhost:8080/webhook" onChange={(e) => setTarget(e.target.value)} /><Btn className="sm primary" icon={RotateCcw} busy={busy} onClick={replay}>Replay</Btn></div>
        {s.apiTester && <div className="row-tight"><Btn className="sm" icon={Zap} onClick={toApiTester}>Open in API tester</Btn><span className="tiny muted">Change it there and send it again.</span></div>}
        {replayed && <div className={`small ${replayed.error || replayed.status >= 400 ? 'c-err' : 'c-ok'}`}>{replayed.error || `${replayed.status} in ${replayed.ms} ms`}{replayed.body ? <pre className="code-block whi-pre" style={{ marginTop: 6, maxHeight: 160 }}>{replayed.body}</pre> : null}</div>}
      </div></div>
    </div>
  );
}

function WebhookInboxPage() {
  const st = useApi('/webhook-inbox', [], { live: false });
  const [sel, setSel] = useState(null);
  const [edit, setEdit] = useState(false);
  const s = st.data;
  useEffect(() => on('webhook-inbox', () => st.reload({ silent: true })), [st.reload]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (s && !sel && s.items[0]) setSel(s.items[0].id); }, [s]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!s) return <Loading />;
  const act = async (p) => { try { st.setData(await post(`/webhook-inbox/${p}`)); } catch (e) { toast.error(e); } };
  const fixed = async (on, rotate = false) => { if (rotate && !(await confirmDialog({ title: 'New fixed address?', text: 'The old address stops working at once – update it at the sender (GitHub, Stripe …).', confirm: 'New address' }))) return; try { st.setData(await post('/webhook-inbox/fixed', { on, rotate })); } catch (e) { toast.error(e); } };
  const clear = async () => { if (await confirmDialog({ title: 'Delete all stored calls?', confirm: 'Delete', danger: true })) { st.setData(await del('/webhook-inbox/items')); setSel(null); } };
  const local = `http://localhost:${s.port}`;
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
        <div className="card-body stack" style={{ gap: 10 }}>
          <div className="row-tight whi-addr">
            <span className={`badge ${s.running ? 'ok' : ''}`}>{s.running ? 'Receiving' : 'Off'}</span>
            <span className="small muted">On this PC:</span><code>{local}/…</code><button type="button" className="btn ghost xs icon" title="Copy" aria-label="Copy" onClick={() => copy(local, 'Address')}><Copy size={12} /></button>
          </div>
          <div className="row-tight whi-addr">
            <Globe size={14} className="muted" />
            {s.public ? (<><span className="small muted">Public:</span><code className="ellipsis">{s.public}</code><button type="button" className="btn ghost xs icon" title="Copy" aria-label="Copy" onClick={() => copy(s.public, 'Address')}><Copy size={12} /></button><Btn className="sm ghost" onClick={() => act('unshare')}>Close public address</Btn></>)
              : (<><span className="small muted grow">Senders on the internet need a public address. Hostwerk opens one through its tunnel – it stays only while it runs, and emergency mode closes it.</span><Btn className="sm" icon={Globe} disabled={!s.tunnelReady} title={s.tunnelReady ? '' : 'Set up the tunnel under Live → Share first'} onClick={() => act('share')}>Make public</Btn></>)}
          </div>
          {/* Feste Adresse über die eigene Domain (Fernzugriff im Livebetrieb) – bleibt gleich, anders als die Tunnel-Adresse */}
          <div className="row-tight whi-addr">
            <Link2 size={14} className="muted" />
            {s.fixed && s.fixed.url ? (<><span className="small muted">Fixed:</span><code className="ellipsis">{`${s.fixed.url}/…`}</code><button type="button" className="btn ghost xs icon" title="Copy" aria-label="Copy" onClick={() => copy(s.fixed.url, 'Address')}><Copy size={12} /></button><Btn className="sm ghost" icon={RefreshCw} onClick={() => fixed(true, true)}>New address</Btn><Btn className="sm ghost" onClick={() => fixed(false)}>Turn off</Btn></>)
              : s.fixed && s.fixed.on ? (<><span className="small c-warn grow">The fixed address needs remote access with your own domain – set it up under Live → Domains &amp; HTTPS and Remote access.</span><a className="btn sm" href="#/live/fernzugriff">Open Live</a><Btn className="sm ghost" onClick={() => fixed(false)}>Turn off</Btn></>)
                : (<><span className="small muted grow">With your own domain (Live → Remote access) the inbox gets an address that never changes – nice for GitHub, Stripe &amp; Co.</span><Btn className="sm" icon={Link2} onClick={() => fixed(true)}>Fixed address</Btn></>)}
          </div>
          {s.settings.forward && <div className="small muted row-tight"><ArrowRight size={13} />Every call goes on to <code>{s.settings.forward}</code></div>}
        </div>
      </div>
      {!s.items.length ? <Empty icon={Inbox} title="No calls yet" text={s.running ? `Send a webhook to ${local}/your-path – it shows up here at once.` : 'Start the receiver, then point the webhook of your service to the address above.'} /> : (
        <div className="whi-grid">
          <div className="card whi-list" aria-label="Calls">
            <div className="card-head"><h3>Calls</h3><span className="badge">{s.items.length}</span><div className="right"><Btn className="xs ghost" icon={Trash2} onClick={clear}>Clear</Btn></div></div>
            {s.items.map((it) => (
              <button type="button" key={it.id} className={`list-item whi-item ${it.id === sel ? 'active' : ''}`} aria-current={it.id === sel ? 'true' : undefined} onClick={() => setSel(it.id)}>
                <span className="badge">{it.method}</span>
                <span className="grow ellipsis small">{it.event || it.path}</span>
                {it.verified && (it.verified.ok ? <ShieldCheck size={13} className="c-ok" aria-label="Signature valid" /> : it.verified.ok === false ? <ShieldAlert size={13} className="c-err" aria-label="Signature invalid" /> : null)}
                <span className="tiny muted">{fmtTime(it.t)}</span>
              </button>
            ))}
          </div>
          <div className="card"><div className="card-body">{sel ? <Detail key={sel} id={sel} s={s} /> : null}</div></div>
        </div>
      )}
      {edit && <Settings s={s} onClose={() => setEdit(false)} onSaved={(d) => st.setData(d)} />}
    </div>
  );
}

export default {
  pages: { main: WebhookInboxPage },
};

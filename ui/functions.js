/**
 * Functions: the edge functions (source, invoke, secrets) and the database's own functions
 * and triggers. One edge function selected on the right with its source in the code editor.
 */
import { ago, withConfirm } from './helpers.js';
import { Panel, Stat, Health, List, ListRow, FILL } from './kit.js';

export function Functions({ host, sb, project, overview, q, selected, onSelect, onSql }) {
  const { h, ui, notify, tokens } = host;
  const { useState, useEffect } = host.react;
  const [fns, setFns] = useState(null);
  const [secrets, setSecrets] = useState(null);
  const [dbFns, setDbFns] = useState(null);
  const [triggers, setTriggers] = useState(null);
  const [view, setView] = useState('edge');
  const [newSecret, setNewSecret] = useState(null);
  const [busy, setBusy] = useState(null);
  const load = () => {
    setFns(null); setSecrets(null); setDbFns(null); setTriggers(null);
    sb('/edge/functions').then((d) => setFns(Array.isArray(d) ? d : { error: (d && (d.error || d.message)) || 'Could not list' })).catch((e) => setFns({ error: e.message }));
    sb('/secrets').then((d) => setSecrets(Array.isArray(d) ? d : [])).catch(() => setSecrets([]));
    sb('/functions?schema=public').then((d) => setDbFns(Array.isArray(d) ? d : [])).catch(() => setDbFns([]));
    sb('/triggers?schema=public').then((d) => setTriggers(Array.isArray(d) ? d : [])).catch(() => setTriggers([]));
  };
  useEffect(load, [project]);
  const meta = (text) => h('span', { className: 'mpanel__meta' }, text);
  const empty = (text) => h('p', { className: 'mlead', style: { margin: 0 } }, text);
  const edge = Array.isArray(fns) ? fns.filter((f) => !q || `${f.slug} ${f.name}`.toLowerCase().includes(q)) : [];
  const db = (dbFns || []).filter((f) => !q || f.name.toLowerCase().includes(q));
  const trg = (triggers || []).filter((t) => !q || `${t.name} ${t.table}`.toLowerCase().includes(q));
  const addSecret = async () => { if (!newSecret || !newSecret.name.trim()) return; setBusy('secret'); try { const r = await sb('/secrets', { method: 'POST', body: JSON.stringify([{ name: newSecret.name.trim(), value: newSecret.value }]) }); if (r && r.message) throw new Error(r.message); notify(`Secret ${newSecret.name.trim()} set`, 'moss'); setNewSecret(null); load(); } catch (e) { notify(e.message, 'rosin'); } finally { setBusy(null); } };
  const removeSecret = async (name) => { setBusy(`del-${name}`); try { const r = await sb('/secrets', { method: 'DELETE', body: JSON.stringify([name]) }); if (r && r.message) throw new Error(r.message); notify(`Secret ${name} deleted`, 'moss'); load(); } catch (e) { notify(e.message, 'rosin'); } finally { setBusy(null); } };
  const codeRow = (label, sub, def) => h('div', { style: { padding: '8px 0', borderTop: `1px solid ${tokens('line')}` } }, h('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 4 } }, h('span', { style: { fontWeight: 600, fontSize: 'var(--sy-fs-sm)' } }, label), sub ? h('span', { className: 'mpanel__meta' }, sub) : null), def ? h('pre', { style: { margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'var(--sy-font-mono)', fontSize: 'var(--sy-fs-xs)', color: 'var(--sy-text-2)' } }, def) : null);
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--sy-s3)' } },
    h('div', { className: 'mstats mstats--head' },
      Stat(host, { label: 'Edge functions', value: Array.isArray(fns) ? fns.length : '...', tone: 'brass', hint: Array.isArray(fns) ? `${fns.filter((f) => f.status === 'ACTIVE').length} active` : undefined }),
      Stat(host, { label: 'Secrets', value: secrets ? secrets.length : '...', tone: 'muted', hint: 'values never shown' }),
      Stat(host, { label: 'Database functions', value: dbFns ? dbFns.length : '...', tone: 'muted', hint: 'in public' }),
      Stat(host, { label: 'Triggers', value: triggers ? triggers.length : '...', tone: 'muted', hint: 'in public' })),
    Panel(host, { title: view === 'edge' ? 'Edge functions' : view === 'secrets' ? 'Secrets' : view === 'db' ? 'Database functions' : 'Triggers', wide: true, action: h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } }, [['edge', 'Edge'], ['secrets', 'Secrets'], ['db', 'Database'], ['triggers', 'Triggers']].map(([k, l]) => h(ui.Chip, { key: k, on: view === k, onClick: () => setView(k) }, l)), view === 'secrets' ? h(ui.Button, { className: 'sy-btn--sm', onClick: () => setNewSecret(newSecret ? null : { name: '', value: '' }) }, newSecret ? 'Cancel' : 'New secret') : null) },
      view === 'edge' ? (fns === null ? h(ui.Skeleton, { count: 5, height: 18 }) : fns.error ? empty(fns.error) : edge.length ? List(host, edge.map((f) => ListRow(host, { key: f.slug, lead: h('span', { className: 'mind-dot', style: { background: f.status === 'ACTIVE' ? 'var(--sy-moss)' : 'var(--sy-text-3)' } }), label: f.name || f.slug, sub: `${f.slug} - v${f.version}${f.verify_jwt ? ' - JWT required' : ' - open'}${f.status !== 'ACTIVE' ? ` - ${f.status}` : ''}`, meta: f.updated_at ? ago(f.updated_at) : '', onClick: () => onSelect(f) }))) : empty(q ? 'Nothing matches.' : 'No edge function deployed. Deploy one from a shell with the Supabase CLI, or with the Deploy-EdgeFunction script.'))
        : view === 'secrets' ? h('div', null,
          newSecret ? h('div', { style: { display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' } }, h(ui.Input, { value: newSecret.name, placeholder: 'NAME', onChange: (e) => setNewSecret({ ...newSecret, name: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') }), style: { width: 220 } }), h(ui.Input, { type: 'password', value: newSecret.value, placeholder: 'value', onChange: (e) => setNewSecret({ ...newSecret, value: e.target.value }), style: { flex: 1, minWidth: 200 } }), h(ui.Button, { variant: 'primary', disabled: busy === 'secret' || !newSecret.name.trim(), onClick: addSecret }, busy === 'secret' ? 'Setting...' : 'Set')) : null,
          secrets === null ? h(ui.Skeleton, { count: 4, height: 18 }) : secrets.length ? List(host, secrets.map((s) => ListRow(host, { key: s.name, lead: h(host.icons.warning, { size: 13, style: { opacity: 0.5, flex: 'none' } }), label: s.name, sub: s.updated_at ? `updated ${ago(s.updated_at)}` : 'value hidden', meta: h('button', { type: 'button', className: 'sy-btn sy-btn--sm', disabled: !!busy, onClick: () => removeSecret(s.name) }, busy === `del-${s.name}` ? '...' : 'Delete') }))) : empty('No secret. Edge functions read them from the environment.'))
        : view === 'db' ? (dbFns === null ? h(ui.Skeleton, { count: 6, height: 18 }) : db.length ? h('div', { style: { maxHeight: 600, overflow: 'auto', paddingRight: 14, scrollbarGutter: 'stable' } }, List(host, db.map((f) => ListRow(host, { key: `${f.name}(${f.arguments})`, lead: h('span', { className: 'mind-dot', style: { background: f.returns === 'trigger' ? 'var(--sy-brass)' : 'var(--sy-text-3)', width: 7, height: 7 } }), label: `${f.name}(${f.arguments})`, sub: `${f.kind} - ${f.language} - returns ${f.returns}`, onClick: () => onSql(`select pg_get_functiondef('public.${f.name}(${f.arguments})'::regprocedure);`) })))) : empty('No function in public.'))
        : (triggers === null ? h(ui.Skeleton, { count: 6, height: 18 }) : trg.length ? h('div', { style: { maxHeight: 600, overflow: 'auto', paddingRight: 14, scrollbarGutter: 'stable' } }, trg.map((t) => codeRow(t.name, `${t.table}${t.enabled === 'D' ? ' - disabled' : ''}`, t.definition))) : empty('No trigger in public.'))));
}

export function FunctionsAside({ host, sb, project, current, selected, onChanged }) {
  const { h, ui, notify } = host;
  const { useState, useEffect } = host.react;
  const [body, setBody] = useState(null);
  const [input, setInput] = useState('{}');
  const [out, setOut] = useState(null);
  const [busy, setBusy] = useState(null);
  useEffect(() => { setBody(null); setOut(null); if (selected) sb(`/edge/functions/${encodeURIComponent(selected.slug)}/body`).then((d) => setBody(typeof d === 'string' ? d : d && d.message ? `// ${d.message}` : JSON.stringify(d, null, 2))).catch((e) => setBody(`// ${e.message}`)); }, [selected && selected.slug, project]);
  const meta = (text) => h('span', { className: 'mpanel__meta' }, text);
  if (!selected) return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--sy-s3)' } },
    Panel(host, { title: 'Edge functions' }, h('p', { className: 'mlead', style: { margin: 0 } }, 'Pick a function to read its source and call it with a JSON body. Deploying happens from a shell: supabase functions deploy <slug>, or the Deploy-EdgeFunction script with a file.')),
    current ? Panel(host, { title: 'In the dashboard' }, h('a', { className: 'sy-btn sy-btn--sm', href: `https://supabase.com/dashboard/project/${current.projectRef}/functions`, target: '_blank', rel: 'noreferrer' }, 'Functions')) : null);
  const invoke = async () => { let payload; try { payload = input.trim() ? JSON.parse(input) : {}; } catch (e) { notify(`Body: ${e.message}`, 'rosin'); return; } setBusy('invoke'); const started = Date.now(); try { const r = await sb(`/edge/invoke/${encodeURIComponent(selected.slug)}`, { method: 'POST', body: JSON.stringify(payload) }); setOut({ text: typeof r === 'string' ? r : JSON.stringify(r, null, 2), ms: Date.now() - started }); } catch (e) { setOut({ text: e.message, ms: Date.now() - started, error: true }); } finally { setBusy(null); } };
  const toggleJwt = async () => { setBusy('jwt'); try { const r = await sb(`/edge/functions/${encodeURIComponent(selected.slug)}`, { method: 'PATCH', body: JSON.stringify({ verify_jwt: !selected.verify_jwt }) }); if (r && r.message && !r.slug) throw new Error(r.message); notify(selected.verify_jwt ? 'Now open to anyone' : 'Now requires a JWT', 'moss'); onChanged(); } catch (e) { notify(e.message, 'rosin'); } finally { setBusy(null); } };
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--sy-s3)', flex: 1, minHeight: 0, height: '100%' } },
    Panel(host, { title: selected.name || selected.slug, action: meta(selected.status) },
      h(ui.InfoGrid, { items: [{ label: 'Slug', value: selected.slug }, { label: 'Version', value: selected.version }, { label: 'JWT', value: selected.verify_jwt ? 'required' : 'not required' }, { label: 'Updated', value: selected.updated_at ? new Date(selected.updated_at).toLocaleString() : '-' }, { label: 'URL', value: current ? `${current.url}/functions/v1/${selected.slug}` : '' }] }),
      h('div', { style: { display: 'flex', gap: 6, marginTop: 'var(--sy-s2)', flexWrap: 'wrap' } }, h(ui.Button, { className: 'sy-btn--sm', disabled: !!busy, onClick: toggleJwt }, busy === 'jwt' ? '...' : selected.verify_jwt ? 'Make it open' : 'Require a JWT'), current ? h('a', { className: 'sy-btn sy-btn--sm', href: `https://supabase.com/dashboard/project/${current.projectRef}/functions/${selected.slug}`, target: '_blank', rel: 'noreferrer' }, 'In the dashboard') : null)),
    Panel(host, { title: 'Invoke', action: meta('with the service role') },
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } }, h(ui.CodeEditor, { value: input, language: 'json', height: 100, onChange: setInput }), h('div', null, h(ui.Button, { className: 'sy-btn--sm', variant: 'primary', disabled: busy === 'invoke', onClick: invoke }, busy === 'invoke' ? 'Calling...' : 'Call it')), out ? h('div', null, h('div', { className: 'mpanel__meta', style: { margin: '4px 0', color: out.error ? 'var(--sy-rosin)' : undefined } }, `${out.error ? 'failed' : 'answered'} in ${out.ms} ms`), h(ui.CodeEditor, { value: out.text, language: 'json', height: 140, readOnly: true })) : null)),
    Panel(host, { title: 'Source', ...FILL, action: meta(body === null ? 'reading...' : `${body.split('\n').length} lines`) }, body === null ? h(ui.Skeleton, { count: 6, height: 14 }) : h(ui.CodeEditor, { value: body, language: 'typescript', height: 'max(200px, calc(100vh - 640px))', readOnly: true })));
}

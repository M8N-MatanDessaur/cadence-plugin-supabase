/**
 * SQL: a console on the database. Monaco for the query, the result as a table or JSON, a
 * history of what you ran, a shelf of useful queries, and a confirm dialog before anything
 * destructive. Read-only mode runs in a read-only transaction.
 */
import { withConfirm, cell } from './helpers.js';
import { Panel, Stat, Health, List, ListRow, FILL } from './kit.js';

const HISTORY_KEY = 'sy.sb.sql.history';
const readHistory = () => { try { const v = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
const writeHistory = (list) => { try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 30))); } catch {} };
const when = (at) => new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export const SHELF = [
  { label: 'Tables and their sizes', q: "select relname as table, pg_size_pretty(pg_total_relation_size(relid)) as size, n_live_tup as rows\nfrom pg_stat_user_tables\norder by pg_total_relation_size(relid) desc;" },
  { label: 'Tables without RLS in public', q: "select c.relname\nfrom pg_class c join pg_namespace n on n.oid = c.relnamespace\nwhere n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;" },
  { label: 'Every policy', q: "select tablename, policyname, cmd, roles, qual, with_check\nfrom pg_policies where schemaname = 'public'\norder by tablename, policyname;" },
  { label: 'Users by provider', q: "select raw_app_meta_data->>'provider' as provider, count(*)\nfrom auth.users group by 1 order by 2 desc;" },
  { label: 'Signups per day, 30 days', q: "select date_trunc('day', created_at)::date as day, count(*)\nfrom auth.users where created_at > now() - interval '30 days'\ngroup by 1 order by 1;" },
  { label: 'Storage per bucket', q: "select bucket_id, count(*) as files, pg_size_pretty(sum((metadata->>'size')::bigint)) as size\nfrom storage.objects group by 1 order by 3 desc;" },
  { label: 'Running queries', q: "select pid, now() - query_start as running_for, state, left(query, 120) as query\nfrom pg_stat_activity where state <> 'idle' and pid <> pg_backend_pid()\norder by query_start;" },
  { label: 'Installed extensions', q: 'select extname, extversion from pg_extension order by 1;' },
];

export function Sql({ host, sb, project, seed, onOpenTable }) {
  const { h, ui, notify, tokens } = host;
  const { useState, useEffect } = host.react;
  const [query, setQuery] = useState(() => (seed && seed.query) || SHELF[0].q);
  const [readOnly, setReadOnly] = useState(true);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [asJson, setAsJson] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [history, setHistory] = useState(readHistory);
  useEffect(() => { if (seed && seed.query) { setQuery(seed.query); setReadOnly(/^\s*(select|with|explain|show)\b/i.test(seed.query)); run(seed.query); } }, [seed && seed.at]);
  const meta = (text) => h('span', { className: 'mpanel__meta' }, text);
  const run = async (q, force) => {
    const text = (q !== undefined ? q : query).trim();
    if (!text || busy) return;
    setBusy(true); setResult(null); setConfirm(null);
    const started = Date.now();
    try {
      const r = await withConfirm(
        (extra) => sb(`/sql?soft=1${extra ? `&${extra}` : ''}`, { method: 'POST', body: JSON.stringify({ query: text, readOnly, force: !!force }) }),
        (detail) => new Promise((resolve) => setConfirm({ detail, resolve })),
      );
      if (r === null) { setResult({ declined: true, took: Date.now() - started }); return; }
      if (r && r.message && !Array.isArray(r)) throw new Error(r.message);
      const rows = Array.isArray(r) ? r : r && typeof r === 'object' ? [r] : [];
      setResult({ rows, took: Date.now() - started });
      const entry = { query: text, at: new Date().toISOString(), ms: Date.now() - started, count: rows.length, readOnly };
      const next = [entry, ...history.filter((e) => e.query !== text)]; writeHistory(next); setHistory(next);
    } catch (e) { setResult({ error: e.message, took: Date.now() - started }); } finally { setBusy(false); }
  };
  const rows = result && result.rows ? result.rows : [];
  const cols = rows.length ? [...new Set(rows.flatMap((r) => Object.keys(r)))] : [];
  const text = rows.length ? JSON.stringify(rows, null, 2) : '';
  const csv = () => { const esc = (v) => { const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }; return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n'); };
  const column = (...children) => h('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--sy-s3)', minWidth: 0, minHeight: 0 } }, ...children);
  return h('div', { className: 'sb-ask', style: { alignItems: 'start' } },
    column(
      Panel(host, { title: 'Query', action: h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
        h(ui.Chip, { on: readOnly, onClick: () => setReadOnly(!readOnly), title: 'A read-only transaction: nothing can be written' }, readOnly ? 'read only' : 'read and write'),
        h(ui.Button, { className: 'sy-btn--sm', variant: 'primary', disabled: busy || !query.trim(), onClick: () => run() }, busy ? 'Running...' : 'Run (Ctrl+Enter)')) },
        h('div', { onKeyDown: (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run(); } } }, h(ui.CodeEditor, { value: query, language: 'sql', height: 190, onChange: setQuery }))),
      confirm ? Panel(host, { title: 'This statement destroys data', action: meta('confirm to run it') },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          h('p', { className: 'mlead', style: { margin: 0, color: 'var(--sy-rosin)' } }, `${confirm.detail.destructive.map((d) => d.kind.replace(/_/g, ' ').toLowerCase()).join(', ')} in ${confirm.detail.statements} statement${confirm.detail.statements === 1 ? '' : 's'}. There is no undo beyond a backup.`),
          h('pre', { style: { margin: 0, maxHeight: 140, overflow: 'auto', fontSize: 'var(--sy-fs-xs)', fontFamily: 'var(--sy-font-mono)', color: 'var(--sy-text-2)', whiteSpace: 'pre-wrap' } }, confirm.detail.destructive.map((d) => d.statement).join(';\n')),
          h('div', { style: { display: 'flex', gap: 8 } }, h(ui.Button, { onClick: () => { confirm.resolve(false); setConfirm(null); } }, 'Cancel'), h('span', { style: { flex: 1 } }), h(ui.Button, { variant: 'primary', style: { color: 'var(--sy-rosin)' }, onClick: () => { confirm.resolve(true); setConfirm(null); } }, 'Yes, run it')))) : null,
      Panel(host, { title: 'Result', action: h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
        result && result.rows ? meta(`${rows.length} row${rows.length === 1 ? '' : 's'} - ${result.took} ms`) : meta(busy ? 'running...' : ''),
        rows.length ? h(ui.Chip, { on: asJson, onClick: () => setAsJson(!asJson) }, asJson ? 'JSON' : 'table') : null,
        rows.length ? h(ui.Button, { className: 'sy-btn--sm', onClick: () => navigator.clipboard.writeText(asJson ? text : csv()).then(() => notify(asJson ? 'JSON copied' : 'CSV copied', 'moss')).catch(() => {}) }, asJson ? 'Copy JSON' : 'Copy CSV') : null) },
        busy ? h(ui.Skeleton, { count: 6, height: 16 }) : !result ? h('p', { className: 'mlead', style: { margin: 0 } }, 'Run a query. Rows come back as a table; switch to JSON for the raw shape. A statement that drops or truncates asks first.')
          : result.declined ? h('p', { className: 'mlead', style: { margin: 0 } }, 'Not run.')
          : result.error ? h('p', { className: 'mlead', style: { margin: 0, color: 'var(--sy-rosin)', whiteSpace: 'pre-wrap' } }, result.error)
          : !rows.length ? h('p', { className: 'mlead', style: { margin: 0 } }, 'Done. No rows came back.')
          : asJson ? h(ui.CodeEditor, { value: text.length > 400000 ? text.slice(0, 400000) + '\n// truncated' : text, language: 'json', height: 'max(220px, calc(100vh - 640px))', readOnly: true })
          : h('div', { style: { maxHeight: 'max(220px, calc(100vh - 640px))', overflow: 'auto', paddingRight: 14, scrollbarGutter: 'stable' } }, h('table', { className: 'sb-table sb-table--rows' }, h('thead', null, h('tr', null, cols.map((c) => h('th', { key: c }, c)))), h('tbody', null, rows.slice(0, 500).map((r, i) => h('tr', { key: i }, cols.map((c) => h('td', { key: c, title: r[c] === null ? 'null' : typeof r[c] === 'object' ? JSON.stringify(r[c]) : String(r[c]), style: { color: r[c] === null ? 'var(--sy-text-3)' : undefined } }, r[c] === null ? 'null' : cell(r[c], 80)))))))))),
    column(
      Panel(host, { title: 'Useful queries', action: meta('click to load') }, List(host, SHELF.map((s) => ListRow(host, { key: s.label, label: s.label, onClick: () => { setQuery(s.q); setReadOnly(true); } })))),
      Panel(host, { title: 'History', bodyStyle: { maxHeight: 'max(120px, calc(100vh - 700px))', overflow: 'auto', paddingRight: 14, scrollbarGutter: 'stable' }, action: history.length ? h('button', { type: 'button', className: 'mpanel__meta', style: { background: 'none', border: 0, cursor: 'pointer', padding: 0 }, onClick: () => { writeHistory([]); setHistory([]); } }, 'forget all') : meta('kept in the app') },
        history.length ? List(host, history.map((e) => ListRow(host, { key: e.at, lead: h('span', { className: 'mind-dot', style: { background: e.readOnly ? 'var(--sy-text-3)' : 'var(--sy-brass)', width: 7, height: 7 } }), label: e.query.split('\n')[0].slice(0, 70), sub: `${when(e.at)} - ${e.ms} ms - ${e.count} row${e.count === 1 ? '' : 's'}`, onClick: () => { setQuery(e.query); setReadOnly(!!e.readOnly); } }))) : h('p', { className: 'mlead', style: { margin: 0 } }, 'Nothing run yet.'))));
}

export function SqlAside({ host, overview, onRun }) {
  const { h, ui } = host;
  const d = overview.data;
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--sy-s3)' } },
    Panel(host, { title: 'How it runs' }, h('p', { className: 'mlead', style: { margin: 0 } }, 'Queries go through the management API with the personal access token, as the postgres role: every schema is visible, RLS does not apply. Read only wraps the statement in a read-only transaction. Anything that drops, truncates or deletes without a WHERE asks before it runs, and the Governor may ask too.')),
    d && d.tables.length ? Panel(host, { title: 'Tables', bodyStyle: { maxHeight: 360, overflow: 'auto', paddingRight: 14, scrollbarGutter: 'stable' } }, h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } }, d.tables.map((t) => h('code', { key: t.name, className: 'mpanel__meta', style: { cursor: 'pointer' }, title: 'Select from it', onClick: () => onRun(`select * from "${t.name}" limit 100;`) }, t.name)))) : null);
}

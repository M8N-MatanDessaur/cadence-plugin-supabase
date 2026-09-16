/**
 * Database: the schemas and tables, and one table as a dashboard - columns, rows you can
 * edit, policies, indexes, triggers, constraints - with RLS switched from the right pane.
 */
import { ago, bytes, num, withConfirm } from './helpers.js';
import { Panel, Stat, Health, List, ListRow, FILL } from './kit.js';
import { tableRow } from './overview.js';
import { Rows } from './rows.js';

const SYSTEM_SCHEMAS = new Set(['auth', 'storage', 'realtime', 'vault', 'extensions', 'graphql', 'graphql_public', 'pgsodium', 'pgsodium_masks', 'supabase_functions', 'supabase_migrations', 'net', 'cron', 'pgbouncer', 'pg_toast', 'information_schema']);

export function useTable(host, sb, open) {
  const { react } = host;
  const { useState, useEffect, useCallback } = react;
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const reload = useCallback(() => {
    if (!open) return;
    setError(null);
    sb(`/table?schema=${encodeURIComponent(open.schema)}&name=${encodeURIComponent(open.name)}`).then((d) => { if (!d || d.error) throw new Error((d && d.error) || 'Table not found'); setData(d); }).catch((e) => setError(e.message));
  }, [sb, open && open.schema, open && open.name]);
  useEffect(() => { setData(null); reload(); }, [reload]);
  return { data, error, reload };
}

export function Tables({ host, sb, project, overview, schema, setSchema, q, onOpen }) {
  const { h, ui } = host;
  const { useState, useEffect } = host.react;
  const [data, setData] = useState(null);
  useEffect(() => { setData(null); sb(`/tables?schema=${encodeURIComponent(schema)}`).then((d) => setData(Array.isArray(d) ? d : { error: (d && (d.error || d.message)) || 'Could not read the tables' })).catch((e) => setData({ error: e.message })); }, [schema, project]);
  const meta = (text) => h('span', { className: 'mpanel__meta' }, text);
  const empty = (text) => h('p', { className: 'mlead', style: { margin: 0 } }, text);
  const list = Array.isArray(data) ? data.filter((t) => !q || t.name.toLowerCase().includes(q)) : [];
  const tables = list.filter((t) => t.kind === 'table' || t.kind === 'partitioned_table' || t.kind === 'foreign_table');
  const views = list.filter((t) => t.kind === 'view' || t.kind === 'materialized_view');
  const noRls = tables.filter((t) => t.rls_enabled === false);
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--sy-s3)' } },
    h('div', { className: 'mstats mstats--head' },
      Stat(host, { label: 'Tables', value: !data ? '...' : tables.length, tone: 'brass', hint: `in ${schema}` }),
      Stat(host, { label: 'Views', value: !data ? '...' : views.length, tone: 'muted' }),
      Stat(host, { label: 'Without RLS', value: !data ? '...' : noRls.length, tone: noRls.length ? 'rosin' : 'moss', hint: schema === 'public' ? 'reachable by anyone with the anon key' : undefined }),
      Stat(host, { label: 'Size', value: !data ? '...' : bytes(list.reduce((n, t) => n + Number(t.size_bytes || 0), 0)), tone: 'muted', hint: 'tables and indexes' })),
    Panel(host, { title: `Tables in ${schema}`, wide: true, action: meta(data ? `${tables.length}` : '') },
      !data ? h(ui.Skeleton, { count: 8, height: 18 }) : data.error ? empty(data.error) : tables.length ? h('div', { style: { maxHeight: 560, overflow: 'auto', paddingRight: 14, scrollbarGutter: 'stable' } }, List(host, tables.map((t) => tableRow(host, t, onOpen)))) : empty(q ? 'Nothing matches.' : 'No table in this schema.')),
    views.length ? Panel(host, { title: 'Views', wide: true, action: meta(`${views.length}`) }, List(host, views.map((t) => tableRow(host, t, onOpen)))) : null);
}

export function DatabaseAside({ host, sb, project, overview, schema, setSchema, onOpenTable }) {
  const { h, ui } = host;
  const { useState, useEffect } = host.react;
  const [schemas, setSchemas] = useState(null);
  useEffect(() => { setSchemas(null); sb('/schemas').then((d) => setSchemas(Array.isArray(d) ? d.map((x) => x.name) : [])).catch(() => setSchemas([])); }, [project]);
  const meta = (text) => h('span', { className: 'mpanel__meta' }, text);
  const c = overview.data ? overview.data.counts : null;
  const user = (schemas || []).filter((s) => !SYSTEM_SCHEMAS.has(s));
  const system = (schemas || []).filter((s) => SYSTEM_SCHEMAS.has(s));
  const row = (s) => ListRow(host, { key: s, lead: h('span', { className: 'mind-dot', style: { background: s === schema ? 'var(--sy-brass)' : 'var(--sy-text-3)' } }), label: s, onClick: () => setSchema(s) });
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--sy-s3)', flex: 1, minHeight: 0, height: '100%' } },
    Panel(host, { title: 'Schemas', ...FILL, action: meta(schemas ? `${schemas.length}` : '...') },
      !schemas ? h(ui.Skeleton, { count: 4, height: 16 }) : h('div', null, List(host, user.map(row)), system.length ? h('div', { className: 'mpanel__meta', style: { margin: '10px 0 4px' } }, 'Supabase\'s own') : null, List(host, system.map(row)))),
    c ? Panel(host, { title: 'In public' }, h(ui.InfoGrid, { items: [{ label: 'Tables', value: c.public_tables }, { label: 'Policies', value: c.public_policies }, { label: 'Functions', value: c.public_functions }, { label: 'Triggers', value: c.triggers }, { label: 'Extensions', value: c.extensions }, { label: 'Without RLS', value: c.tables_without_rls }] })) : null);
}

export function TablePage({ host, sb, project, current, open, table, onChanged, onOpenTable, onSql }) {
  const { h, ui, tokens } = host;
  const { useState, useEffect } = host.react;
  const { data, error } = table;
  const [view, setView] = useState('rows');
  useEffect(() => { setView('rows'); }, [open.schema, open.name]);
  const meta = (text) => h('span', { className: 'mpanel__meta' }, text);
  const empty = (text) => h('p', { className: 'mlead', style: { margin: 0 } }, text);
  if (error) return h(ui.EmptyState, { title: 'Could not open the table', body: error });
  if (!data) return h('div', null, h('div', { className: 'mstats mstats--head' }, [0, 1, 2, 3].map((k) => h('div', { key: k, className: 'mstat' }, h(ui.Skeleton, { count: 2, height: 14 })))), h('div', { style: { marginTop: 'var(--sy-s3)' } }, h(ui.Skeleton, { count: 10, height: 18 })));
  const t = data.table;
  const pk = data.columns.filter((c) => c.is_primary_key).map((c) => c.name);
  const fks = data.columns.filter((c) => c.references);
  const tabs = [['rows', 'Rows'], ['columns', `Columns ${data.columns.length}`], ['policies', `Policies ${data.policies.length}`], ['indexes', `Indexes ${data.indexes.length}`], ['triggers', `Triggers ${data.triggers.length}`], ['constraints', `Constraints ${data.constraints.length}`]];
  const codeRow = (label, sub, def) => h('div', { style: { padding: '8px 0', borderTop: `1px solid ${tokens('line')}` } }, h('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 4 } }, h('span', { style: { fontWeight: 600, fontSize: 'var(--sy-fs-sm)' } }, label), sub ? h('span', { className: 'mpanel__meta' }, sub) : null), def ? h('pre', { style: { margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'var(--sy-font-mono)', fontSize: 'var(--sy-fs-xs)', color: 'var(--sy-text-2)' } }, def) : null);
  const body = view === 'rows' ? h(Rows, { host, sb, project, schema: open.schema, table: open.name, columns: data.columns, pk, onChanged })
    : view === 'columns' ? h('div', { style: { overflow: 'auto', paddingRight: 14, scrollbarGutter: 'stable', flex: 1, minHeight: 0 } }, h('table', { className: 'sb-table' }, h('thead', null, h('tr', null, ['Column', 'Type', 'Null', 'Default', 'Key', 'Comment'].map((x) => h('th', { key: x }, x)))), h('tbody', null, data.columns.map((c) => h('tr', { key: c.name }, h('td', { style: { fontWeight: 600 } }, c.name), h('td', { style: { fontFamily: 'var(--sy-font-mono)', fontSize: 'var(--sy-fs-xs)' } }, c.type), h('td', null, c.not_null ? 'not null' : 'nullable'), h('td', { style: { fontFamily: 'var(--sy-font-mono)', fontSize: 'var(--sy-fs-xs)', color: 'var(--sy-text-3)' } }, c.default_value || ''), h('td', null, c.is_primary_key ? h(ui.Badge, { tone: 'brass' }, 'primary') : c.references ? h('button', { type: 'button', className: 'mpanel__meta', style: { background: 'none', border: 0, cursor: 'pointer', padding: 0 }, onClick: () => onOpenTable(c.references.schema, c.references.table) }, `-> ${c.references.table}.${c.references.column}`) : c.identity ? 'identity' : c.generated ? 'generated' : ''), h('td', { style: { color: 'var(--sy-text-3)' } }, c.comment || ''))))))
    : view === 'policies' ? (data.policies.length ? h('div', { style: { overflow: 'auto', paddingRight: 14, scrollbarGutter: 'stable', flex: 1, minHeight: 0 } }, data.policies.map((p) => codeRow(p.name, `${p.command} - ${p.permissive.toLowerCase()} - ${String(p.roles || '').replace(/[{}]/g, '')}`, `${p.using_expression ? `USING ${p.using_expression}` : ''}${p.using_expression && p.check_expression ? '\n' : ''}${p.check_expression ? `WITH CHECK ${p.check_expression}` : ''}`))) : empty(t.rls_enabled ? 'RLS is on and no policy exists: nobody but the service role can read or write this table.' : 'RLS is off: every row is reachable with the anon key. Turn it on from the right, then add policies.'))
    : view === 'indexes' ? (data.indexes.length ? h('div', { style: { overflow: 'auto', paddingRight: 14, scrollbarGutter: 'stable', flex: 1, minHeight: 0 } }, data.indexes.map((i) => codeRow(i.name, `${num(i.scans)} scan${Number(i.scans) === 1 ? '' : 's'} - ${bytes(i.bytes)}`, i.definition))) : empty('No index.'))
    : view === 'triggers' ? (data.triggers.length ? h('div', { style: { overflow: 'auto', paddingRight: 14, scrollbarGutter: 'stable', flex: 1, minHeight: 0 } }, data.triggers.map((x) => codeRow(x.name, x.enabled ? 'enabled' : 'disabled', x.definition))) : empty('No trigger.'))
    : (data.constraints.length ? h('div', { style: { overflow: 'auto', paddingRight: 14, scrollbarGutter: 'stable', flex: 1, minHeight: 0 } }, data.constraints.map((x) => codeRow(x.name, { p: 'primary key', f: 'foreign key', u: 'unique', c: 'check', x: 'exclusion', t: 'trigger' }[x.type] || x.type, x.definition))) : empty('No constraint.'));
  return h('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 'var(--sy-s3)' } },
    h('div', { className: 'mstats mstats--head' },
      Stat(host, { label: 'Rows', value: Number(t.approx_rows) < 0 ? '?' : num(t.approx_rows), tone: 'brass', hint: 'estimate from the planner' }),
      Stat(host, { label: 'Size', value: bytes(t.size_bytes), tone: 'muted', hint: `${bytes(t.table_bytes)} data, ${bytes(t.index_bytes)} indexes` }),
      Stat(host, { label: 'Row level security', value: t.rls_enabled ? 'on' : 'off', tone: t.rls_enabled ? 'moss' : 'rosin', hint: t.rls_enabled ? `${data.policies.length} polic${data.policies.length === 1 ? 'y' : 'ies'}` : 'anyone with the anon key can read it' }),
      Stat(host, { label: 'Primary key', value: pk.length ? pk.join(', ') : 'none', tone: pk.length ? 'muted' : 'brass', hint: fks.length ? `${fks.length} foreign key${fks.length === 1 ? '' : 's'}` : undefined })),
    Panel(host, { title: t.name, ...FILL, action: h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } }, tabs.map(([k, l]) => h(ui.Chip, { key: k, on: view === k, onClick: () => setView(k) }, l))) }, body));
}

export function TableAside({ host, sb, project, current, open, table, onOpenTable, onSql, onChanged }) {
  const { h, ui, notify } = host;
  const { useState } = host.react;
  const { data } = table;
  const [busy, setBusy] = useState(null);
  const [policy, setPolicy] = useState(null);
  const meta = (text) => h('span', { className: 'mpanel__meta' }, text);
  const qn = `${open.schema === 'public' ? '' : `"${open.schema}".`}"${open.name}"`;
  const rls = async (on) => { setBusy('rls'); try { const r = await sb(`/rls/${on ? 'enable' : 'disable'}/${encodeURIComponent(open.schema)}/${encodeURIComponent(open.name)}`, { method: 'POST', body: '{}' }); if (r && r.message) throw new Error(r.message); notify(on ? 'Row level security is on' : 'Row level security is off', 'moss'); onChanged(); } catch (e) { notify(e.message, 'rosin'); } finally { setBusy(null); } };
  const addPolicy = async () => { if (!policy || !policy.name.trim()) return; setBusy('policy'); try { const r = await sb('/policies', { method: 'POST', body: JSON.stringify({ schema: open.schema, table: open.name, name: policy.name.trim(), command: policy.command, roles: policy.roles.split(',').map((x) => x.trim()).filter(Boolean), using: policy.using.trim() || undefined, check: policy.check.trim() || undefined }) }); if (r && r.message) throw new Error(r.message); notify(`Policy ${policy.name.trim()} created`, 'moss'); setPolicy(null); onChanged(); } catch (e) { notify(e.message, 'rosin'); } finally { setBusy(null); } };
  const dropPolicy = async (name) => { setBusy(`drop-${name}`); try { const r = await sb(`/policies/${encodeURIComponent(open.schema)}/${encodeURIComponent(open.name)}/${encodeURIComponent(name)}`, { method: 'DELETE' }); if (r && r.message) throw new Error(r.message); notify(`Dropped ${name}`, 'moss'); onChanged(); } catch (e) { notify(e.message, 'rosin'); } finally { setBusy(null); } };
  const templates = [
    { label: 'Read for everyone', p: { name: `${open.name}_read_all`, command: 'SELECT', roles: 'anon,authenticated', using: 'true', check: '' } },
    { label: 'Owner only (created_by)', p: { name: `${open.name}_owner`, command: 'ALL', roles: 'authenticated', using: 'auth.uid() = created_by', check: 'auth.uid() = created_by' } },
    { label: 'Owner only (user_id)', p: { name: `${open.name}_owner`, command: 'ALL', roles: 'authenticated', using: 'auth.uid() = user_id', check: 'auth.uid() = user_id' } },
    { label: 'Signed-in users insert', p: { name: `${open.name}_authed_insert`, command: 'INSERT', roles: 'authenticated', using: '', check: 'true' } },
  ];
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--sy-s3)', flex: 1, minHeight: 0, height: '100%' } },
    Panel(host, { title: 'Security', action: meta(data ? data.table.rls_enabled ? 'RLS on' : 'RLS off' : '...') },
      !data ? h(ui.Skeleton, { count: 3, height: 14 }) : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        h('p', { className: 'mlead', style: { margin: 0 } }, data.table.rls_enabled ? `${data.policies.length} polic${data.policies.length === 1 ? 'y' : 'ies'} decide who reads and writes.` : 'Off: every row is reachable with the public anon key.'),
        h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
          data.table.rls_enabled ? h(ui.Button, { className: 'sy-btn--sm', disabled: !!busy, onClick: () => rls(false) }, busy === 'rls' ? '...' : 'Turn RLS off') : h(ui.Button, { className: 'sy-btn--sm', variant: 'primary', disabled: !!busy, onClick: () => rls(true) }, busy === 'rls' ? '...' : 'Turn RLS on'),
          h(ui.Button, { className: 'sy-btn--sm', onClick: () => setPolicy(policy ? null : { name: `${open.name}_policy`, command: 'SELECT', roles: 'authenticated', using: 'true', check: '' }) }, policy ? 'Cancel' : 'New policy')),
        policy ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 6 } },
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4 } }, templates.map((t) => h(ui.Chip, { key: t.label, onClick: () => setPolicy({ ...t.p }) }, t.label))),
          h(ui.Input, { value: policy.name, placeholder: 'policy name', onChange: (e) => setPolicy({ ...policy, name: e.target.value }) }),
          h('div', { style: { display: 'flex', gap: 6 } }, h(ui.Select, { value: policy.command, onChange: (e) => setPolicy({ ...policy, command: e.target.value }), style: { width: 110 } }, ['ALL', 'SELECT', 'INSERT', 'UPDATE', 'DELETE'].map((c) => h('option', { key: c, value: c }, c))), h(ui.Input, { value: policy.roles, placeholder: 'roles, comma separated', onChange: (e) => setPolicy({ ...policy, roles: e.target.value }), style: { flex: 1 } })),
          policy.command !== 'INSERT' ? h(ui.Input, { value: policy.using, placeholder: 'USING expression, e.g. auth.uid() = user_id', onChange: (e) => setPolicy({ ...policy, using: e.target.value }), style: { fontFamily: 'var(--sy-font-mono)' } }) : null,
          policy.command !== 'SELECT' && policy.command !== 'DELETE' ? h(ui.Input, { value: policy.check, placeholder: 'WITH CHECK expression', onChange: (e) => setPolicy({ ...policy, check: e.target.value }), style: { fontFamily: 'var(--sy-font-mono)' } }) : null,
          h('div', null, h(ui.Button, { className: 'sy-btn--sm', variant: 'primary', disabled: busy === 'policy' || !policy.name.trim(), onClick: addPolicy }, busy === 'policy' ? 'Creating...' : 'Create the policy'))) : null,
        data.policies.length ? h('div', { style: { maxHeight: 200, overflow: 'auto', paddingRight: 14, scrollbarGutter: 'stable' } }, List(host, data.policies.map((p) => ListRow(host, { key: p.name, lead: h('span', { className: 'mind-dot', style: { background: 'var(--sy-moss)', width: 7, height: 7 } }), label: p.name, sub: `${p.command} - ${String(p.roles || '').replace(/[{}]/g, '')}`, meta: h('button', { type: 'button', className: 'sy-btn sy-btn--sm', disabled: !!busy, onClick: () => dropPolicy(p.name) }, busy === `drop-${p.name}` ? '...' : 'Drop') })))) : null)),
    data && data.referenced_by.length ? Panel(host, { title: 'Referenced by', bodyStyle: { maxHeight: 200, overflow: 'auto', paddingRight: 14, scrollbarGutter: 'stable' }, action: meta(`${data.referenced_by.length}`) }, List(host, data.referenced_by.map((r) => ListRow(host, { key: r.constraint, lead: h('span', { className: 'mind-dot', style: { background: 'var(--sy-text-3)', width: 7, height: 7 } }), label: `${r.schema === 'public' ? '' : `${r.schema}.`}${r.table}`, sub: r.constraint, onClick: () => onOpenTable(r.schema, r.table) })))) : null,
    data && data.stats ? Panel(host, { title: 'Activity' }, h(ui.InfoGrid, { items: [{ label: 'Live rows', value: num(data.stats.live_rows) }, { label: 'Dead rows', value: num(data.stats.dead_rows) }, { label: 'Index scans', value: num(data.stats.idx_scan) }, { label: 'Seq scans', value: num(data.stats.seq_scan) }, { label: 'Writes', value: `${num(data.stats.inserts)} / ${num(data.stats.updates)} / ${num(data.stats.deletes)}` }, { label: 'Autovacuum', value: data.stats.last_autovacuum ? ago(data.stats.last_autovacuum) : 'never' }] })) : null,
    Panel(host, { title: 'Query it' }, h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
      h(ui.Button, { className: 'sy-btn--sm', onClick: () => onSql(`select *\nfrom ${qn}\norder by 1\nlimit 100;`) }, 'Select'),
      h(ui.Button, { className: 'sy-btn--sm', onClick: () => onSql(`select count(*) from ${qn};`) }, 'Count'),
      h(ui.Button, { className: 'sy-btn--sm', onClick: () => onSql(`select column_name, data_type, is_nullable, column_default\nfrom information_schema.columns\nwhere table_schema = '${open.schema}' and table_name = '${open.name}'\norder by ordinal_position;`) }, 'Describe'),
      current ? h('a', { className: 'sy-btn sy-btn--sm', href: `https://supabase.com/dashboard/project/${current.projectRef}/editor`, target: '_blank', rel: 'noreferrer' }, 'In the dashboard') : null)));
}

/**
 * Insights: what the advisors say and what the statistics show, grouped by kind. Each finding
 * opens the table it is about, or loads the SQL that fixes it.
 */
import { bytes, num, levelColour, cell } from './helpers.js';
import { Panel, Stat, Health, List, ListRow } from './kit.js';

export function useInsights(host, sb, project, enabled) {
  const { react } = host;
  const { useState, useEffect, useCallback } = react;
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const reload = useCallback(() => { if (!project || !enabled) return; setError(null); sb('/insights').then((d) => { if (d && d.error) throw new Error(d.error); setData(d); }).catch((e) => { setData(null); setError(e.message); }); }, [sb, project, enabled]);
  useEffect(() => { setData(null); reload(); }, [project, enabled]);
  return { data, error, reload };
}

const KINDS = [['errors', 'Errors'], ['warnings', 'Warnings'], ['security', 'Security'], ['performance', 'Performance'], ['rls', 'No RLS'], ['pk', 'No primary key'], ['indexes', 'Unused indexes'], ['bloat', 'Bloat'], ['running', 'Long running'], ['slow', 'Slow queries']];

export function Insights({ host, insights, q, onOpenTable, onSql }) {
  const { h, ui, tokens } = host;
  const { data, error } = insights;
  const { useState } = host.react;
  const [kind, setKind] = useState('errors');
  const meta = (text) => h('span', { className: 'mpanel__meta' }, text);
  const empty = (text) => h('p', { className: 'mlead', style: { margin: 0 } }, text);
  if (error) return h(ui.EmptyState, { title: 'Could not read the advisors', body: error });
  const c = data ? data.counts : null;
  const match = (s) => !q || String(s).toLowerCase().includes(q);
  const lintRow = (l) => ListRow(host, { key: l.key || `${l.name}-${l.object}-${Math.random()}`, lead: h('span', { className: 'mind-dot', style: { background: levelColour(l.level) } }), label: `${l.title}${l.object ? `: ${l.schema && l.schema !== 'public' ? `${l.schema}.` : ''}${l.object}` : ''}`, sub: l.detail || l.description, meta: h('span', { style: { display: 'flex', gap: 6 } }, l.type === 'table' && l.object ? h('button', { type: 'button', className: 'sy-btn sy-btn--sm', onClick: (e) => { e.stopPropagation(); onOpenTable(l.schema || 'public', l.object); } }, 'Open') : null, l.remediation ? h('a', { className: 'sy-btn sy-btn--sm', href: l.remediation, target: '_blank', rel: 'noreferrer', onClick: (e) => e.stopPropagation() }, 'How to fix') : null), tall: true });
  const lints = data ? data.lints.filter((l) => match(`${l.title} ${l.detail} ${l.object}`)) : [];
  const body = !data ? h(ui.Skeleton, { count: 8, height: 18 })
    : kind === 'errors' ? (lints.filter((l) => l.level === 'ERROR').length ? List(host, lints.filter((l) => l.level === 'ERROR').map(lintRow)) : empty('No error from the advisors.'))
    : kind === 'warnings' ? (lints.filter((l) => l.level === 'WARN').length ? List(host, lints.filter((l) => l.level === 'WARN').map(lintRow)) : empty('No warning.'))
    : kind === 'security' || kind === 'performance' ? (lints.filter((l) => l.kind === kind).length ? List(host, lints.filter((l) => l.kind === kind).sort((a, b) => ['ERROR', 'WARN', 'INFO'].indexOf(a.level) - ['ERROR', 'WARN', 'INFO'].indexOf(b.level)).map(lintRow)) : empty(`Nothing from the ${kind} advisor.`))
    : kind === 'rls' ? (data.tablesWithoutRls.length ? List(host, data.tablesWithoutRls.filter((t) => match(t.name)).map((t) => ListRow(host, { key: t.name, lead: h('span', { className: 'mind-dot', style: { background: 'var(--sy-rosin)' } }), label: t.name, sub: `about ${num(t.approx_rows)} rows, readable by anyone with the anon key`, meta: h('span', { style: { display: 'flex', gap: 6 } }, h('button', { type: 'button', className: 'sy-btn sy-btn--sm', onClick: () => onOpenTable(t.schema, t.name) }, 'Open'), h('button', { type: 'button', className: 'sy-btn sy-btn--sm', onClick: () => onSql(`alter table "${t.schema}"."${t.name}" enable row level security;`) }, 'SQL to enable')) }))) : empty('Every public table has row level security.'))
    : kind === 'pk' ? (data.tablesWithoutPk.length ? List(host, data.tablesWithoutPk.filter((t) => match(t.name)).map((t) => ListRow(host, { key: t.name, lead: h('span', { className: 'mind-dot', style: { background: 'var(--sy-brass)' } }), label: t.name, sub: 'no primary key: rows cannot be edited here, and replication needs one', onClick: () => onOpenTable(t.schema, t.name) }))) : empty('Every public table has a primary key.'))
    : kind === 'indexes' ? (data.unusedIndexes.length ? List(host, data.unusedIndexes.filter((i) => match(`${i.table} ${i.index}`)).map((i) => ListRow(host, { key: i.index, lead: h('span', { className: 'mind-dot', style: { background: 'var(--sy-brass)' } }), label: i.index, sub: `on ${i.table} - never scanned - ${bytes(i.bytes)}`, meta: h('span', { style: { display: 'flex', gap: 6 } }, h('button', { type: 'button', className: 'sy-btn sy-btn--sm', onClick: () => onOpenTable(i.schema, i.table) }, 'Open'), h('button', { type: 'button', className: 'sy-btn sy-btn--sm', onClick: () => onSql(`-- never scanned since the statistics were reset; drop it if the table is written often\ndrop index if exists "${i.schema}"."${i.index}";`) }, 'SQL to drop')) }))) : empty('Every index in public has been used.'))
    : kind === 'bloat' ? (data.bloated.length ? List(host, data.bloated.map((t) => ListRow(host, { key: t.name, lead: h('span', { className: 'mind-dot', style: { background: 'var(--sy-brass)' } }), label: t.name, sub: `${num(t.dead_rows)} dead rows against ${num(t.live_rows)} live${t.last_autovacuum ? ` - autovacuum ${new Date(t.last_autovacuum).toLocaleDateString()}` : ' - never autovacuumed'}`, meta: h('button', { type: 'button', className: 'sy-btn sy-btn--sm', onClick: () => onSql(`vacuum analyze "${t.schema}"."${t.name}";`) }, 'SQL to vacuum') }))) : empty('No table carries many dead rows.'))
    : kind === 'running' ? (data.longRunning.length ? List(host, data.longRunning.map((r) => ListRow(host, { key: r.pid, lead: h('span', { className: 'mind-dot', style: { background: 'var(--sy-rosin)' } }), label: `pid ${r.pid} - ${r.state} - ${String(r.duration).split('.')[0]}`, sub: r.query, meta: h('button', { type: 'button', className: 'sy-btn sy-btn--sm', onClick: () => onSql(`select pg_cancel_backend(${r.pid});`) }, 'SQL to cancel') }))) : empty('Nothing has run for more than five minutes.'))
    : (data.slowQueries.unavailable ? empty('pg_stat_statements is not enabled on this database. Enable the extension under Project to see the slowest queries.') : data.slowQueries.rows.length ? h('div', { style: { overflow: 'auto', paddingRight: 14, scrollbarGutter: 'stable' } }, h('table', { className: 'sb-table' }, h('thead', null, h('tr', null, ['Query', 'Calls', 'Total ms', 'Mean ms', 'Rows'].map((x) => h('th', { key: x }, x)))), h('tbody', null, data.slowQueries.rows.map((r, i) => h('tr', { key: i }, h('td', { style: { fontFamily: 'var(--sy-font-mono)', fontSize: 'var(--sy-fs-xs)', maxWidth: 520, whiteSpace: 'pre-wrap' } }, cell(r.query, 300)), h('td', null, num(r.calls)), h('td', null, num(r.total_ms)), h('td', null, r.mean_ms), h('td', null, num(r.rows))))))) : empty('No statement recorded yet.'));
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--sy-s3)' } },
    h('div', { className: 'mstats mstats--head' },
      Stat(host, { label: 'Advisor errors', value: !c ? '...' : c.errors, tone: c && c.errors ? 'rosin' : 'moss', hint: c ? `${c.lints} findings in all` : undefined }),
      Stat(host, { label: 'Warnings', value: !c ? '...' : c.warnings, tone: c && c.warnings ? 'brass' : 'muted', hint: c ? `${c.security} security, ${c.performance} performance` : undefined }),
      Stat(host, { label: 'Tables without RLS', value: !c ? '...' : c.tablesWithoutRls, tone: c && c.tablesWithoutRls ? 'rosin' : 'moss', hint: 'in public' }),
      Stat(host, { label: 'Unused indexes', value: !c ? '...' : c.unusedIndexes, tone: c && c.unusedIndexes ? 'brass' : 'muted', hint: c ? bytes(c.unusedIndexBytes) : undefined })),
    h('div', { className: 'mhealth' },
      ...(data ? data.cacheHit.map((x) => Health(host, { key: x.kind, label: `${x.kind} cache hit`, value: x.hit_ratio === null ? '-' : `${Math.round(Number(x.hit_ratio) * 100)}%`, tone: x.hit_ratio !== null && Number(x.hit_ratio) < 0.95 ? 'rosin' : undefined })) : [Health(host, { label: 'cache', value: '...' })]),
      Health(host, { label: 'long running', value: c ? c.longRunning : '...' }),
      Health(host, { label: 'bloated', value: c ? c.bloated : '...' }),
      Health(host, { label: 'no primary key', value: c ? c.tablesWithoutPk : '...' })),
    Panel(host, { title: KINDS.find(([k]) => k === kind)[1], wide: true, action: h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } }, KINDS.map(([k, l]) => h(ui.Chip, { key: k, on: kind === k, onClick: () => setKind(k) }, l))) },
      h('div', { style: { maxHeight: 640, overflow: 'auto', paddingRight: 14, scrollbarGutter: 'stable' } }, body)));
}

export function InsightsAside({ host, insights, onOpenTable }) {
  const { h, ui } = host;
  const { data } = insights;
  const meta = (text) => h('span', { className: 'mpanel__meta' }, text);
  const byName = data ? Object.entries(data.lints.reduce((acc, l) => { acc[l.title] = acc[l.title] || { title: l.title, level: l.level, count: 0 }; acc[l.title].count++; return acc; }, {})).map(([, v]) => v).sort((a, b) => b.count - a.count) : [];
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--sy-s3)' } },
    Panel(host, { title: 'By finding', bodyStyle: { maxHeight: 420, overflow: 'auto', paddingRight: 14, scrollbarGutter: 'stable' }, action: meta(data ? `${byName.length}` : '...') },
      !data ? h(ui.Skeleton, { count: 5, height: 16 }) : byName.length ? List(host, byName.map((x) => ListRow(host, { key: x.title, lead: h('span', { className: 'mind-dot', style: { background: levelColour(x.level), width: 7, height: 7 } }), label: x.title, meta: `${x.count}` }))) : h('p', { className: 'mlead', style: { margin: 0 } }, 'Nothing from the advisors.')),
    Panel(host, { title: 'How it reads' }, h('p', { className: 'mlead', style: { margin: 0 } }, 'The security and performance advisors are the ones the Supabase dashboard runs. The rest comes from the catalog: tables in public without RLS or a primary key, indexes never scanned since the statistics were reset, tables with many dead rows, statements running over five minutes, and the slowest statements when pg_stat_statements is on.')));
}

/**
 * The project as a bento: services, database, users, storage, what needs attention, the
 * biggest tables, who signed up last.
 */
import { ago, bytes, num, pct } from './helpers.js';
import { Panel, Stat, Health, Bars, List, ListRow, FILL } from './kit.js';

export function useOverview(host, sb, project, enabled) {
  const { react } = host;
  const { useState, useEffect, useCallback } = react;
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const reload = useCallback((fresh) => {
    if (!project || !enabled) return;
    setError(null);
    sb(`/overview${fresh ? '?refresh=1' : ''}`).then((d) => { if (d && d.error) throw new Error(d.error); setData(d); }).catch((e) => { setData(null); setError(e.message); });
  }, [sb, project, enabled]);
  useEffect(() => { setData(null); reload(); }, [project, enabled]);
  return { data, error, reload };
}

export const tableRow = (host, t, onOpen) => ListRow(host, { key: `${t.schema}.${t.name}`, lead: host.h('span', { className: 'mind-dot', style: { background: t.rls_enabled === false ? 'var(--sy-rosin)' : t.has_pk === false ? 'var(--sy-brass)' : 'var(--sy-moss)' } }), label: t.name, sub: `${Number(t.approx_rows) < 0 ? 'rows unknown' : `about ${num(t.approx_rows)} rows`} - ${bytes(t.size_bytes)}${t.rls_enabled === false ? ' - no RLS' : t.policies !== undefined ? ` - ${t.policies} polic${Number(t.policies) === 1 ? 'y' : 'ies'}` : ''}${t.has_pk === false ? ' - no primary key' : ''}`, meta: t.kind && t.kind !== 'table' ? t.kind.replace('_', ' ') : '', onClick: () => onOpen(t.schema, t.name) });
export const userRow = (host, u, onOpen) => ListRow(host, { key: u.id, lead: host.h('span', { className: 'mind-dot', style: { background: u.banned ? 'var(--sy-rosin)' : u.confirmed === false || (u.confirmed === undefined && !u.email_confirmed_at) ? 'var(--sy-brass)' : 'var(--sy-moss)' } }), label: u.email || u.phone || u.id, sub: `${u.provider || (u.app_metadata && u.app_metadata.provider) || 'email'}${u.last_sign_in_at ? ` - seen ${ago(u.last_sign_in_at)}` : ' - never signed in'}`, meta: u.created_at ? ago(u.created_at) : '', onClick: onOpen ? () => onOpen(u) : undefined });

export function Overview({ host, overview, insights, current, onOpenTable, onAction, onSql }) {
  const { h, ui } = host;
  const { data, error } = overview;
  const meta = (text) => h('span', { className: 'mpanel__meta' }, text);
  const empty = (text) => h('p', { className: 'mlead', style: { margin: 0 } }, text);
  if (error) return h(ui.EmptyState, { title: 'Supabase did not answer', body: error });
  const loading = !data;
  const down = data ? data.services.filter((s) => !s.healthy) : [];
  const c = insights.data ? insights.data.counts : null;
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--sy-s3)' } },
    h('div', { className: 'mstats mstats--head' },
      Stat(host, { label: 'Services', value: loading ? '...' : down.length ? `${down.length} down` : 'all up', tone: loading ? 'muted' : down.length ? 'rosin' : 'moss', hint: loading ? undefined : `${data.services.length} checked${data.project ? ` - ${data.project.region}` : ''}` }),
      Stat(host, { label: 'Database', value: loading || !data.database ? '...' : bytes(data.database.size_bytes), tone: 'brass', hint: loading || !data.database ? undefined : `${data.database.connections} of ${data.database.max_connections} connections - Postgres ${(data.project && data.project.postgresVersion) || ''}` }),
      Stat(host, { label: 'Users', value: loading || !data.auth ? '...' : num(data.auth.total_users), tone: 'muted', hint: loading || !data.auth ? undefined : `${data.auth.active_7d} active this week, ${data.auth.signups_7d} new` }),
      Stat(host, { label: 'To look at', value: !c ? '...' : c.errors + c.tablesWithoutRls + c.warnings, tone: c && (c.errors + c.tablesWithoutRls) ? 'rosin' : c && c.warnings ? 'brass' : 'muted', hint: c ? `${c.errors} error${c.errors === 1 ? '' : 's'}, ${c.warnings} warning${c.warnings === 1 ? '' : 's'}, ${c.tablesWithoutRls} without RLS` : 'reading the advisors...' })),
    h('div', { className: 'mhealth' },
      ...(loading ? [Health(host, { label: 'services', value: '...' })] : data.services.map((s) => Health(host, { key: s.name, label: s.name, value: s.healthy ? 'up' : s.status || 'down', tone: s.healthy ? undefined : 'rosin' }))),
      Health(host, { label: 'storage', value: loading || !data.storage ? '...' : `${data.storage.objects} files, ${bytes(data.storage.bytes)}` }),
      Health(host, { label: 'edge functions', value: loading ? '...' : data.functions.length }),
      Health(host, { label: 'disk', value: loading || !data.disk ? '...' : pct(data.disk.usedBytes, data.disk.sizeBytes) }),
      Health(host, { label: 'backups', value: loading || !data.backups ? '...' : data.backups.pitr ? 'PITR' : 'daily' })),
    onAction ? Panel(host, { title: 'Do', wide: true, action: meta('everything Supabase, from here') },
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
        h(ui.Button, { className: 'sy-btn--sm', variant: 'primary', onClick: () => onAction('database') }, 'Open a table to read or edit rows'),
        h(ui.Button, { className: 'sy-btn--sm', onClick: () => onSql('select table_name, table_type\nfrom information_schema.tables\nwhere table_schema = \'public\'\norder by table_name;') }, 'Run SQL'),
        h(ui.Button, { className: 'sy-btn--sm', onClick: () => onAction('insights') }, 'Fix what the advisors found'),
        h(ui.Button, { className: 'sy-btn--sm', onClick: () => onAction('auth') }, 'Users'),
        h(ui.Button, { className: 'sy-btn--sm', onClick: () => onAction('storage') }, 'Files'),
        h(ui.Button, { className: 'sy-btn--sm', onClick: () => onAction('project') }, 'Backups and settings'),
        h(ui.Button, { className: 'sy-btn--sm', onClick: () => onAction('ask') }, 'Ask the AI about the project'))) : null,
    data && data.issues.length ? Panel(host, { title: 'Needs attention', wide: true, action: meta(`${data.issues.length}`) },
      List(host, data.issues.map((i, k) => ListRow(host, { key: k, lead: h('span', { className: 'mind-dot', style: { background: i.level === 'error' ? 'var(--sy-rosin)' : i.level === 'warn' ? 'var(--sy-brass)' : 'var(--sy-text-3)' } }), label: i.message, sub: i.issue === 'advisor' || i.issue === 'rls' ? 'Insights' : i.issue === 'service' || i.issue === 'disk' || i.issue === 'backups' || i.issue === 'connections' ? 'Project' : i.issue === 'keys' ? 'Projects' : '', onClick: () => onAction(i.issue === 'advisor' || i.issue === 'rls' ? 'insights' : i.issue === 'keys' ? 'projects' : 'project') })))) : null,
    h('div', { className: 'sb-row2' },
      Panel(host, { title: 'Largest tables', action: meta(loading ? '' : `${data.counts ? data.counts.public_tables : data.tables.length} in public`) },
        loading ? h(ui.Skeleton, { count: 6, height: 18 }) : data.tables.length ? h('div', { style: { maxHeight: 520, overflow: 'auto', paddingRight: 14, scrollbarGutter: 'stable' } }, List(host, data.tables.slice(0, 12).map((t) => tableRow(host, t, onOpenTable)))) : empty('No table in the public schema.')),
      Panel(host, { title: 'Signed up last', action: meta(loading ? '' : `${data.recentUsers.length}`) },
        loading ? h(ui.Skeleton, { count: 6, height: 18 }) : data.recentUsers.length ? List(host, data.recentUsers.map((u) => userRow(host, u, () => onAction('auth')))) : empty('No user yet.'))));
}

export function OverviewAside({ host, overview, insights, onOpenTable, onAction }) {
  const { h, ui } = host;
  const { data } = overview;
  const meta = (text) => h('span', { className: 'mpanel__meta' }, text);
  const c = insights.data ? insights.data.counts : null;
  const worst = insights.data ? insights.data.lints.filter((l) => l.level === 'ERROR' || l.level === 'WARN').slice(0, 12) : [];
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--sy-s3)', flex: 1, minHeight: 0, height: '100%' } },
    Panel(host, { title: 'Findings', action: meta(c ? `${c.lints} from the advisors` : '...') },
      c ? Bars(host, { rows: [{ label: 'errors', value: c.errors, color: 'var(--sy-rosin)' }, { label: 'warnings', value: c.warnings, color: 'var(--sy-brass)' }, { label: 'info', value: c.info }, { label: 'no RLS', value: c.tablesWithoutRls, color: 'var(--sy-rosin)' }, { label: 'no primary key', value: c.tablesWithoutPk, color: 'var(--sy-brass)' }, { label: 'unused indexes', value: c.unusedIndexes, color: 'var(--sy-brass)' }, { label: 'long running', value: c.longRunning, color: 'var(--sy-rosin)' }] }) : h(ui.Skeleton, { count: 5, height: 14 })),
    Panel(host, { title: 'Fix first', ...FILL, action: meta(insights.data ? `${worst.length}` : '...') },
      !insights.data ? h(ui.Skeleton, { count: 4, height: 16 }) : worst.length ? List(host, worst.map((l) => ListRow(host, { key: l.key || `${l.name}-${l.object}`, lead: h('span', { className: 'mind-dot', style: { background: l.level === 'ERROR' ? 'var(--sy-rosin)' : 'var(--sy-brass)' } }), label: l.title, sub: `${l.object ? `${l.schema ? `${l.schema}.` : ''}${l.object} - ` : ''}${l.kind}`, onClick: l.type === 'table' && l.object ? () => onOpenTable(l.schema || 'public', l.object) : () => onAction('insights') }))) : h('p', { className: 'mlead', style: { margin: 0 } }, 'Nothing beyond information.')),
    data && data.buckets.length ? Panel(host, { title: 'Buckets', action: meta(`${data.buckets.length}`) }, h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } }, data.buckets.map((b) => h(ui.Chip, { key: b.id, onClick: () => onAction('storage'), title: b.public ? 'public' : 'private' }, `${b.name}${b.public ? '' : ' (private)'}`)))) : null);
}

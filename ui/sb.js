/**
 * Supabase in Cadence 3.0: three regions and a header, like the other plugins.
 *
 *   Sidebar: Overview, Database, SQL, Auth, Storage, Functions, Insights, Project, Ask,
 *   Projects; the project this screen is on (it follows the repository the active shell is
 *   on), a search.
 *   Main: the project as a bento, the tables and one table with its rows editable, a SQL
 *   console, the users, the buckets and files, the edge functions and secrets, what the
 *   advisors and statistics say, the project's services and settings, questions.
 *   Right: what to fix first, the schemas, or the item's facts and actions.
 *
 * Every call carries ?project=<name>, so two screens on two repositories never fight over a
 * global active project. Keys and the management token never reach the browser.
 */
import { ensureStyles, NavItem, Section } from './kit.js';
import { ago } from './helpers.js';
import { useOverview, Overview, OverviewAside } from './overview.js';
import { Tables, TablePage, TableAside, DatabaseAside, useTable } from './database.js';
import { Sql, SqlAside } from './sql.js';
import { Users, UsersAside } from './auth.js';
import { Storage, StorageAside } from './storage.js';
import { Functions, FunctionsAside } from './functions.js';
import { useInsights, Insights, InsightsAside } from './insights.js';
import { Project, ProjectAside } from './project.js';
import { Ask } from './ask.js';
import { Projects, ProjectsAside } from './projects.js';

export const API = '/api/plugins/supabase';

const NAV = [
  { id: 'overview', label: 'Overview', icon: 'chart', hint: 'The project: services, database, users, storage, what needs attention.' },
  { id: 'database', label: 'Database', icon: 'list', hint: 'Schemas and tables. Open one to see its columns, rows, policies, indexes and triggers.' },
  { id: 'sql', label: 'SQL', icon: 'run', hint: 'A SQL console on the database. Destructive statements ask before they run.' },
  { id: 'auth', label: 'Auth', icon: 'people', hint: 'The users: who they are, how they sign in, their sessions; invite, ban, delete.' },
  { id: 'storage', label: 'Storage', icon: 'epic', hint: 'Buckets and the files in them; signed links, delete, new buckets.' },
  { id: 'functions', label: 'Functions', icon: 'branch', hint: 'Edge functions and their secrets; the database functions and triggers.' },
  { id: 'insights', label: 'Insights', icon: 'warning', hint: 'What the advisors and the statistics say: security, performance, tables without RLS, unused indexes, slow queries.' },
  { id: 'project', label: 'Project', icon: 'history', hint: 'Services, compute and disk, backups, migrations, extensions, settings, logs, types.' },
  { id: 'ask', label: 'Ask', icon: 'search', hint: 'A question about the project. The AI reads it for you.' },
  { id: 'projects', label: 'Projects', icon: 'story', hint: 'The Supabase projects this workspace knows, their keys and repositories, and the management token.' },
];

function Supabase({ host }) {
  const { h, ui, api, notify, context } = host;
  const { useState, useEffect, useCallback, useMemo } = host.react;
  const [tab, setTab] = useState('overview');
  const [projects, setProjects] = useState(null);
  const [tokenSet, setTokenSet] = useState(false);
  const [project, setProject] = useState(() => { try { return localStorage.getItem('sy.sb.project') || ''; } catch { return ''; } });
  const [q, setQ] = useState('');
  const [schema, setSchema] = useState('public');
  const [openTable, setOpenTable] = useState(null);
  const [openUser, setOpenUser] = useState(null);
  const [openBucket, setOpenBucket] = useState(null);
  const [openObject, setOpenObject] = useState(null);
  const [openFn, setOpenFn] = useState(null);
  const [sqlSeed, setSqlSeed] = useState(null);
  useEffect(() => { ensureStyles(); }, []);
  const sb = useCallback((path, opts) => api(`${API}${path}${path.includes('?') ? '&' : '?'}project=${encodeURIComponent(project)}`, opts), [api, project]);
  const loadProjects = useCallback(() => api(`${API}/projects`).then((d) => {
    const list = d.projects || [];
    setProjects(list); setTokenSet(!!d.managementTokenSet);
    const focused = ((context && context()) || {}).focused;
    const norm = (v) => String(v || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const byRepo = focused && focused.path ? list.find((p) => p.repoPath && norm(p.repoPath) === norm(focused.path)) : null;
    setProject((cur) => (byRepo ? byRepo.name : (cur && list.some((p) => p.name === cur)) ? cur : (d.activeProject && list.some((p) => p.name === d.activeProject)) ? d.activeProject : (list[0] ? list[0].name : '')));
  }).catch((e) => { setProjects([]); notify(e.message, 'rosin'); }), [api, context]);
  useEffect(() => { loadProjects(); }, [loadProjects]);
  useEffect(() => { try { if (project) localStorage.setItem('sy.sb.project', project); } catch {} }, [project]);
  const current = (projects || []).find((p) => p.name === project) || null;
  const configured = !!(current && current.projectRef && tokenSet);
  const overview = useOverview(host, sb, project, configured && tab !== 'projects');
  const insights = useInsights(host, sb, project, configured && (tab === 'insights' || tab === 'overview' || tab === 'ask'));
  const table = useTable(host, sb, openTable);
  const leave = () => { setOpenTable(null); setOpenUser(null); setOpenObject(null); setOpenFn(null); };
  const nav = NAV.find((n) => n.id === tab) || NAV[0];
  const filtered = useMemo(() => q.trim().toLowerCase(), [q]);
  const runSql = (query) => { setSqlSeed({ query, at: Date.now() }); setTab('sql'); leave(); };
  const openTheTable = (sch, name) => { setTab('database'); setSchema(sch || 'public'); setOpenTable({ schema: sch || 'public', name }); };
  const problems = insights.data ? insights.data.counts.errors + insights.data.counts.tablesWithoutRls : 0;
  const searchable = ['database', 'auth', 'storage', 'functions', 'insights'].includes(tab);

  const left = h('div', { className: 'sb' },
    h('div', { className: 'sb__head' }, h('span', { className: 'sb__title' }, 'Supabase')),
    h('div', { className: 'mind-stats' },
      !overview.data ? h('span', null, projects === null ? 'reading the projects...' : configured ? 'reading the project...' : tokenSet ? 'no project configured' : 'no management token') : [h('span', { key: 't' }, `${overview.data.counts ? overview.data.counts.public_tables : '-'} tables`), h('span', { key: 'u' }, `${overview.data.auth ? overview.data.auth.total_users : '-'} users`), h('span', { key: 's' }, `${overview.data.storage ? overview.data.storage.objects : '-'} files`)]),
    h('ul', { className: 'sb__list', role: 'list' },
      NAV.map((n) => NavItem(host, {
        key: n.id, icon: host.icons[n.icon], label: n.label, active: tab === n.id, title: n.hint,
        badge: n.id === 'insights' && insights.data ? (problems || undefined) : n.id === 'projects' && projects ? (projects.length || undefined) : n.id === 'overview' && overview.data && overview.data.services.some((s) => !s.healthy) ? '!' : undefined,
        onClick: () => { setTab(n.id); leave(); },
      }))),
    h('div', { style: { flex: 1 } }),
    Section(host, 'Project'),
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, padding: '0 var(--sy-s3) var(--sy-s2)' } },
      h(ui.Select, { value: project, onChange: (e) => { setProject(e.target.value); leave(); }, 'aria-label': 'Project' },
        (projects || []).map((p) => h('option', { key: p.name, value: p.name }, p.name)),
        !(projects || []).length ? h('option', { value: '' }, 'No project yet') : null),
      searchable ? h(ui.Input, { value: q, placeholder: tab === 'auth' ? 'Search users' : tab === 'storage' ? 'Search files' : tab === 'functions' ? 'Search functions' : tab === 'insights' ? 'Search findings' : 'Search tables', onChange: (e) => setQ(e.target.value), 'aria-label': 'Search' }) : null),
    h('div', { className: 'sb__foot' }, openTable ? 'One table. Back to the tables from the header.' : nav.hint));

  const header = h('div', { className: 'mind-view__head' },
    h('div', null,
      h('h1', { className: 'stage-title' }, openTable ? `${openTable.schema === 'public' ? '' : `${openTable.schema}.`}${openTable.name}` : nav.label),
      h('p', { style: { margin: 0, color: 'var(--sy-text-3)', fontSize: 'var(--sy-fs-sm)' } },
        openTable ? (table.data ? `${table.data.table.kind.replace('_', ' ')} - ${table.data.columns.length} columns - about ${Number(table.data.table.approx_rows) < 0 ? '?' : Number(table.data.table.approx_rows).toLocaleString()} rows - ${table.data.table.rls_enabled ? `RLS on, ${table.data.policies.length} polic${table.data.policies.length === 1 ? 'y' : 'ies'}` : 'RLS off'}` : 'reading...') : `${nav.hint}${project ? ` On ${project}${current ? ` (${current.projectRef})` : ''}.` : ''}`)),
    h('div', { className: 'mind-view__actions' },
      current && !openTable ? h('a', { className: 'sy-btn', href: `https://supabase.com/dashboard/project/${current.projectRef}`, target: '_blank', rel: 'noreferrer' }, 'Open the dashboard') : null,
      openTable ? h(ui.Button, { onClick: () => setOpenTable(null) }, 'Back to the tables') : h(ui.Button, { onClick: () => { overview.reload(true); insights.reload(); loadProjects(); } }, 'Refresh')));

  const main = h('div', { style: { padding: '12px 16px 24px', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } },
    projects && !projects.length && tab !== 'projects' ? h(ui.EmptyState, { title: 'No Supabase project yet', body: 'Add one under Projects: a name, the project ref, its service role key, and the repository it belongs to. A management token unlocks SQL, the schema, functions and settings.' })
      : !configured && tab !== 'projects' && projects && projects.length ? h(ui.EmptyState, { title: tokenSet ? `${project || 'This project'} is not complete` : 'No management token', body: tokenSet ? 'Give it a project ref under Projects.' : 'Add a personal access token (sbp_...) under Projects; every project on the account uses it.' })
      : openTable
        ? h(TablePage, { host, sb, project, current, open: openTable, table, onChanged: () => { table.reload(); overview.reload(true); }, onOpenTable: openTheTable, onSql: runSql })
      : tab === 'database' ? h(Tables, { host, sb, project, overview, schema, setSchema, q: filtered, onOpen: (sch, name) => openTheTable(sch || schema, name) })
      : tab === 'sql' ? h(Sql, { host, sb, project, seed: sqlSeed, onOpenTable: openTheTable })
      : tab === 'auth' ? h(Users, { host, sb, project, overview, q: filtered, selected: openUser, onSelect: setOpenUser })
      : tab === 'storage' ? h(Storage, { host, sb, project, overview, q: filtered, bucket: openBucket, setBucket: setOpenBucket, selected: openObject, onSelect: setOpenObject })
      : tab === 'functions' ? h(Functions, { host, sb, project, overview, q: filtered, selected: openFn, onSelect: setOpenFn, onSql: runSql })
      : tab === 'insights' ? h(Insights, { host, insights, q: filtered, onOpenTable: openTheTable, onSql: runSql })
      : tab === 'project' ? h(Project, { host, sb, project, current, overview, onChanged: () => overview.reload(true) })
      : tab === 'ask' ? h(Ask, { host, api: API, project, overview, onOpenTable: openTheTable })
      : tab === 'projects' ? h(Projects, { host, api: API, projects, tokenSet, current: project, onChanged: loadProjects, onPick: (n) => setProject(n) })
      : h(Overview, { host, overview, insights, current, onOpenTable: openTheTable, onAction: (a) => { setTab(a); leave(); }, onSql: runSql }));

  const right = openTable
    ? h(TableAside, { host, sb, project, current, open: openTable, table, onOpenTable: openTheTable, onSql: runSql, onChanged: () => { table.reload(); overview.reload(true); } })
    : tab === 'database' ? h(DatabaseAside, { host, sb, project, overview, schema, setSchema, onOpenTable: openTheTable })
    : tab === 'sql' ? h(SqlAside, { host, overview, onRun: runSql })
    : tab === 'auth' ? h(UsersAside, { host, sb, project, selected: openUser, onChanged: () => { overview.reload(true); setOpenUser(openUser ? { ...openUser, _bump: Date.now() } : null); }, onCleared: () => setOpenUser(null) })
    : tab === 'storage' ? h(StorageAside, { host, sb, project, bucket: openBucket, selected: openObject, onChanged: () => { overview.reload(true); setOpenObject(openObject ? { ...openObject, _bump: Date.now() } : null); }, onCleared: () => setOpenObject(null) })
    : tab === 'functions' ? h(FunctionsAside, { host, sb, project, current, selected: openFn, onChanged: () => overview.reload(true) })
    : tab === 'insights' ? h(InsightsAside, { host, insights, onOpenTable: openTheTable })
    : tab === 'project' ? h(ProjectAside, { host, current, overview })
    : tab === 'projects' ? h(ProjectsAside, { host })
    : h(OverviewAside, { host, overview, insights, onOpenTable: openTheTable, onAction: (a) => { setTab(a); leave(); } });

  return h(ui.Regions, { left, right, paneId: `sb-${tab}`, paneLabel: openTable ? 'This table' : tab === 'database' ? 'Schemas' : tab === 'sql' ? 'Queries' : tab === 'auth' ? 'This user' : tab === 'storage' ? 'This file' : tab === 'functions' ? 'This function' : tab === 'insights' ? 'By kind' : tab === 'project' ? 'Links' : tab === 'projects' ? 'How it works' : 'Attention' },
    h('div', { className: 'sb-main', style: { display: 'flex', flexDirection: 'column', height: 'calc(100vh - 57px)' } }, h('div', { style: { padding: '32px 16px 0', flex: 'none' } }, header), main));
}

Supabase.cadenceComponent = true;
export default Supabase;

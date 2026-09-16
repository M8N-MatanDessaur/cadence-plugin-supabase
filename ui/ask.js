/**
 * Ask, as a bento: a question about the project, answered by the AI from read-only routes.
 */
import { waitForTask } from './helpers.js';
import { Panel, Health, List, ListRow, FILL } from './kit.js';

const RECENT_KEY = 'sy.sb.ask.recent';
const readRecent = () => { try { const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
const writeRecent = (list) => { try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 20))); } catch {} };
const when = (at) => new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const short = (s, n = 64) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}...` : s);

function prepare({ overview }) {
  const d = overview.data;
  if (!d) return [];
  const out = [];
  out.push({ q: 'Which tables lack row level security or have policies that let anyone write? What would you change?', why: 'security' });
  out.push({ q: 'Describe the data model: the main tables, how they relate, and what looks unused.', why: 'orientation' });
  if (d.auth && d.auth.total_users) out.push({ q: 'How are users signing up and coming back over the last 30 days? Which providers?', why: `${d.auth.total_users} users` });
  out.push({ q: 'Which indexes are never used, and which foreign keys have no index?', why: 'performance' });
  if (d.storage && d.storage.objects) out.push({ q: 'What is in storage: which buckets, how big, and are any public that should not be?', why: `${d.storage.objects} files` });
  out.push({ q: 'What do the advisors flag as errors, and what is the one-line fix for each?', why: `${d.advisors.errors + d.advisors.warnings} findings` });
  return out.slice(0, 7);
}

export function Ask({ host, api: API, project, overview, onOpenTable }) {
  const { h, ui, api, react, icons } = host;
  const { useState, useEffect, useMemo } = react;
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [recent, setRecent] = useState(readRecent);
  useEffect(() => { if (!asking) { setElapsed(0); return undefined; } const started = Date.now(); const t = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000); return () => clearInterval(t); }, [asking]);
  const suggestions = useMemo(() => prepare({ overview }), [overview.data]);
  const meta = (text) => h('span', { className: 'mpanel__meta' }, text);
  const ask = async (text) => {
    const asked = (text || question).trim();
    if (!asked || asking) return;
    setQuestion(asked); setAsking(true); setAnswer(null);
    const started = Date.now();
    try {
      const cfg = await api('/api/config').catch(() => ({}));
      const base = window.location.origin;
      const sp = `project=${encodeURIComponent(project)}`;
      const prompt = [
        `Answer a question about the Supabase project "${project}". Today is ${new Date().toISOString().slice(0, 10)}.`,
        'Read from these READ-ONLY routes on the local Cadence server (plain GET with curl, or POST to /sql/select which is read-only). Never call any other POST, PATCH, PUT or DELETE; never change, delete or restart anything.',
        `  ${base}${API}/overview?${sp}                                    services, database, users, storage, tables (with RLS and size), buckets, functions, advisors, issues`,
        `  ${base}${API}/tables?schema=public&${sp}                        tables with rows, size, RLS, policy count, primary key`,
        `  ${base}${API}/table?schema=public&name=<table>&${sp}            one table: columns, indexes, policies, triggers, constraints, references`,
        `  ${base}${API}/insights?${sp}                                    advisor findings, tables without RLS or PK, unused indexes, cache hit, bloat, long running, slow queries`,
        `  ${base}${API}/policies?schema=public&${sp}                      every policy with its expressions`,
        `  ${base}${API}/stats/auth/summary?${sp}  /stats/auth/growth?days=30  /stats/auth/providers   users`,
        `  ${base}${API}/storage/buckets?${sp}   and POST ${base}${API}/storage/list/<bucket> with {"prefix":"","limit":100}`,
        `  POST ${base}${API}/sql/select?${sp} with {"query":"select ..."}  any read-only SQL, as postgres (every schema visible)`,
        '', `Question: ${asked}`, '',
        'Answer in Markdown from what you read only: a short lead, then bold labels, bullets or a table. Name tables as public.<name>. Give SQL in fenced blocks when a fix is one statement. Say plainly if the data does not cover it.',
        'This is a one-off answer, not a session: do not run any bootstrap, do not save to Mind or any memory, do not mention either. Reply with the answer only.',
      ].join('\n');
      const result = await api('/api/orchestrator/spawn', { method: 'POST', body: JSON.stringify({ cli: cfg.DefaultCli || 'claude', from: 'supabase-ask', timeout: 300000, prompt }) });
      const text = result.handledLocally ? (result.answer || '(no answer)') : result.id ? await waitForTask(api, result.id, 300000) : (result.error || 'No answer came back.');
      const entry = { question: asked, answer: String(text).replace(/^\s*\[bootstrap:[^\]]*\]\s*/, '').trim(), at: new Date().toISOString(), seconds: Math.round((Date.now() - started) / 1000) };
      setAnswer(entry); const next = [entry, ...recent.filter((e) => e.question !== asked)]; writeRecent(next); setRecent(next);
    } catch (e) { setAnswer({ question: asked, answer: e.message, at: new Date().toISOString(), seconds: 0 }); } finally { setAsking(false); }
  };
  const d = overview.data;
  const answerPanel = asking
    ? Panel(host, { title: 'Reading the project', action: meta(`${elapsed}s`), ...FILL }, h('p', { className: 'mlead', style: { margin: '0 0 var(--sy-s3)' } }, 'The AI is reading the schema and the statistics, then writing the answer.'), h(ui.Skeleton, { count: 5, height: 16 }))
    : !answer
      ? Panel(host, { title: 'Answer', action: meta('nothing asked yet'), ...FILL },
        h('p', { className: 'mlead', style: { margin: '0 0 var(--sy-s3)' } }, 'The AI reads the project through this plugin for whatever the question needs and answers from what it read. It runs read-only SQL only; it never changes anything.'),
        h('div', { className: 'mhealth' }, Health(host, { label: 'tables', value: d && d.counts ? `${d.counts.public_tables}` : '...', tone: 'brass' }), Health(host, { label: 'users', value: d && d.auth ? `${d.auth.total_users}` : '...' }), Health(host, { label: 'findings', value: d ? `${d.advisors.errors + d.advisors.warnings}` : '...' })))
      : Panel(host, { title: 'Answer', ...FILL, action: meta(`${when(answer.at)} - ${answer.seconds}s`) }, h('p', { className: 'mlead', style: { margin: '0 0 var(--sy-s3)' } }, answer.question), h(ui.Markdown, { source: answer.answer }));
  const column = (...children) => h('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--sy-s3)', minWidth: 0, minHeight: 0 } }, ...children);
  return h('div', { className: 'sb-ask', style: { flex: 1, minHeight: 0 } },
    column(
      Panel(host, { title: 'Ask about the project', action: meta(project || 'no project') },
        h('div', { style: { display: 'flex', gap: 8 } },
          h(ui.Input, { placeholder: '"which tables can anyone read?" or "how many users signed up this month?"', value: question, disabled: asking, onChange: (e) => setQuestion(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') ask(); }, 'aria-label': 'Question' }),
          h(ui.Button, { variant: 'primary', disabled: asking || !question.trim(), onClick: () => ask() }, asking ? `Asking... ${elapsed}s` : 'Ask'))),
      answerPanel),
    column(
      Panel(host, { title: 'Worth asking', action: meta('from the project') },
        suggestions.length ? List(host, suggestions.map((s) => ListRow(host, { key: s.q, lead: h(icons.search, { size: 13, style: { opacity: 0.6, flex: 'none' } }), label: s.q, sub: s.why, onClick: asking ? undefined : () => ask(s.q) }))) : h('p', { className: 'mlead', style: { margin: 0 } }, 'Reading the project...')),
      Panel(host, { title: 'Recently asked', ...FILL, action: recent.length ? h('button', { type: 'button', className: 'mpanel__meta', style: { background: 'none', border: 0, cursor: 'pointer', padding: 0 }, onClick: () => { writeRecent([]); setRecent([]); } }, 'forget all') : meta('kept in the app') },
        recent.length ? List(host, recent.map((e) => ListRow(host, { key: e.at, lead: h(icons.history, { size: 13, style: { opacity: 0.6, flex: 'none' } }), label: short(e.question), sub: `${when(e.at)} - ${e.seconds}s`, onClick: () => { setQuestion(e.question); setAnswer(e); } }))) : h('p', { className: 'mlead', style: { margin: 0 } }, 'Nothing asked yet. Every answer is kept here and comes back in one click.'))));
}

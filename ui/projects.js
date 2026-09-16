/**
 * Projects: the management token (one for the account) and the Supabase projects this
 * workspace knows, each with a project ref, keys typed once and never shown again, and a
 * repository (so the screen can follow the shell). Test reads the project with its keys.
 */
import { Panel, Stat, List, ListRow } from './kit.js';

function ProjectForm({ host, api: API, initial, onDone, onCancel }) {
  const { h, ui, api, notify } = host;
  const { useState, useEffect } = host.react;
  const editing = !!initial;
  const [name, setName] = useState(initial ? initial.name : '');
  const [projectRef, setProjectRef] = useState(initial ? initial.projectRef || '' : '');
  const [url, setUrl] = useState(initial ? initial.url || '' : '');
  const [serviceRoleKey, setServiceRoleKey] = useState('');
  const [anonKey, setAnonKey] = useState('');
  const [repoPath, setRepoPath] = useState(initial ? initial.repoPath || '' : '');
  const [cloud, setCloud] = useState(null);
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState(null);
  useEffect(() => { api(`${API}/mgmt/projects`).then((d) => setCloud(Array.isArray(d) ? d : [])).catch(() => setCloud([])); }, []);
  const pickRepo = async () => { if (!host.pickTarget) return; const t = await host.pickTarget({ title: 'Which repository is this project for?', detail: 'The screen follows the shell that is on it.' }); if (t) { setRepoPath(t.path); if (!name) setName(t.repo); } };
  const save = async () => {
    if (!name.trim() || !projectRef.trim()) return notify('A name and a project ref are required', 'rosin');
    setBusy(true);
    try {
      const body = { name: name.trim(), projectRef: projectRef.trim(), url: url.trim() || `https://${projectRef.trim()}.supabase.co`, repoPath };
      if (serviceRoleKey.trim()) body.serviceRoleKey = serviceRoleKey.trim();
      if (anonKey.trim()) body.anonKey = anonKey.trim();
      if (editing) await api(`${API}/projects/${encodeURIComponent(initial.name)}`, { method: 'PATCH', body: JSON.stringify(body) });
      else await api(`${API}/projects`, { method: 'POST', body: JSON.stringify(body) });
      notify(editing ? 'Project updated' : 'Project added', 'moss'); onDone(name.trim());
    } catch (e) { notify(e.message, 'rosin'); } finally { setBusy(false); }
  };
  const runTest = async () => { if (!editing) return; setTest('...'); try { const r = await api(`${API}/test?project=${encodeURIComponent(initial.name)}`); setTest(`token ${r.managementToken ? (r.managementToken.ok ? 'ok' : `failed (${r.managementToken.status})`) : 'not set'} - project keys ${r.project ? (r.project.ok ? 'ok' : `failed (${r.project.status})`) : 'not set'}`); } catch (e) { setTest(e.message); } };
  return Panel(host, { title: editing ? `Edit ${initial.name}` : 'New project', wide: true, action: h('span', { className: 'mpanel__meta' }, 'keys stay on this machine') },
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
      cloud && cloud.length && !editing ? h(ui.Field, { label: 'From the account', hint: 'the projects the management token can see' }, h(ui.Select, { value: '', onChange: (e) => { const p = cloud.find((x) => x.id === e.target.value); if (p) { setProjectRef(p.id); if (!name) setName(p.name); setUrl(`https://${p.id}.supabase.co`); } } }, h('option', { value: '' }, 'pick one...'), cloud.map((p) => h('option', { key: p.id, value: p.id }, `${p.name} (${p.id}, ${p.region})`)))) : null,
      h('div', { className: 'sb-row3' },
        h(ui.Field, { label: 'Name', hint: 'as you call it here' }, h(ui.Input, { value: name, placeholder: 'My app', onChange: (e) => setName(e.target.value) })),
        h(ui.Field, { label: 'Project ref', hint: 'the 20 letters in the URL' }, h(ui.Input, { value: projectRef, placeholder: 'abcdefghijklmnopqrst', onChange: (e) => setProjectRef(e.target.value) })),
        h(ui.Field, { label: 'API URL', hint: 'blank derives it from the ref' }, h(ui.Input, { value: url, placeholder: 'https://<ref>.supabase.co', onChange: (e) => setUrl(e.target.value) }))),
      h('div', { className: 'sb-row2' },
        h(ui.Field, { label: editing && initial.serviceRoleKeySet ? 'Service role key (blank keeps the stored one)' : 'Service role key', hint: 'Settings > API keys; it bypasses RLS, so it never leaves this machine' }, h(ui.Input, { type: 'password', value: serviceRoleKey, placeholder: 'eyJ... or sb_secret_...', onChange: (e) => setServiceRoleKey(e.target.value) })),
        h(ui.Field, { label: editing && initial.anonKeySet ? 'Anon key (blank keeps the stored one)' : 'Anon key', hint: 'optional; the public key the app ships with' }, h(ui.Input, { type: 'password', value: anonKey, placeholder: 'eyJ... or sb_publishable_...', onChange: (e) => setAnonKey(e.target.value) }))),
      h(ui.Field, { label: 'Repository', hint: 'the checkout of the app, with its supabase/ folder and migrations' }, h('div', { style: { display: 'flex', gap: 8 } }, h(ui.Input, { value: repoPath, placeholder: 'C:\\Code\\...', onChange: (e) => setRepoPath(e.target.value), style: { flex: 1 } }), host.pickTarget ? h(ui.Button, { onClick: pickRepo }, 'Choose...') : null)),
      h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
        editing ? h(ui.Button, { className: 'sy-btn--sm', onClick: runTest }, 'Test the keys') : null,
        test ? h('span', { className: 'mpanel__meta', style: { color: /failed|not set/.test(test) ? 'var(--sy-rosin)' : 'var(--sy-moss)' } }, test) : null,
        h('span', { style: { flex: 1 } }),
        h(ui.Button, { onClick: onCancel }, 'Cancel'),
        h(ui.Button, { variant: 'primary', disabled: busy, onClick: save }, busy ? 'Saving...' : editing ? 'Save' : 'Add the project'))));
}

export function Projects({ host, api: API, projects, tokenSet, current, onChanged, onPick }) {
  const { h, ui, api, notify } = host;
  const { useState } = host.react;
  const [form, setForm] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const meta = (text) => h('span', { className: 'mpanel__meta' }, text);
  const list = projects || [];
  const remove = async (name) => { try { await api(`${API}/projects/${encodeURIComponent(name)}`, { method: 'DELETE' }); notify(`${name} forgotten`, 'moss'); setConfirm(null); onChanged(); } catch (e) { notify(e.message, 'rosin'); } };
  const saveToken = async () => { if (!token.trim()) return; setBusy(true); try { await api(`${API}/config`, { method: 'POST', body: JSON.stringify({ managementToken: token.trim() }) }); notify('Management token saved', 'moss'); setToken(''); onChanged(); } catch (e) { notify(e.message, 'rosin'); } finally { setBusy(false); } };
  const complete = (p) => p.projectRef && p.serviceRoleKeySet;
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--sy-s3)' } },
    h('div', { className: 'mstats mstats--head' },
      Stat(host, { label: 'Projects', value: projects === null ? '...' : list.length, tone: 'brass' }),
      Stat(host, { label: 'Management token', value: tokenSet ? 'set' : 'missing', tone: tokenSet ? 'moss' : 'rosin', hint: 'one for the whole account' }),
      Stat(host, { label: 'With a repository', value: projects === null ? '...' : list.filter((p) => p.repoPath).length, tone: 'muted', hint: 'follow the shell' }),
      Stat(host, { label: 'Without keys', value: projects === null ? '...' : list.filter((p) => !complete(p)).length, tone: list.some((p) => !complete(p)) ? 'brass' : 'moss', hint: 'SQL still works; rows, auth, storage do not' })),
    Panel(host, { title: 'Management token', wide: true, action: meta(tokenSet ? 'set - typing a new one replaces it' : 'needed for SQL, the schema, functions and settings') },
      h('div', { style: { display: 'flex', gap: 8 } }, h(ui.Input, { type: 'password', value: token, placeholder: 'sbp_... from supabase.com/dashboard/account/tokens', onChange: (e) => setToken(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') saveToken(); } }), h(ui.Button, { variant: 'primary', disabled: busy || !token.trim(), onClick: saveToken }, busy ? 'Saving...' : tokenSet ? 'Replace' : 'Save'))),
    form !== null ? h(ProjectForm, { host, api: API, initial: form === 'new' ? null : form, onDone: (n) => { setForm(null); onChanged(); onPick(n); }, onCancel: () => setForm(null) })
      : Panel(host, { title: 'Projects', wide: true, action: h(ui.Button, { className: 'sy-btn--sm', variant: 'primary', onClick: () => setForm('new') }, 'New project') },
        projects === null ? h(ui.Skeleton, { count: 3, height: 18 }) : list.length ? List(host, list.map((p) => ListRow(host, { key: p.name, lead: h('span', { className: 'mind-dot', style: { background: p.name === current ? 'var(--sy-brass)' : complete(p) ? 'var(--sy-text-3)' : 'var(--sy-rosin)' } }), label: p.name, sub: `${p.projectRef}${p.serviceRoleKeySet ? '' : ' - no service role key'}${p.anonKeySet ? '' : ' - no anon key'} - ${p.repoPath || 'no repository'}`, meta: h('span', { style: { display: 'flex', gap: 6 } }, p.name !== current ? h('button', { type: 'button', className: 'sy-btn sy-btn--sm', onClick: (e) => { e.stopPropagation(); onPick(p.name); } }, 'Use') : null, h('button', { type: 'button', className: 'sy-btn sy-btn--sm', onClick: (e) => { e.stopPropagation(); setForm(p); } }, 'Edit'), confirm === p.name ? h('button', { type: 'button', className: 'sy-btn sy-btn--sm', style: { color: 'var(--sy-rosin)' }, onClick: (e) => { e.stopPropagation(); remove(p.name); } }, 'Yes, forget it') : h('button', { type: 'button', className: 'sy-btn sy-btn--sm', onClick: (e) => { e.stopPropagation(); setConfirm(p.name); } }, 'Forget')), onClick: () => onPick(p.name) }))) : h('p', { className: 'mlead', style: { margin: 0 } }, 'No project yet. Add one from the account, or by its ref.')));
}

export function ProjectsAside({ host }) {
  const { h } = host;
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--sy-s3)' } },
    Panel(host, { title: 'How projects work' }, h('p', { className: 'mlead', style: { margin: 0 } }, 'One management token, from your account, reaches every project you can see: SQL, the schema, functions, settings, advisors. Each project then adds its own service role key for rows, auth, storage and invoking functions. Give a project the repository of the app that uses it and every Supabase screen follows the shell that is on that repository. Keys are typed once and never shown again; forgetting a project only removes it from this machine.')),
    Panel(host, { title: 'Where the keys are' }, h('p', { className: 'mlead', style: { margin: 0 } }, 'Management token: supabase.com/dashboard/account/tokens. Project keys: the project\'s Settings > API keys; the service role key is the secret one and bypasses row level security.')));
}

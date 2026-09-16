/**
 * Auth: the users, one selected on the right with identities, sessions, factors and what can
 * be done to them - invite, magic link, reset, ban, unban, sign out everywhere, delete.
 */
import { ago, num, withConfirm } from './helpers.js';
import { Panel, Stat, Health, List, ListRow, FILL } from './kit.js';
import { userRow } from './overview.js';

export function Users({ host, sb, project, overview, q, selected, onSelect }) {
  const { h, ui, notify } = host;
  const { useState, useEffect } = host.react;
  const [data, setData] = useState(null);
  const [page, setPage] = useState(1);
  const [invite, setInvite] = useState('');
  const [busy, setBusy] = useState(null);
  const [create, setCreate] = useState(null);
  const load = () => { setData(null); sb(`/auth/users?page=${page}&per_page=50`).then((d) => setData(d && Array.isArray(d.users) ? d : { users: [], error: (d && (d.error || d.message || d.msg)) || 'Could not read the users' })).catch((e) => setData({ users: [], error: e.message })); };
  useEffect(load, [page, project, selected && selected._bump]);
  const meta = (text) => h('span', { className: 'mpanel__meta' }, text);
  const empty = (text) => h('p', { className: 'mlead', style: { margin: 0 } }, text);
  const a = overview.data ? overview.data.auth : null;
  const list = (data ? data.users : []).filter((u) => !q || `${u.email || ''} ${u.phone || ''} ${u.id} ${JSON.stringify(u.user_metadata || {})}`.toLowerCase().includes(q));
  const sendInvite = async () => { if (!invite.trim()) return; setBusy('invite'); try { const r = await sb('/auth/invite', { method: 'POST', body: JSON.stringify({ email: invite.trim() }) }); if (r && (r.msg || r.error_description || r.message)) throw new Error(r.msg || r.error_description || r.message); notify(`Invited ${invite.trim()}`, 'moss'); setInvite(''); load(); } catch (e) { notify(e.message, 'rosin'); } finally { setBusy(null); } };
  const createUser = async () => { if (!create || !create.email.trim()) return; setBusy('create'); try { const body = { email: create.email.trim(), email_confirm: !!create.confirm }; if (create.password) body.password = create.password; const r = await sb('/auth/users', { method: 'POST', body: JSON.stringify(body) }); if (!r || !r.id) throw new Error((r && (r.msg || r.error_description || r.message)) || 'Could not create the user'); notify(`Created ${create.email.trim()}`, 'moss'); setCreate(null); load(); onSelect(r); } catch (e) { notify(e.message, 'rosin'); } finally { setBusy(null); } };
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--sy-s3)' } },
    h('div', { className: 'mstats mstats--head' },
      Stat(host, { label: 'Users', value: a ? num(a.total_users) : '...', tone: 'brass', hint: a ? `${a.confirmed} confirmed${a.anonymous ? `, ${a.anonymous} anonymous` : ''}` : undefined }),
      Stat(host, { label: 'Active this week', value: a ? num(a.active_7d) : '...', tone: 'moss', hint: a ? `${a.active_24h} today` : undefined }),
      Stat(host, { label: 'New this week', value: a ? num(a.signups_7d) : '...', tone: 'muted', hint: a ? `${a.signups_24h} today` : undefined }),
      Stat(host, { label: 'Banned', value: a ? num(a.banned) : '...', tone: a && a.banned ? 'rosin' : 'muted' })),
    Panel(host, { title: 'Invite or create', wide: true, action: meta('an invite sends an email; create makes the account now') },
      h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
        h(ui.Input, { value: invite, placeholder: 'email to invite', onChange: (e) => setInvite(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') sendInvite(); }, style: { flex: 1, minWidth: 220 } }),
        h(ui.Button, { variant: 'primary', disabled: busy === 'invite' || !invite.trim(), onClick: sendInvite }, busy === 'invite' ? 'Inviting...' : 'Invite'),
        h(ui.Button, { onClick: () => setCreate(create ? null : { email: '', password: '', confirm: true }) }, create ? 'Cancel' : 'Create a user')),
      create ? h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 } },
        h(ui.Input, { value: create.email, placeholder: 'email', onChange: (e) => setCreate({ ...create, email: e.target.value }), style: { flex: 1, minWidth: 200 } }),
        h(ui.Input, { type: 'password', value: create.password, placeholder: 'password (blank: none yet)', onChange: (e) => setCreate({ ...create, password: e.target.value }), style: { width: 220 } }),
        h(ui.Chip, { on: create.confirm, onClick: () => setCreate({ ...create, confirm: !create.confirm }) }, create.confirm ? 'email confirmed' : 'must confirm email'),
        h(ui.Button, { variant: 'primary', disabled: busy === 'create' || !create.email.trim(), onClick: createUser }, busy === 'create' ? 'Creating...' : 'Create')) : null),
    Panel(host, { title: 'Users', wide: true, action: h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } }, meta(data ? `page ${page}` : ''), page > 1 ? h(ui.Button, { className: 'sy-btn--sm', onClick: () => setPage(page - 1) }, 'Previous') : null, data && data.users.length === 50 ? h(ui.Button, { className: 'sy-btn--sm', onClick: () => setPage(page + 1) }, 'Next') : null) },
      !data ? h(ui.Skeleton, { count: 8, height: 18 }) : data.error ? empty(data.error) : list.length ? h('div', { style: { maxHeight: 640, overflow: 'auto', paddingRight: 14, scrollbarGutter: 'stable' } }, List(host, list.map((u) => ListRow(host, { key: u.id, lead: h('span', { className: 'mind-dot', style: { background: u.banned_until && new Date(u.banned_until) > new Date() ? 'var(--sy-rosin)' : u.email_confirmed_at || u.phone_confirmed_at ? 'var(--sy-moss)' : 'var(--sy-brass)' } }), label: u.email || u.phone || u.id, sub: `${(u.app_metadata && u.app_metadata.provider) || 'email'}${u.user_metadata && (u.user_metadata.full_name || u.user_metadata.name) ? ` - ${u.user_metadata.full_name || u.user_metadata.name}` : ''}${u.last_sign_in_at ? ` - seen ${ago(u.last_sign_in_at)}` : ' - never signed in'}${u.email_confirmed_at ? '' : ' - unconfirmed'}`, meta: u.created_at ? ago(u.created_at) : '', onClick: () => onSelect(u) })))) : empty(q ? 'Nothing matches on this page.' : 'No user yet.')));
}

export function UsersAside({ host, sb, project, selected, onChanged, onCleared }) {
  const { h, ui, notify } = host;
  const { useState, useEffect } = host.react;
  const [detail, setDetail] = useState(null);
  const [busy, setBusy] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [link, setLink] = useState(null);
  useEffect(() => { setDetail(null); setConfirm(null); setLink(null); if (selected) sb(`/auth/users/${encodeURIComponent(selected.id)}/detail`).then((d) => setDetail(Array.isArray(d) && d[0] ? d[0] : { error: 'No detail' })).catch((e) => setDetail({ error: e.message })); }, [selected && selected.id, selected && selected._bump, project]);
  const meta = (text) => h('span', { className: 'mpanel__meta' }, text);
  if (!selected) return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--sy-s3)' } }, Panel(host, { title: 'This user' }, h('p', { className: 'mlead', style: { margin: 0 } }, 'Pick a user to see how they sign in, their sessions and factors, send them a link, ban or delete them.')));
  const u = (detail && detail.user) || selected;
  const banned = u.banned_until && new Date(u.banned_until) > new Date();
  const act = async (label, fn) => { setBusy(label); try { const r = await fn(); if (r && (r.msg || r.error_description) && !r.id) throw new Error(r.msg || r.error_description); notify(`${label} done`, 'moss'); onChanged(); } catch (e) { notify(e.message, 'rosin'); } finally { setBusy(null); } };
  const put = (body) => sb(`/auth/users/${encodeURIComponent(u.id)}`, { method: 'PUT', body: JSON.stringify(body) });
  const genLink = async (type) => { setBusy(type); try { const r = await sb('/auth/generate-link', { method: 'POST', body: JSON.stringify({ type, email: u.email }) }); const url = r && (r.action_link || (r.properties && r.properties.action_link)); if (!url) throw new Error((r && (r.msg || r.error_description || r.message)) || 'No link came back'); setLink({ type, url }); } catch (e) { notify(e.message, 'rosin'); } finally { setBusy(null); } };
  const remove = async () => { setBusy('delete'); try { const r = await withConfirm((extra) => sb(`/auth/users/${encodeURIComponent(u.id)}?soft=1${extra ? `&${extra}` : ''}`, { method: 'DELETE' }), () => Promise.resolve(true)); if (r && (r.msg || r.error_description)) throw new Error(r.msg || r.error_description); notify('User deleted', 'moss'); onCleared(); onChanged(); } catch (e) { notify(e.message, 'rosin'); } finally { setBusy(null); setConfirm(null); } };
  const identities = (detail && detail.identities) || u.identities || [];
  const sessions = (detail && detail.sessions) || [];
  const factors = (detail && detail.mfa_factors) || [];
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--sy-s3)', flex: 1, minHeight: 0, height: '100%' } },
    Panel(host, { title: 'This user', action: meta(banned ? 'banned' : u.email_confirmed_at ? 'confirmed' : 'unconfirmed') },
      h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', marginBottom: 'var(--sy-s2)' } },
        u.user_metadata && (u.user_metadata.avatar_url || u.user_metadata.picture) ? h('img', { src: u.user_metadata.avatar_url || u.user_metadata.picture, alt: '', width: 36, height: 36, style: { borderRadius: '50%' } }) : h('span', { className: 'mind-dot', style: { width: 12, height: 12, background: banned ? 'var(--sy-rosin)' : 'var(--sy-moss)' } }),
        h('div', { style: { minWidth: 0 } }, h('div', { style: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, u.email || u.phone || u.id), h('div', { className: 'mpanel__meta' }, (u.user_metadata && (u.user_metadata.full_name || u.user_metadata.name)) || u.role || ''))),
      h(ui.InfoGrid, { items: [{ label: 'Id', value: u.id }, { label: 'Provider', value: (u.app_metadata && (u.app_metadata.providers || []).join(', ')) || 'email' }, { label: 'Created', value: u.created_at ? new Date(u.created_at).toLocaleString() : '-' }, { label: 'Last sign in', value: u.last_sign_in_at ? new Date(u.last_sign_in_at).toLocaleString() : 'never' }, { label: 'Confirmed', value: u.email_confirmed_at ? new Date(u.email_confirmed_at).toLocaleDateString() : 'no' }, { label: 'Role', value: u.role || '-' }] })),
    Panel(host, { title: 'Do', action: meta('links copy to the clipboard') },
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
        h(ui.Button, { className: 'sy-btn--sm', disabled: !!busy || !u.email, onClick: () => genLink('magiclink') }, busy === 'magiclink' ? '...' : 'Magic link'),
        h(ui.Button, { className: 'sy-btn--sm', disabled: !!busy || !u.email, onClick: () => genLink('recovery') }, busy === 'recovery' ? '...' : 'Reset link'),
        !u.email_confirmed_at ? h(ui.Button, { className: 'sy-btn--sm', disabled: !!busy, onClick: () => act('Confirm', () => put({ email_confirm: true })) }, 'Confirm email') : null,
        banned ? h(ui.Button, { className: 'sy-btn--sm', disabled: !!busy, onClick: () => act('Unban', () => put({ ban_duration: 'none' })) }, 'Unban') : h(ui.Button, { className: 'sy-btn--sm', disabled: !!busy, onClick: () => act('Ban', () => put({ ban_duration: '876000h' })) }, 'Ban'),
        h(ui.Button, { className: 'sy-btn--sm', disabled: !!busy, onClick: () => act('Sign out everywhere', () => sb(`/auth/users/${encodeURIComponent(u.id)}/sign-out`, { method: 'POST', body: '{}' })) }, 'Sign out everywhere'),
        confirm === 'delete' ? [h(ui.Button, { key: 'y', className: 'sy-btn--sm', disabled: !!busy, style: { color: 'var(--sy-rosin)' }, onClick: remove }, busy === 'delete' ? 'Deleting...' : 'Yes, delete'), h(ui.Button, { key: 'n', className: 'sy-btn--sm', onClick: () => setConfirm(null) }, 'Keep')] : h(ui.Button, { className: 'sy-btn--sm', disabled: !!busy, onClick: () => setConfirm('delete') }, 'Delete')),
      link ? h('div', { style: { marginTop: 8, display: 'flex', gap: 6, alignItems: 'center' } }, h('code', { className: 'mpanel__meta', style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: link.url }, link.url), h(ui.Button, { className: 'sy-btn--sm', onClick: () => navigator.clipboard.writeText(link.url).then(() => notify('Link copied', 'moss')).catch(() => {}) }, 'Copy')) : null),
    Panel(host, { title: 'Identities', action: meta(`${identities.length}`) }, identities.length ? List(host, identities.map((i) => ListRow(host, { key: i.id || i.provider, lead: h('span', { className: 'mind-dot', style: { background: 'var(--sy-moss)', width: 7, height: 7 } }), label: i.provider, sub: `${(i.identity_data && (i.identity_data.email || i.identity_data.name)) || ''}${i.last_sign_in_at ? ` - ${ago(i.last_sign_in_at)}` : ''}` }))) : h('p', { className: 'mlead', style: { margin: 0 } }, 'None.')),
    Panel(host, { title: 'Sessions and factors', ...FILL, action: meta(detail && !detail.error ? `${sessions.length} session${sessions.length === 1 ? '' : 's'}, ${factors.length} factor${factors.length === 1 ? '' : 's'}` : '...') },
      !detail ? h(ui.Skeleton, { count: 3, height: 14 }) : detail.error ? h('p', { className: 'mlead', style: { margin: 0 } }, detail.error) : h('div', null,
        sessions.length ? List(host, sessions.map((s) => ListRow(host, { key: s.id, lead: h('span', { className: 'mind-dot', style: { background: 'var(--sy-text-3)', width: 7, height: 7 } }), label: s.user_agent ? String(s.user_agent).slice(0, 60) : 'session', sub: `${s.ip || ''}${s.created_at ? ` - since ${ago(s.created_at)}` : ''}${s.refreshed_at ? ` - refreshed ${ago(s.refreshed_at)}` : ''}` }))) : h('p', { className: 'mlead', style: { margin: 0 } }, 'No open session.'),
        factors.length ? List(host, factors.map((f) => ListRow(host, { key: f.id, label: `${f.factor_type} - ${f.friendly_name || ''}`, sub: f.status, meta: h('button', { type: 'button', className: 'sy-btn sy-btn--sm', disabled: !!busy, onClick: () => act('Remove factor', () => sb(`/auth/users/${encodeURIComponent(u.id)}/factors/${encodeURIComponent(f.id)}`, { method: 'DELETE' })) }, 'Remove') }))) : null,
        detail.audit_events !== undefined ? h('p', { className: 'mpanel__meta', style: { margin: '8px 0 0' } }, `${detail.audit_events} audit events`) : null)));
}

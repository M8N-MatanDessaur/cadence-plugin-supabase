/**
 * Storage: the buckets and the files in them, folder by folder; one file selected on the
 * right with a signed link, a public link, move, delete; new buckets; empty or delete a bucket.
 */
import { ago, bytes, withConfirm } from './helpers.js';
import { Panel, Stat, Health, List, ListRow, FILL } from './kit.js';

const isImage = (m) => /^image\//.test(m || '');

export function Storage({ host, sb, project, overview, q, bucket, setBucket, selected, onSelect }) {
  const { h, ui, notify, tokens } = host;
  const { useState, useEffect } = host.react;
  const [buckets, setBuckets] = useState(null);
  const [prefix, setPrefix] = useState('');
  const [items, setItems] = useState(null);
  const [newBucket, setNewBucket] = useState(null);
  const [busy, setBusy] = useState(null);
  const loadBuckets = () => sb('/storage/buckets').then((d) => { const l = Array.isArray(d) ? d : []; setBuckets(l); if (!bucket && l[0]) setBucket(l[0].id); }).catch(() => setBuckets([]));
  useEffect(() => { setBuckets(null); loadBuckets(); }, [project]);
  useEffect(() => { setPrefix(''); }, [bucket]);
  const load = () => { if (!bucket) return; setItems(null); sb(`/storage/list/${encodeURIComponent(bucket)}`, { method: 'POST', body: JSON.stringify({ prefix, limit: 500, offset: 0, sortBy: { column: 'name', order: 'asc' } }) }).then((d) => setItems(Array.isArray(d) ? d : { error: (d && (d.error || d.message)) || 'Could not list' })).catch((e) => setItems({ error: e.message })); };
  useEffect(load, [bucket, prefix, project, selected && selected._bump]);
  const meta = (text) => h('span', { className: 'mpanel__meta' }, text);
  const empty = (text) => h('p', { className: 'mlead', style: { margin: 0 } }, text);
  const b = (buckets || []).find((x) => x.id === bucket) || null;
  const list = Array.isArray(items) ? items.filter((o) => !q || o.name.toLowerCase().includes(q)) : [];
  const folders = list.filter((o) => !o.id);
  const files = list.filter((o) => o.id);
  const s = overview.data ? overview.data.storage : null;
  const createBucket = async () => { if (!newBucket || !newBucket.name.trim()) return; setBusy('bucket'); try { const r = await sb('/storage/buckets', { method: 'POST', body: JSON.stringify({ id: newBucket.name.trim(), name: newBucket.name.trim(), public: !!newBucket.pub }) }); if (r && (r.error || r.message) && !r.name) throw new Error(r.message || r.error); notify(`Bucket ${newBucket.name.trim()} created`, 'moss'); setNewBucket(null); await loadBuckets(); setBucket(newBucket.name.trim()); } catch (e) { notify(e.message, 'rosin'); } finally { setBusy(null); } };
  const crumbs = prefix ? prefix.split('/').filter(Boolean) : [];
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--sy-s3)' } },
    h('div', { className: 'mstats mstats--head' },
      Stat(host, { label: 'Buckets', value: buckets ? buckets.length : '...', tone: 'brass', hint: buckets ? `${buckets.filter((x) => x.public).length} public` : undefined }),
      Stat(host, { label: 'Files', value: s ? s.objects : '...', tone: 'muted', hint: 'across the project' }),
      Stat(host, { label: 'Size', value: s ? bytes(s.bytes) : '...', tone: 'muted' }),
      Stat(host, { label: 'Here', value: items && !items.error ? `${files.length} file${files.length === 1 ? '' : 's'}` : '...', tone: 'muted', hint: items && !items.error ? `${folders.length} folder${folders.length === 1 ? '' : 's'}` : undefined })),
    Panel(host, { title: 'Buckets', wide: true, action: h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } }, h(ui.Button, { className: 'sy-btn--sm', onClick: () => setNewBucket(newBucket ? null : { name: '', pub: false }) }, newBucket ? 'Cancel' : 'New bucket')) },
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } }, buckets === null ? h(ui.Skeleton, { count: 1, height: 18 }) : buckets.length ? buckets.map((x) => h(ui.Chip, { key: x.id, on: x.id === bucket, onClick: () => { setBucket(x.id); onSelect(null); }, title: x.public ? 'public' : 'private' }, `${x.name}${x.public ? '' : ' (private)'}`)) : empty('No bucket yet.')),
      newBucket ? h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' } }, h(ui.Input, { value: newBucket.name, placeholder: 'bucket name (lowercase, dashes)', onChange: (e) => setNewBucket({ ...newBucket, name: e.target.value.toLowerCase() }), style: { width: 260 } }), h(ui.Chip, { on: newBucket.pub, onClick: () => setNewBucket({ ...newBucket, pub: !newBucket.pub }) }, newBucket.pub ? 'public: anyone with the URL' : 'private: signed links only'), h(ui.Button, { variant: 'primary', disabled: busy === 'bucket' || !newBucket.name.trim(), onClick: createBucket }, busy === 'bucket' ? 'Creating...' : 'Create')) : null),
    b ? Panel(host, { title: h('span', { style: { display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } }, h('button', { type: 'button', className: 'mpanel__title', style: { background: 'none', border: 0, cursor: 'pointer', padding: 0, color: prefix ? 'var(--sy-brass)' : undefined }, onClick: () => setPrefix('') }, b.name), ...crumbs.map((c, i) => h('span', { key: i, className: 'mpanel__title' }, '/ ', h('button', { type: 'button', className: 'mpanel__title', style: { background: 'none', border: 0, cursor: 'pointer', padding: 0, color: i < crumbs.length - 1 ? 'var(--sy-brass)' : undefined }, onClick: () => setPrefix(crumbs.slice(0, i + 1).join('/') + '/') }, c)))), wide: true, action: meta(items && !items.error ? `${list.length}` : '') },
      items === null ? h(ui.Skeleton, { count: 6, height: 18 }) : items.error ? empty(items.error) : !list.length ? empty(q ? 'Nothing matches.' : 'Empty.') : h('div', { style: { maxHeight: 600, overflow: 'auto', paddingRight: 14, scrollbarGutter: 'stable' } },
        folders.length ? List(host, folders.map((f) => ListRow(host, { key: `d-${f.name}`, lead: h(host.icons.list, { size: 13, style: { opacity: 0.7, flex: 'none' } }), label: `${f.name}/`, sub: 'folder', onClick: () => setPrefix(`${prefix}${f.name}/`) }))) : null,
        files.length ? h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10, marginTop: folders.length ? 10 : 0 } }, files.map((f) => { const mime = f.metadata && f.metadata.mimetype; const path = `${prefix}${f.name}`; const publicUrl = b.public ? `${overview.data ? overview.data.url : ''}/storage/v1/object/public/${encodeURIComponent(b.id)}/${path.split('/').map(encodeURIComponent).join('/')}` : ''; return h('button', { key: f.id, type: 'button', title: f.name, onClick: () => onSelect({ ...f, path, bucket: b.id, publicUrl }), style: { textAlign: 'left', padding: 0, border: `1px solid ${selected && selected.id === f.id ? 'var(--sy-brass)' : tokens('line')}`, borderRadius: 8, background: 'var(--sy-surface)', cursor: 'pointer', overflow: 'hidden', color: 'inherit', font: 'inherit' } },
          h('div', { style: { height: 96, background: 'rgba(255,255,255,0.03)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' } }, isImage(mime) && publicUrl ? h('img', { src: publicUrl, alt: '', loading: 'lazy', style: { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' } }) : h('span', { className: 'mpanel__meta' }, (mime || 'file').split('/').pop())),
          h('div', { style: { padding: '6px 8px' } }, h('div', { style: { fontSize: 'var(--sy-fs-sm)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, f.name), h('div', { className: 'mpanel__meta' }, `${bytes(f.metadata && f.metadata.size)}${f.updated_at ? ` - ${ago(f.updated_at)}` : ''}`))); })) : null)) : null);
}

export function StorageAside({ host, sb, project, bucket, selected, onChanged, onCleared }) {
  const { h, ui, notify } = host;
  const { useState, useEffect } = host.react;
  const [signed, setSigned] = useState(null);
  const [busy, setBusy] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [moveTo, setMoveTo] = useState('');
  useEffect(() => { setSigned(null); setConfirm(null); setMoveTo(selected ? selected.path : ''); }, [selected && selected.id]);
  const meta = (text) => h('span', { className: 'mpanel__meta' }, text);
  const [info, setInfo] = useState(null);
  useEffect(() => { setInfo(null); if (bucket) sb(`/storage/buckets/${encodeURIComponent(bucket)}`).then(setInfo).catch(() => setInfo(null)); }, [bucket, project]);
  const emptyBucket = async () => { setBusy('empty'); try { const r = await withConfirm((extra) => sb(`/storage/buckets/${encodeURIComponent(bucket)}/empty?soft=1${extra ? `&${extra}` : ''}`, { method: 'POST', body: '{}' }), () => Promise.resolve(true)); if (r && r.error) throw new Error(r.error); notify('Bucket emptied', 'moss'); onCleared(); onChanged(); } catch (e) { notify(e.message, 'rosin'); } finally { setBusy(null); setConfirm(null); } };
  const deleteBucket = async () => { setBusy('delbucket'); try { const r = await sb(`/storage/buckets/${encodeURIComponent(bucket)}`, { method: 'DELETE' }); if (r && r.error && !r.message) throw new Error(r.error); if (r && r.statusCode && Number(r.statusCode) >= 400) throw new Error(r.message || r.error); notify('Bucket deleted', 'moss'); onCleared(); onChanged(); } catch (e) { notify(e.message, 'rosin'); } finally { setBusy(null); setConfirm(null); } };
  if (!selected) return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--sy-s3)' } },
    Panel(host, { title: 'This bucket', action: meta(info ? info.public ? 'public' : 'private' : '') }, info ? h('div', null, h(ui.InfoGrid, { items: [{ label: 'Name', value: info.name }, { label: 'Access', value: info.public ? 'public' : 'private' }, { label: 'File size limit', value: info.file_size_limit ? bytes(info.file_size_limit) : 'none' }, { label: 'Allowed types', value: (info.allowed_mime_types || []).join(', ') || 'any' }, { label: 'Created', value: info.created_at ? new Date(info.created_at).toLocaleDateString() : '-' }] }), h('div', { style: { display: 'flex', gap: 6, marginTop: 'var(--sy-s2)', flexWrap: 'wrap' } }, confirm === 'empty' ? [h(ui.Button, { key: 'y', className: 'sy-btn--sm', style: { color: 'var(--sy-rosin)' }, disabled: !!busy, onClick: emptyBucket }, busy === 'empty' ? 'Emptying...' : 'Yes, delete every file'), h(ui.Button, { key: 'n', className: 'sy-btn--sm', onClick: () => setConfirm(null) }, 'Keep')] : h(ui.Button, { className: 'sy-btn--sm', disabled: !!busy, onClick: () => setConfirm('empty') }, 'Empty the bucket'), confirm === 'delete' ? [h(ui.Button, { key: 'y2', className: 'sy-btn--sm', style: { color: 'var(--sy-rosin)' }, disabled: !!busy, onClick: deleteBucket }, busy === 'delbucket' ? 'Deleting...' : 'Yes, delete the bucket'), h(ui.Button, { key: 'n2', className: 'sy-btn--sm', onClick: () => setConfirm(null) }, 'Keep')] : h(ui.Button, { className: 'sy-btn--sm', disabled: !!busy, onClick: () => setConfirm('delete') }, 'Delete the bucket'))) : h('p', { className: 'mlead', style: { margin: 0 } }, bucket ? 'Reading...' : 'Pick a bucket. A file shows its links and actions here.')));
  const sign = async () => { setBusy('sign'); try { const r = await sb(`/storage/sign/${encodeURIComponent(selected.bucket)}/${selected.path.split('/').map(encodeURIComponent).join('/')}`, { method: 'POST', body: JSON.stringify({ expiresIn: 3600 }) }); const url = r && r.signedURL ? `${(await sb('/config')).active.url}/storage/v1${r.signedURL}` : null; if (!url) throw new Error((r && (r.error || r.message)) || 'No link came back'); setSigned(url); } catch (e) { notify(e.message, 'rosin'); } finally { setBusy(null); } };
  const remove = async () => { setBusy('delete'); try { const r = await sb(`/storage/objects/${encodeURIComponent(selected.bucket)}`, { method: 'DELETE', body: JSON.stringify({ prefixes: [selected.path] }) }); if (r && r.error && !Array.isArray(r)) throw new Error(r.error); notify('File deleted', 'moss'); onCleared(); onChanged(); } catch (e) { notify(e.message, 'rosin'); } finally { setBusy(null); setConfirm(null); } };
  const move = async () => { if (!moveTo.trim() || moveTo.trim() === selected.path) return; setBusy('move'); try { const r = await sb('/storage/move', { method: 'POST', body: JSON.stringify({ bucketId: selected.bucket, sourceKey: selected.path, destinationKey: moveTo.trim() }) }); if (r && r.error) throw new Error(r.error); notify('Moved', 'moss'); onCleared(); onChanged(); } catch (e) { notify(e.message, 'rosin'); } finally { setBusy(null); } };
  const mime = selected.metadata && selected.metadata.mimetype;
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--sy-s3)', flex: 1, minHeight: 0, height: '100%' } },
    Panel(host, { title: 'This file', action: selected.publicUrl ? h('a', { className: 'mpanel__meta', href: selected.publicUrl, target: '_blank', rel: 'noreferrer' }, 'open') : meta('private') },
      isImage(mime) && selected.publicUrl ? h('img', { src: selected.publicUrl, alt: '', style: { width: '100%', maxHeight: 180, objectFit: 'contain', borderRadius: 6, background: 'rgba(255,255,255,0.03)', marginBottom: 'var(--sy-s2)' } }) : null,
      h(ui.InfoGrid, { items: [{ label: 'Path', value: selected.path }, { label: 'Type', value: mime || '-' }, { label: 'Size', value: bytes(selected.metadata && selected.metadata.size) }, { label: 'Updated', value: selected.updated_at ? new Date(selected.updated_at).toLocaleString() : '-' }, { label: 'Id', value: selected.id }] })),
    Panel(host, { title: 'Links' },
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        selected.publicUrl ? h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } }, h('code', { className: 'mpanel__meta', style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: selected.publicUrl }, selected.publicUrl), h(ui.Button, { className: 'sy-btn--sm', onClick: () => navigator.clipboard.writeText(selected.publicUrl).then(() => notify('Public link copied', 'moss')).catch(() => {}) }, 'Copy')) : null,
        h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } }, h(ui.Button, { className: 'sy-btn--sm', disabled: busy === 'sign', onClick: sign }, busy === 'sign' ? '...' : 'Signed link, 1 hour'), signed ? h(ui.Button, { className: 'sy-btn--sm', onClick: () => navigator.clipboard.writeText(signed).then(() => notify('Signed link copied', 'moss')).catch(() => {}) }, 'Copy it') : null),
        signed ? h('code', { className: 'mpanel__meta', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: signed }, signed) : null)),
    Panel(host, { title: 'Move or rename' }, h('div', { style: { display: 'flex', gap: 6 } }, h(ui.Input, { value: moveTo, onChange: (e) => setMoveTo(e.target.value), style: { flex: 1 } }), h(ui.Button, { className: 'sy-btn--sm', disabled: busy === 'move' || !moveTo.trim() || moveTo.trim() === selected.path, onClick: move }, busy === 'move' ? '...' : 'Move'))),
    Panel(host, { title: 'Delete', action: meta('permanent') }, h('div', { style: { display: 'flex', gap: 6 } }, confirm === 'file' ? [h(ui.Button, { key: 'y', disabled: !!busy, onClick: remove, style: { color: 'var(--sy-rosin)' } }, busy === 'delete' ? 'Deleting...' : 'Yes, delete it'), h(ui.Button, { key: 'n', className: 'sy-btn--sm', onClick: () => setConfirm(null) }, 'Keep it')] : h(ui.Button, { onClick: () => setConfirm('file') }, 'Delete the file'))));
}

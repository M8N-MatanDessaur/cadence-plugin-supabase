/**
 * The rows of a table, through PostgREST: a page at a time, filtered and sorted, each cell
 * editable in place (the primary key finds the row), a row added from a form, a row deleted.
 * Everything writes with the service role, so RLS does not stand in the way here.
 */
import { cell, withConfirm } from './helpers.js';

const OPS = [['eq', '='], ['neq', '!='], ['gt', '>'], ['gte', '>='], ['lt', '<'], ['lte', '<='], ['like', 'like'], ['ilike', 'ilike'], ['is', 'is']];
const parse = (raw, type) => {
  const s = String(raw);
  if (s === '' ) return null;
  if (/^(null)$/i.test(s)) return null;
  if (/^(bool|boolean)$/i.test(type)) return /^(t|true|1|yes)$/i.test(s);
  if (/^(int|bigint|smallint|integer|numeric|decimal|real|double|float)/i.test(type)) return Number(s);
  if (/^(json|jsonb|.*\[\])$/i.test(type)) { try { return JSON.parse(s); } catch { return s; } }
  return s;
};
const show = (v) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

export function Rows({ host, sb, project, schema, table, columns, pk, onChanged }) {
  const { h, ui, notify, tokens } = host;
  const { useState, useEffect, useMemo } = host.react;
  const [data, setData] = useState(null);
  const [page, setPage] = useState(0);
  const [size, setSize] = useState(50);
  const [sort, setSort] = useState({ col: pk[0] || (columns[0] && columns[0].name) || '', dir: 'asc' });
  const [filter, setFilter] = useState({ col: (columns[0] && columns[0].name) || '', op: 'eq', value: '' });
  const [applied, setApplied] = useState(null);
  const [edit, setEdit] = useState(null); // { key, col, value }
  const [adding, setAdding] = useState(null); // { [col]: text }
  const [busy, setBusy] = useState(null);
  const [wide, setWide] = useState(false);
  const canEdit = pk.length > 0;
  const keyOf = (row) => pk.map((k) => `${k}=eq.${encodeURIComponent(show(row[k]))}`).join('&');
  const load = () => {
    setData(null);
    const qs = new URLSearchParams();
    qs.set('select', '*'); qs.set('limit', String(size)); qs.set('offset', String(page * size)); qs.set('_meta', '1'); qs.set('_schema', schema);
    if (sort.col) qs.set('order', `${sort.col}.${sort.dir}.nullslast`);
    if (applied && applied.col) qs.set(applied.col, `${applied.op}.${applied.op === 'is' ? applied.value : applied.op === 'like' || applied.op === 'ilike' ? `*${applied.value}*` : applied.value}`);
    sb(`/rows/${encodeURIComponent(table)}?${qs.toString()}`).then((d) => setData(d && d.rows ? d : { rows: [], total: 0, error: (d && (d.error || d.message)) || 'Could not read the rows' })).catch((e) => setData({ rows: [], total: 0, error: e.message }));
  };
  useEffect(load, [table, schema, page, size, sort.col, sort.dir, applied, project]);
  const rows = data ? data.rows : [];
  const total = data && data.total !== null ? data.total : rows.length;
  const cols = useMemo(() => columns.map((c) => c.name), [columns]);
  const typeOf = (name) => (columns.find((c) => c.name === name) || {}).type || 'text';

  const save = async () => {
    if (!edit) return;
    const row = rows.find((r) => keyOf(r) === edit.key); if (!row) return setEdit(null);
    const value = parse(edit.value, typeOf(edit.col));
    if (show(value) === show(row[edit.col])) return setEdit(null);
    setBusy('save');
    try { const r = await sb(`/rows/${encodeURIComponent(table)}?${edit.key}&_schema=${encodeURIComponent(schema)}`, { method: 'PATCH', body: JSON.stringify({ [edit.col]: value }) }); if (r && r.message && !Array.isArray(r)) throw new Error(r.message); notify('Saved', 'moss'); setEdit(null); load(); onChanged(); }
    catch (e) { notify(e.message, 'rosin'); } finally { setBusy(null); }
  };
  const insert = async () => {
    const body = {};
    for (const [k, v] of Object.entries(adding || {})) if (String(v).trim() !== '') body[k] = parse(v, typeOf(k));
    setBusy('insert');
    try { const r = await sb(`/rows/${encodeURIComponent(table)}?_schema=${encodeURIComponent(schema)}`, { method: 'POST', body: JSON.stringify(body) }); if (r && r.message && !Array.isArray(r)) throw new Error(r.message); notify('Row added', 'moss'); setAdding(null); load(); onChanged(); }
    catch (e) { notify(e.message, 'rosin'); } finally { setBusy(null); }
  };
  const remove = async (row) => {
    setBusy(`del-${keyOf(row)}`);
    try { const r = await sb(`/rows/${encodeURIComponent(table)}?${keyOf(row)}&_schema=${encodeURIComponent(schema)}`, { method: 'DELETE' }); if (r && r.message && !Array.isArray(r)) throw new Error(r.message); notify('Row deleted', 'moss'); load(); onChanged(); }
    catch (e) { notify(e.message, 'rosin'); } finally { setBusy(null); }
  };

  const th = (name) => h('th', { key: name, onClick: () => setSort({ col: name, dir: sort.col === name && sort.dir === 'asc' ? 'desc' : 'asc' }), style: { cursor: 'pointer', whiteSpace: 'nowrap' }, title: `${typeOf(name)} - click to sort` }, name, sort.col === name ? h('span', { className: 'mpanel__meta', style: { marginLeft: 4 } }, sort.dir === 'asc' ? 'up' : 'down') : null, pk.includes(name) ? h('span', { className: 'mpanel__meta', style: { marginLeft: 4 } }, 'pk') : null);
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, flex: 1, minHeight: 0 } },
    h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
      h(ui.Select, { value: filter.col, onChange: (e) => setFilter({ ...filter, col: e.target.value }), style: { width: 150 }, 'aria-label': 'Filter column' }, cols.map((c) => h('option', { key: c, value: c }, c))),
      h(ui.Select, { value: filter.op, onChange: (e) => setFilter({ ...filter, op: e.target.value }), style: { width: 84 }, 'aria-label': 'Operator' }, OPS.map(([k, l]) => h('option', { key: k, value: k }, l))),
      h(ui.Input, { value: filter.value, placeholder: filter.op === 'is' ? 'null | true | false' : 'value', onChange: (e) => setFilter({ ...filter, value: e.target.value }), onKeyDown: (e) => { if (e.key === 'Enter') { setPage(0); setApplied({ ...filter }); } }, style: { width: 180 } }),
      h(ui.Button, { className: 'sy-btn--sm', onClick: () => { setPage(0); setApplied({ ...filter }); } }, 'Filter'),
      applied ? h(ui.Button, { className: 'sy-btn--sm', onClick: () => { setApplied(null); setPage(0); } }, 'Clear') : null,
      h('span', { style: { flex: 1 } }),
      h('span', { className: 'mpanel__meta' }, data ? `${total ? page * size + 1 : 0}-${page * size + rows.length} of ${total === null ? '?' : total.toLocaleString()}` : '...'),
      h(ui.Select, { value: String(size), onChange: (e) => { setSize(Number(e.target.value)); setPage(0); }, style: { width: 70 }, 'aria-label': 'Page size' }, [25, 50, 100, 200].map((n) => h('option', { key: n, value: String(n) }, n))),
      page > 0 ? h(ui.Button, { className: 'sy-btn--sm', onClick: () => setPage(page - 1) }, 'Previous') : null,
      (page + 1) * size < (total || 0) ? h(ui.Button, { className: 'sy-btn--sm', onClick: () => setPage(page + 1) }, 'Next') : null,
      h(ui.Chip, { on: wide, onClick: () => setWide(!wide), title: 'Show full cell values' }, wide ? 'full cells' : 'short cells'),
      h(ui.Button, { className: 'sy-btn--sm', variant: adding ? undefined : 'primary', onClick: () => setAdding(adding ? null : Object.fromEntries(cols.filter((c) => !pk.includes(c) || !/uuid|serial|identity/i.test(typeOf(c) + ((columns.find((x) => x.name === c) || {}).default_value || ''))).map((c) => [c, ''])) ) }, adding ? 'Cancel' : 'Add a row')),
    adding ? h('div', { style: { padding: 10, border: `1px solid ${tokens('line')}`, borderRadius: 8, background: 'var(--sy-surface)' } },
      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 } }, Object.keys(adding).map((c) => h('label', { key: c, style: { display: 'flex', flexDirection: 'column', gap: 3, fontSize: 'var(--sy-fs-xs)', color: 'var(--sy-text-3)' } }, `${c} (${typeOf(c)})${(columns.find((x) => x.name === c) || {}).not_null && !(columns.find((x) => x.name === c) || {}).default_value ? ' *' : ''}`, h(ui.Input, { value: adding[c], placeholder: (columns.find((x) => x.name === c) || {}).default_value ? 'default' : '', onChange: (e) => setAdding({ ...adding, [c]: e.target.value }) })))),
      h('div', { style: { display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' } }, h('span', { className: 'mpanel__meta' }, 'Blank fields take their default. JSON and arrays as JSON.'), h('span', { style: { flex: 1 } }), h(ui.Button, { className: 'sy-btn--sm', variant: 'primary', disabled: busy === 'insert', onClick: insert }, busy === 'insert' ? 'Adding...' : 'Add the row'))) : null,
    !canEdit ? h('p', { className: 'mlead', style: { margin: 0 } }, 'This table has no primary key, so rows are read-only here.') : null,
    h('div', { style: { flex: 1, minHeight: 0, overflow: 'auto', paddingRight: 14, scrollbarGutter: 'stable', border: `1px solid ${tokens('line')}`, borderRadius: 8 } },
      !data ? h('div', { style: { padding: 12 } }, h(ui.Skeleton, { count: 8, height: 18 })) : data.error ? h('p', { className: 'mlead', style: { margin: 12, color: 'var(--sy-rosin)' } }, data.error) : !rows.length ? h('p', { className: 'mlead', style: { margin: 12 } }, applied ? 'No row matches.' : 'No row.') :
        h('table', { className: `sb-table sb-table--rows${wide ? ' sb-table--wide' : ''}` },
          h('thead', null, h('tr', null, cols.map(th), canEdit ? h('th', { key: '_a' }, '') : null)),
          h('tbody', null, rows.map((row) => { const key = keyOf(row); return h('tr', { key },
            cols.map((c) => { const editing = edit && edit.key === key && edit.col === c; return h('td', { key: c, title: editing ? undefined : show(row[c]), onDoubleClick: canEdit && !pk.includes(c) ? () => setEdit({ key, col: c, value: show(row[c]) }) : undefined, style: { cursor: canEdit && !pk.includes(c) ? 'text' : undefined, color: row[c] === null ? 'var(--sy-text-3)' : undefined, fontStyle: row[c] === null ? 'italic' : undefined } },
              editing ? h('input', { autoFocus: true, className: 'sy-input', value: edit.value, style: { width: '100%', minWidth: 120, height: 24, padding: '0 6px', font: 'inherit' }, onChange: (e) => setEdit({ ...edit, value: e.target.value }), onBlur: save, onKeyDown: (e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEdit(null); } }) : (wide ? show(row[c]) || (row[c] === null ? 'null' : '') : cell(row[c], 60))); }),
            canEdit ? h('td', { key: '_a', style: { whiteSpace: 'nowrap' } }, h('button', { type: 'button', className: 'sy-btn sy-btn--sm', disabled: !!busy, title: 'Delete this row', onClick: () => { if (window.confirm('Delete this row?')) remove(row); } }, busy === `del-${key}` ? '...' : 'Delete')) : null); })))),
    canEdit ? h('p', { className: 'mpanel__meta', style: { margin: 0 } }, 'Double-click a cell to edit it; Enter saves, Escape cancels. Writes use the service role and bypass RLS.') : null);
}

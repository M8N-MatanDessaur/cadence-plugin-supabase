/**
 * Supabase Plugin -- Server-side API Routes
 *
 * Proxies four Supabase APIs:
 *   1. Management API  -- https://api.supabase.com          (requires Personal Access Token)
 *   2. PostgREST       -- https://<ref>.supabase.co/rest/v1 (per-project service_role key)
 *   3. GoTrue / Auth   -- https://<ref>.supabase.co/auth/v1 (per-project service_role key)
 *   4. Storage         -- https://<ref>.supabase.co/storage/v1 (per-project service_role key)
 *   5. Edge Functions  -- https://<ref>.supabase.co/functions/v1 (per-project service_role key)
 *
 * Config shape:
 *   {
 *     managementToken: "sbp_...",            // global PAT, used by all projects
 *     projects: [
 *       { name, projectRef, serviceRoleKey, anonKey, url, repoPath }
 *     ],
 *     activeProject: "Project Name"
 *   }
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const configPath = path.join(__dirname, 'config.json');
const MANAGEMENT_HOST = 'api.supabase.com';

// -- Config helpers ----------------------------------------------------------

function readCfg() {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return {
      managementToken: raw.managementToken || '',
      projects: Array.isArray(raw.projects) ? raw.projects : [],
      activeProject: raw.activeProject || '',
    };
  } catch (_) {
    return { managementToken: '', projects: [], activeProject: '' };
  }
}

function saveCfg(cfg) {
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
}

// The project a request asked for by name or by repository path; set at the top of the request
// handler and read synchronously by getActiveProject() before the handler's first await.
let requestProject = null;
const normPath = (v) => String(v || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
function projectForRepo(c, repoPath) {
  const want = normPath(repoPath);
  if (!want) return null;
  return c.projects.find(p => p.repoPath && normPath(p.repoPath) === want)
    || c.projects.find(p => p.repoPath && (want.startsWith(normPath(p.repoPath) + '/') || normPath(p.repoPath).startsWith(want + '/')))
    || null;
}
function sqlLiteral(v) { return `'${String(v).replace(/'/g, "''")}'`; }
function getActiveProject(cfg) {
  const c = cfg || readCfg();
  if (!c.projects.length) return null;
  if (requestProject) {
    const byName = c.projects.find(p => p.name === requestProject.name);
    if (byName) return byName;
    const byRepo = projectForRepo(c, requestProject.repo);
    if (byRepo) return byRepo;
  }
  return c.projects.find(p => p.name === c.activeProject) || c.projects[0];
}
const overviewCache = new Map();

function hasPat() {
  return !!readCfg().managementToken;
}

function isProjectConfigured(p) {
  return !!(p && p.projectRef && p.serviceRoleKey && p.url);
}

function projectRestUrl(p, extra) {
  const base = String(p.url || `https://${p.projectRef}.supabase.co`).replace(/\/+$/, '');
  return base + (extra || '');
}

// -- HTTPS helper ------------------------------------------------------------

function httpsReq(urlStr, options, body) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlStr); } catch (e) { return reject(e); }
    const opts = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      port: url.port || 443,
      method: (options && options.method) || 'GET',
      headers: Object.assign({}, (options && options.headers) || {}),
    };
    const req = https.request(opts, (resp) => {
      const chunks = [];
      resp.on('data', c => chunks.push(c));
      resp.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        let data;
        try { data = JSON.parse(text); } catch (_) { data = text; }
        resolve({ status: resp.statusCode, data, headers: resp.headers, raw: buf });
      });
    });
    req.on('error', reject);
    if (body !== undefined && body !== null) {
      if (Buffer.isBuffer(body)) req.write(body);
      else if (typeof body === 'string') req.write(body);
      else req.write(JSON.stringify(body));
    }
    req.end();
  });
}

function managementHeaders(cfg) {
  return {
    'Authorization': `Bearer ${cfg.managementToken}`,
    'Content-Type': 'application/json',
    'User-Agent': 'Cadence-Supabase-Plugin',
  };
}

function projectHeaders(p, extra) {
  return Object.assign({
    'apikey': p.serviceRoleKey,
    'Authorization': `Bearer ${p.serviceRoleKey}`,
    'Content-Type': 'application/json',
    'User-Agent': 'Cadence-Supabase-Plugin',
  }, extra || {});
}

// Management API: POST /v1/projects/{ref}/database/query -> runs raw SQL.
async function runSql(cfg, projectRef, sql, opts) {
  opts = opts || {};
  const url = `https://${MANAGEMENT_HOST}/v1/projects/${projectRef}/database/query`;
  const body = { query: sql };
  if (opts.readOnly) body.read_only = true;
  const r = await httpsReq(url, {
    method: 'POST',
    headers: managementHeaders(cfg),
  }, body);
  return r;
}

// -- SQL safety classifier + confirm-token store -----------------------------

const DESTRUCTIVE_PATTERNS = [
  /\bdrop\s+(?:table|schema|database|view|index|sequence|function|trigger|role|type|extension|policy|materialized\s+view)\b/i,
  /\btruncate\b/i,
  /\bdelete\s+from\s+[^;]*$/i, // DELETE FROM ... with no WHERE on the statement
  /\balter\s+(?:table|schema|database)\b[^;]*\bdrop\b/i,
];

function classifySql(sql) {
  const normalized = String(sql || '').replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const statements = normalized.split(';').map(s => s.trim()).filter(Boolean);
  const destructive = [];
  for (const stmt of statements) {
    const lower = stmt.toLowerCase();
    // DELETE without WHERE is destructive; with WHERE it's fine.
    if (/^\s*delete\s+from\b/.test(lower) && !/\bwhere\b/.test(lower)) {
      destructive.push({ kind: 'DELETE_NO_WHERE', statement: stmt });
      continue;
    }
    if (/^\s*truncate\b/.test(lower)) {
      destructive.push({ kind: 'TRUNCATE', statement: stmt });
      continue;
    }
    if (/^\s*drop\s+/.test(lower)) {
      destructive.push({ kind: 'DROP', statement: stmt });
      continue;
    }
    if (/^\s*alter\s+/.test(lower) && /\bdrop\b/.test(lower)) {
      destructive.push({ kind: 'ALTER_DROP', statement: stmt });
      continue;
    }
  }
  return { destructive, statements };
}

const pendingConfirms = new Map(); // token -> { kind, payload, expires }
const CONFIRM_TTL_MS = 10 * 60 * 1000;

function issueConfirmToken(kind, payload) {
  const token = crypto.randomBytes(12).toString('hex');
  pendingConfirms.set(token, { kind, payload, expires: Date.now() + CONFIRM_TTL_MS });
  return token;
}

function consumeConfirmToken(token, kind) {
  const entry = pendingConfirms.get(token);
  if (!entry) return null;
  if (entry.kind !== kind) return null;
  if (Date.now() > entry.expires) { pendingConfirms.delete(token); return null; }
  pendingConfirms.delete(token);
  return entry.payload;
}

// Cleanup expired tokens opportunistically
function sweepConfirms() {
  const now = Date.now();
  for (const [k, v] of pendingConfirms) if (v.expires < now) pendingConfirms.delete(k);
}

// -- URL / path helpers ------------------------------------------------------

function q(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

function ident(s) {
  return '"' + String(s).replace(/"/g, '""') + '"';
}

// Returns "\"schema\".\"table\"" or just "\"table\"" if schema is omitted.
function qualified(schema, table) {
  return schema ? `${ident(schema)}.${ident(table)}` : ident(table);
}

// -- Route Registration ------------------------------------------------------


// ---- Attention: what the Plugins home shows on this app's tile. Reads the plugin's own
// routes over loopback (they carry their caches), never writes, answers within a minute.
const __attention = { value: null, until: 0 };
function __selfGet(req, path, timeoutMs) {
  return new Promise((resolve) => {
    const host = req.headers.host || `127.0.0.1:${process.env.CADENCE_PORT || 3801}`;
    const lib = require('http');
    const r = lib.get({ host: host.split(':')[0], port: Number(host.split(':')[1] || 80), path, headers: { 'x-cadence-internal': '1' } }, (resp) => { let d = ''; resp.on('data', (c) => { d += c; }); resp.on('end', () => { try { resolve(resp.statusCode < 400 ? JSON.parse(d) : null); } catch (_) { resolve(null); } }); });
    r.on('error', () => resolve(null));
    r.setTimeout(timeoutMs || 45000, () => { r.destroy(); resolve(null); });
  });
}
function __attentionOut(items) {
  const rank = { error: 3, warn: 2, warning: 2, info: 1 };
  const list = (items || []).filter((i) => i && i.text).map((i) => ({ level: i.level === 'warning' ? 'warn' : (i.level || 'info'), text: String(i.text) }));
  const level = list.reduce((top, i) => (rank[i.level] > rank[top] ? i.level : top), list.length ? 'info' : 'ok');
  return { count: list.length, level, items: list, readAt: new Date().toISOString() };
}
async function __attentionHandler(req, res, url, compute, json) {
  if (__attention.value && __attention.until > Date.now() && url.searchParams.get('refresh') !== '1') return json(res, __attention.value);
  let out;
  try { out = __attentionOut(await compute(req)); } catch (e) { out = { count: 0, level: 'ok', items: [], error: e.message, readAt: new Date().toISOString() }; }
  __attention.value = out; __attention.until = Date.now() + 60000;
  return json(res, out);
}

module.exports = function ({ addRoute, addPrefixRoute, json, readBody, shell }) {
  addRoute('GET', '/attention', (req, res, url) => __attentionHandler(req, res, url, async (req) => { const o = await __selfGet(req, '/api/plugins/supabase/overview', 90000); return (o && o.issues || []).map((i) => ({ level: i.level, text: i.text })); }, json));
  const permGate = shell && typeof shell.permGate === 'function' ? shell.permGate : null;
  const gate = async (res, route, label) => (permGate ? permGate(res, 'api', route, label) : true);

  addPrefixRoute(async (req, res, url, subpath) => {
    const method = req.method;
    sweepConfirms();
    // The workbench's fetch throws on 409 and drops the body, so a screen asks for a soft answer: the
    // same confirm payload with a 200, and it does the retry with the token itself.
    const soft409 = url.searchParams.get('soft') === '1' ? 200 : 409;
    requestProject = (url.searchParams.get('project') || url.searchParams.get('repo')) ? { name: url.searchParams.get('project') || '', repo: url.searchParams.get('repo') || '' } : null;

    try {
      // =====================================================================
      // CONFIG & PROJECTS
      // =====================================================================

      if (subpath === '/config' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        return json(res, {
          managementTokenSet: !!cfg.managementToken,
          activeProject: cfg.activeProject || '',
          projectCount: cfg.projects.length,
          active: active ? {
            name: active.name,
            projectRef: active.projectRef,
            url: active.url,
            serviceRoleKeySet: !!active.serviceRoleKey,
            anonKeySet: !!active.anonKey,
            repoPath: active.repoPath || '',
          } : null,
        });
      }

      if (subpath === '/config' && method === 'POST') {
        const body = await readBody(req);
        const cfg = readCfg();
        // A blank token keeps the stored one.
        if (body.managementToken !== undefined && String(body.managementToken || '').trim()) cfg.managementToken = String(body.managementToken).trim();
        saveCfg(cfg);
        return json(res, { ok: true });
      }

      if (subpath === '/projects' && method === 'GET') {
        const cfg = readCfg();
        return json(res, {
          projects: cfg.projects.map(p => ({
            name: p.name,
            projectRef: p.projectRef,
            url: p.url,
            serviceRoleKeySet: !!p.serviceRoleKey,
            anonKeySet: !!p.anonKey,
            repoPath: p.repoPath || '',
          })),
          activeProject: cfg.activeProject,
          managementTokenSet: !!cfg.managementToken,
        });
      }

      if (subpath === '/projects' && method === 'POST') {
        const body = await readBody(req);
        if (!body.name || !body.projectRef) {
          return json(res, { error: 'name and projectRef are required' }, 400);
        }
        const cfg = readCfg();
        const name = String(body.name).trim();
        if (cfg.projects.find(p => p.name === name)) {
          return json(res, { error: 'A project with that name already exists' }, soft409);
        }
        cfg.projects.push({
          name,
          projectRef: String(body.projectRef).trim(),
          serviceRoleKey: String(body.serviceRoleKey || '').trim(),
          anonKey: String(body.anonKey || '').trim(),
          url: String(body.url || `https://${body.projectRef}.supabase.co`).trim().replace(/\/+$/, ''),
          repoPath: body.repoPath ? String(body.repoPath).trim().replace(/\/+$/, '') : '',
        });
        if (!cfg.activeProject) cfg.activeProject = name;
        saveCfg(cfg);
        return json(res, { ok: true });
      }

      if (subpath === '/projects/active' && method === 'POST') {
        const body = await readBody(req);
        if (!body.name) return json(res, { error: 'name is required' }, 400);
        const cfg = readCfg();
        if (!cfg.projects.find(p => p.name === body.name)) {
          return json(res, { error: 'Project not found' }, 404);
        }
        cfg.activeProject = body.name;
        saveCfg(cfg);
        return json(res, { ok: true, activeProject: body.name });
      }

      const projByName = subpath.match(/^\/projects\/([^/]+)$/);
      if (projByName && projByName[1] !== 'active' && (method === 'PUT' || method === 'PATCH')) {
        const target = decodeURIComponent(projByName[1]);
        const cfg = readCfg();
        const idx = cfg.projects.findIndex(p => p.name === target);
        if (idx < 0) return json(res, { error: 'Project not found' }, 404);
        const body = await readBody(req);
        if (body.name !== undefined) {
          const newName = String(body.name).trim();
          if (newName !== target && cfg.projects.find(p => p.name === newName)) {
            return json(res, { error: 'Name already used' }, soft409);
          }
          if (cfg.activeProject === target) cfg.activeProject = newName;
          cfg.projects[idx].name = newName;
        }
        ['projectRef', 'serviceRoleKey', 'anonKey', 'url', 'repoPath'].forEach(k => {
          if (body[k] === undefined) return;
          // A blank key keeps the stored one; the form never has to show it.
          if ((k === 'serviceRoleKey' || k === 'anonKey') && !String(body[k] || '').trim()) return;
          cfg.projects[idx][k] = String(body[k] || '').trim().replace(/\/+$/, '');
        });
        saveCfg(cfg);
        overviewCache.clear();
        return json(res, { ok: true });
      }

      if (projByName && projByName[1] !== 'active' && method === 'DELETE') {
        const target = decodeURIComponent(projByName[1]);
        const cfg = readCfg();
        const idx = cfg.projects.findIndex(p => p.name === target);
        if (idx < 0) return json(res, { error: 'Project not found' }, 404);
        if (!(await gate(res, 'DELETE /api/plugins/supabase/projects', `Forget the Supabase project ${target}`))) return;
        cfg.projects.splice(idx, 1);
        if (cfg.activeProject === target) cfg.activeProject = cfg.projects[0] ? cfg.projects[0].name : '';
        saveCfg(cfg);
        return json(res, { ok: true, activeProject: cfg.activeProject });
      }

      // =====================================================================
      // Health / Test
      // =====================================================================

      if (subpath === '/test' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        const results = {
          managementToken: null,
          project: null,
        };
        if (cfg.managementToken) {
          const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects`, { headers: managementHeaders(cfg) });
          results.managementToken = { ok: r.status < 400, status: r.status };
        }
        if (active && isProjectConfigured(active)) {
          const r = await httpsReq(projectRestUrl(active, '/rest/v1/'), {
            headers: projectHeaders(active),
          });
          results.project = { ok: r.status < 400, status: r.status, name: active.name };
        }
        return json(res, results);
      }

      if (subpath === '/health' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken) return json(res, { error: 'Management token not configured' }, 401);
        if (!active) return json(res, { error: 'No active project' }, 400);
        const r = await runSql(cfg, active.projectRef, `
          select
            (select count(*) from information_schema.tables where table_schema not in ('pg_catalog','information_schema','extensions','graphql','graphql_public','pgsodium','pgsodium_masks','realtime','supabase_functions','vault','net','cron','pgbouncer')) as table_count,
            (select count(*) from pg_catalog.pg_namespace where nspname not like 'pg_%' and nspname not in ('information_schema','pg_toast','extensions','graphql','graphql_public','pgsodium','pgsodium_masks','realtime','supabase_functions','vault','net','cron','pgbouncer')) as user_schemas,
            current_database() as database,
            version() as pg_version
        `, { readOnly: true });
        if (r.status >= 400) return json(res, { error: (r.data && r.data.message) || 'Health query failed', raw: r.data }, r.status);
        return json(res, {
          project: { name: active.name, projectRef: active.projectRef, url: active.url },
          database: (r.data && r.data[0]) || null,
        });
      }

      // =====================================================================
      // MANAGEMENT API -- pass-through + convenience
      // =====================================================================

      if (subpath === '/mgmt/projects' && method === 'GET') {
        const cfg = readCfg();
        if (!cfg.managementToken) return json(res, { error: 'Management token not configured' }, 401);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      if (subpath === '/mgmt/organizations' && method === 'GET') {
        const cfg = readCfg();
        if (!cfg.managementToken) return json(res, { error: 'Management token not configured' }, 401);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/organizations`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      // Get the API keys + URL for the active project (fills the service_role/anon fields)
      if (subpath === '/mgmt/api-keys' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken) return json(res, { error: 'Management token not configured' }, 401);
        if (!active) return json(res, { error: 'No active project' }, 400);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/api-keys`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      if (subpath === '/mgmt/postgres-config' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken) return json(res, { error: 'Management token not configured' }, 401);
        if (!active) return json(res, { error: 'No active project' }, 400);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/config/database/postgres`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      if (subpath === '/mgmt/network-restrictions' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken) return json(res, { error: 'Management token not configured' }, 401);
        if (!active) return json(res, { error: 'No active project' }, 400);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/network-restrictions`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      if (subpath === '/mgmt/ssl-enforcement' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken) return json(res, { error: 'Management token not configured' }, 401);
        if (!active) return json(res, { error: 'No active project' }, 400);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/ssl-enforcement`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      // Project lifecycle: gated
      if (subpath === '/mgmt/project/pause' && method === 'POST') {
        if (!(await gate(res, 'POST /api/plugins/supabase/mgmt/project/pause', 'Pause the Supabase project'))) return;
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken) return json(res, { error: 'Management token not configured' }, 401);
        if (!active) return json(res, { error: 'No active project' }, 400);
        const confirm = url.searchParams.get('confirm');
        if (!confirm) {
          const token = issueConfirmToken('project:pause', { projectRef: active.projectRef });
          return json(res, { confirmRequired: true, action: 'pause project', projectRef: active.projectRef, token, retryWith: `?confirm=${token}` }, soft409);
        }
        const payload = consumeConfirmToken(confirm, 'project:pause');
        if (!payload || payload.projectRef !== active.projectRef) return json(res, { error: 'Invalid or expired confirmation token' }, 403);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/pause`, { method: 'POST', headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      if (subpath === '/mgmt/project/restore' && method === 'POST') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken) return json(res, { error: 'Management token not configured' }, 401);
        if (!active) return json(res, { error: 'No active project' }, 400);
        const confirm = url.searchParams.get('confirm');
        if (!confirm) {
          const token = issueConfirmToken('project:restore', { projectRef: active.projectRef });
          return json(res, { confirmRequired: true, action: 'restore project', projectRef: active.projectRef, token, retryWith: `?confirm=${token}` }, soft409);
        }
        const payload = consumeConfirmToken(confirm, 'project:restore');
        if (!payload || payload.projectRef !== active.projectRef) return json(res, { error: 'Invalid or expired confirmation token' }, 403);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/restore`, { method: 'POST', headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      if (subpath === '/mgmt/project' && method === 'DELETE') {
        if (!(await gate(res, 'DELETE /api/plugins/supabase/mgmt/project', 'Delete the Supabase cloud project'))) return;
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken) return json(res, { error: 'Management token not configured' }, 401);
        if (!active) return json(res, { error: 'No active project' }, 400);
        const confirm = url.searchParams.get('confirm');
        if (!confirm) {
          const token = issueConfirmToken('project:delete', { projectRef: active.projectRef });
          return json(res, { confirmRequired: true, action: 'DELETE PROJECT', warning: 'This is irreversible.', projectRef: active.projectRef, token, retryWith: `?confirm=${token}` }, soft409);
        }
        const payload = consumeConfirmToken(confirm, 'project:delete');
        if (!payload || payload.projectRef !== active.projectRef) return json(res, { error: 'Invalid or expired confirmation token' }, 403);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}`, { method: 'DELETE', headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      // =====================================================================
      // RAW SQL RUNNER (safety-gated)
      // =====================================================================

      if (subpath === '/sql' && method === 'POST') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken) return json(res, { error: 'Management token not configured' }, 401);
        if (!active) return json(res, { error: 'No active project' }, 400);
        const body = await readBody(req);
        if (!body.query || typeof body.query !== 'string') {
          return json(res, { error: 'query (string) required' }, 400);
        }
        const confirm = url.searchParams.get('confirm');
        const { destructive, statements } = classifySql(body.query);
        if (destructive.length > 0 && (confirm || body.force) && !(await gate(res, 'POST /api/plugins/supabase/sql', `Run destructive SQL on ${active.name}: ${destructive.map((d) => d.kind).join(', ')}`))) return;
        if (!body.readOnly && destructive.length === 0 && !/^\s*(select|with|explain|show|table|values)\b/i.test(body.query) && !(await gate(res, 'POST /api/plugins/supabase/sql', `Run SQL that writes on ${active.name}`))) return;
        overviewCache.clear();
        if (destructive.length > 0 && !body.force) {
          if (!confirm) {
            const token = issueConfirmToken('sql:destructive', { query: body.query, projectRef: active.projectRef });
            return json(res, {
              confirmRequired: true,
              destructive,
              statements: statements.length,
              token,
              retryWith: `?confirm=${token}`,
              note: 'Destructive SQL detected. Retry with ?confirm=<token> within 10 minutes, or set body.force=true to skip the gate.',
            }, soft409);
          }
          const payload = consumeConfirmToken(confirm, 'sql:destructive');
          if (!payload || payload.query !== body.query || payload.projectRef !== active.projectRef) {
            return json(res, { error: 'Invalid or expired confirmation token' }, 403);
          }
        }
        const r = await runSql(cfg, active.projectRef, body.query, { readOnly: body.readOnly === true });
        return json(res, r.data, r.status);
      }

      // Read-only SELECT helper (never gated).
      if (subpath === '/sql/select' && method === 'POST') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken) return json(res, { error: 'Management token not configured' }, 401);
        if (!active) return json(res, { error: 'No active project' }, 400);
        const body = await readBody(req);
        if (!body.query) return json(res, { error: 'query required' }, 400);
        const r = await runSql(cfg, active.projectRef, body.query, { readOnly: true });
        return json(res, r.data, r.status);
      }

      // =====================================================================
      // DATABASE INTROSPECTION
      // =====================================================================

      if (subpath === '/schemas' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await runSql(cfg, active.projectRef, `
          select nspname as name
          from pg_catalog.pg_namespace
          where nspname not like 'pg_%'
            and nspname not in ('information_schema','pg_toast')
          order by nspname
        `, { readOnly: true });
        return json(res, r.data, r.status);
      }

      if (subpath === '/tables' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const schema = url.searchParams.get('schema') || 'public';
        const r = await runSql(cfg, active.projectRef, `
          select
            c.relname as name,
            n.nspname as schema,
            case c.relkind
              when 'r' then 'table'
              when 'v' then 'view'
              when 'm' then 'materialized_view'
              when 'p' then 'partitioned_table'
              when 'f' then 'foreign_table'
            end as kind,
            obj_description(c.oid) as comment,
            pg_total_relation_size(c.oid) as size_bytes,
            (select count(*) from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped) as column_count,
            (select reltuples::bigint from pg_class where oid = c.oid) as approx_rows,
            c.relrowsecurity as rls_enabled,
            (select count(*) from pg_policies p where p.schemaname = n.nspname and p.tablename = c.relname) as policies,
            exists(select 1 from pg_index i where i.indrelid = c.oid and i.indisprimary) as has_pk
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where c.relkind in ('r','v','m','p','f')
            and n.nspname = ${q(schema)}
          order by c.relname
        `, { readOnly: true });
        return json(res, r.data, r.status);
      }

      const tableMatch = subpath.match(/^\/tables\/([^/]+)\/([^/]+)$/);
      if (tableMatch && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const [, schema, table] = tableMatch;
        const r = await runSql(cfg, active.projectRef, `
          select
            a.attname as name,
            format_type(a.atttypid, a.atttypmod) as type,
            a.attnotnull as not_null,
            pg_get_expr(ad.adbin, ad.adrelid) as default_value,
            coalesce(i.indisprimary, false) as is_primary_key,
            col_description(a.attrelid, a.attnum) as comment
          from pg_attribute a
          join pg_class c on c.oid = a.attrelid
          join pg_namespace n on n.oid = c.relnamespace
          left join pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
          left join pg_index i on i.indrelid = a.attrelid and a.attnum = any(i.indkey) and i.indisprimary
          where n.nspname = ${q(schema)} and c.relname = ${q(table)}
            and a.attnum > 0 and not a.attisdropped
          order by a.attnum
        `, { readOnly: true });
        return json(res, r.data, r.status);
      }

      if (subpath === '/views' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const schema = url.searchParams.get('schema') || 'public';
        const r = await runSql(cfg, active.projectRef, `
          select table_name as name, view_definition as definition
          from information_schema.views
          where table_schema = ${q(schema)}
          order by table_name
        `, { readOnly: true });
        return json(res, r.data, r.status);
      }

      if (subpath === '/materialized-views' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const schema = url.searchParams.get('schema') || 'public';
        const r = await runSql(cfg, active.projectRef, `
          select matviewname as name, definition, ispopulated as populated
          from pg_matviews
          where schemaname = ${q(schema)}
          order by matviewname
        `, { readOnly: true });
        return json(res, r.data, r.status);
      }

      if (subpath === '/indexes' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const schema = url.searchParams.get('schema') || 'public';
        const table = url.searchParams.get('table') || null;
        const r = await runSql(cfg, active.projectRef, `
          select schemaname as schema, tablename as table, indexname as name, indexdef as definition
          from pg_indexes
          where schemaname = ${q(schema)}
            ${table ? `and tablename = ${q(table)}` : ''}
          order by tablename, indexname
        `, { readOnly: true });
        return json(res, r.data, r.status);
      }

      if (subpath === '/constraints' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const schema = url.searchParams.get('schema') || 'public';
        const r = await runSql(cfg, active.projectRef, `
          select tc.table_name as table, tc.constraint_name as name, tc.constraint_type as type,
                 pg_get_constraintdef(pgc.oid) as definition
          from information_schema.table_constraints tc
          join pg_constraint pgc on pgc.conname = tc.constraint_name
          where tc.table_schema = ${q(schema)}
          order by tc.table_name, tc.constraint_name
        `, { readOnly: true });
        return json(res, r.data, r.status);
      }

      if (subpath === '/sequences' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const schema = url.searchParams.get('schema') || 'public';
        const r = await runSql(cfg, active.projectRef, `
          select sequence_name as name, data_type as type, start_value, minimum_value, maximum_value, increment
          from information_schema.sequences
          where sequence_schema = ${q(schema)}
          order by sequence_name
        `, { readOnly: true });
        return json(res, r.data, r.status);
      }

      if (subpath === '/enums' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await runSql(cfg, active.projectRef, `
          select n.nspname as schema, t.typname as name,
                 array_agg(e.enumlabel order by e.enumsortorder) as values
          from pg_type t
          join pg_enum e on e.enumtypid = t.oid
          join pg_namespace n on n.oid = t.typnamespace
          group by n.nspname, t.typname
          order by n.nspname, t.typname
        `, { readOnly: true });
        return json(res, r.data, r.status);
      }

      if (subpath === '/functions' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const schema = url.searchParams.get('schema') || 'public';
        const r = await runSql(cfg, active.projectRef, `
          select
            n.nspname as schema,
            p.proname as name,
            pg_get_function_arguments(p.oid) as arguments,
            pg_get_function_result(p.oid) as returns,
            l.lanname as language,
            case p.prokind when 'f' then 'function' when 'p' then 'procedure' when 'a' then 'aggregate' when 'w' then 'window' end as kind
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
          join pg_language l on l.oid = p.prolang
          where n.nspname = ${q(schema)}
          order by p.proname
        `, { readOnly: true });
        return json(res, r.data, r.status);
      }

      if (subpath === '/triggers' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const schema = url.searchParams.get('schema') || 'public';
        const r = await runSql(cfg, active.projectRef, `
          select
            t.tgname as name,
            c.relname as table,
            n.nspname as schema,
            pg_get_triggerdef(t.oid) as definition,
            t.tgenabled as enabled
          from pg_trigger t
          join pg_class c on c.oid = t.tgrelid
          join pg_namespace n on n.oid = c.relnamespace
          where not t.tgisinternal
            and n.nspname = ${q(schema)}
          order by c.relname, t.tgname
        `, { readOnly: true });
        return json(res, r.data, r.status);
      }

      if (subpath === '/extensions' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await runSql(cfg, active.projectRef, `
          select a.name as name, e.extversion as version, n.nspname as schema,
                 a.default_version as latest_available,
                 a.installed_version is not null as installed,
                 a.comment as description
          from pg_available_extensions a
          left join pg_extension e on e.extname = a.name
          left join pg_namespace n on n.oid = e.extnamespace
          order by a.name
        `, { readOnly: true });
        return json(res, r.data, r.status);
      }

      if (subpath === '/extensions' && method === 'POST') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const body = await readBody(req);
        if (!body.name) return json(res, { error: 'name required' }, 400);
        const schema = body.schema ? `SCHEMA ${ident(body.schema)}` : '';
        const r = await runSql(cfg, active.projectRef, `CREATE EXTENSION IF NOT EXISTS ${ident(body.name)} ${schema}`);
        return json(res, r.data, r.status);
      }

      if (subpath.match(/^\/extensions\/([^/]+)$/) && method === 'DELETE') {
        const name = subpath.split('/').pop();
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await runSql(cfg, active.projectRef, `DROP EXTENSION IF EXISTS ${ident(name)}`);
        return json(res, r.data, r.status);
      }

      if (subpath === '/publications' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await runSql(cfg, active.projectRef, `
          select p.pubname as name, p.puballtables as all_tables, p.pubinsert, p.pubupdate, p.pubdelete, p.pubtruncate,
                 array(select schemaname || '.' || tablename from pg_publication_tables where pubname = p.pubname) as tables
          from pg_publication p
          order by p.pubname
        `, { readOnly: true });
        return json(res, r.data, r.status);
      }

      if (subpath === '/roles' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await runSql(cfg, active.projectRef, `
          select rolname as name, rolsuper as superuser, rolcanlogin as can_login,
                 rolcreatedb as create_db, rolcreaterole as create_role, rolreplication as replication
          from pg_roles
          where rolname not like 'pg_%'
          order by rolname
        `, { readOnly: true });
        return json(res, r.data, r.status);
      }

      // =====================================================================
      // RLS POLICIES
      // =====================================================================

      if (subpath === '/policies' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const schema = url.searchParams.get('schema') || 'public';
        const table = url.searchParams.get('table');
        const r = await runSql(cfg, active.projectRef, `
          select schemaname as schema, tablename as table, policyname as name,
                 permissive, roles, cmd as command,
                 qual as using_expression, with_check as check_expression
          from pg_policies
          where schemaname = ${q(schema)}
            ${table ? `and tablename = ${q(table)}` : ''}
          order by tablename, policyname
        `, { readOnly: true });
        return json(res, r.data, r.status);
      }

      if (subpath === '/policies' && method === 'POST') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const body = await readBody(req);
        if (!body.table || !body.name) return json(res, { error: 'table and name required' }, 400);
        const schema = body.schema || 'public';
        const command = String(body.command || 'ALL').toUpperCase();
        const roles = body.roles && body.roles.length ? body.roles.join(',') : 'public';
        const usingExpr = body.using ? `USING (${body.using})` : '';
        const checkExpr = body.check ? `WITH CHECK (${body.check})` : '';
        const sql = `CREATE POLICY ${ident(body.name)} ON ${qualified(schema, body.table)} FOR ${command} TO ${roles} ${usingExpr} ${checkExpr}`;
        const r = await runSql(cfg, active.projectRef, sql);
        return json(res, r.data, r.status);
      }

      const policyMatch = subpath.match(/^\/policies\/([^/]+)\/([^/]+)\/([^/]+)$/);
      if (policyMatch && method === 'DELETE') {
        const [, schema, table, name] = policyMatch;
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        if (!(await gate(res, 'DELETE /api/plugins/supabase/policies', `Drop the policy ${name} on ${schema}.${table}`))) return;
        const r = await runSql(cfg, active.projectRef, `DROP POLICY IF EXISTS ${ident(name)} ON ${qualified(schema, table)}`);
        return json(res, r.data, r.status);
      }

      if (subpath.match(/^\/rls\/enable\/([^/]+)\/([^/]+)$/) && method === 'POST') {
        const [, schema, table] = subpath.match(/^\/rls\/enable\/([^/]+)\/([^/]+)$/);
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await runSql(cfg, active.projectRef, `ALTER TABLE ${qualified(schema, table)} ENABLE ROW LEVEL SECURITY`);
        return json(res, r.data, r.status);
      }

      if (subpath.match(/^\/rls\/disable\/([^/]+)\/([^/]+)$/) && method === 'POST') {
        const [, schema, table] = subpath.match(/^\/rls\/disable\/([^/]+)\/([^/]+)$/);
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        if (!(await gate(res, 'POST /api/plugins/supabase/rls/disable', `Disable row level security on ${schema}.${table}`))) return;
        const r = await runSql(cfg, active.projectRef, `ALTER TABLE ${qualified(schema, table)} DISABLE ROW LEVEL SECURITY`);
        return json(res, r.data, r.status);
      }

      // =====================================================================
      // ROW CRUD (PostgREST)
      // =====================================================================

      const rowsMatch = subpath.match(/^\/rows\/([^/]+)$/);
      if (rowsMatch && method === 'GET') {
        const table = rowsMatch[1];
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!active || !isProjectConfigured(active)) return json(res, { error: 'Active project not configured' }, 401);
        const qs = new URLSearchParams(url.searchParams);
        // Our own parameters never reach PostgREST, which would read them as filters.
        for (const k of [...qs.keys()]) if (k.startsWith('_') || k === 'project' || k === 'repo') qs.delete(k);
        const restUrl = projectRestUrl(active, `/rest/v1/${encodeURIComponent(table)}?${qs.toString()}`);
        const headers = projectHeaders(active, {
          'Accept-Profile': url.searchParams.get('_schema') || 'public',
          'Prefer': 'count=exact',
        });
        const r = await httpsReq(restUrl, { headers });
        if (url.searchParams.get('_meta') === '1') { const range = String(r.headers['content-range'] || ''); const total = range.includes('/') ? Number(range.split('/')[1]) : null; return json(res, { rows: Array.isArray(r.data) ? r.data : [], total: Number.isFinite(total) ? total : null, error: !Array.isArray(r.data) && r.data && r.data.message ? r.data.message : undefined }, r.status); }
        return json(res, r.data, r.status);
      }

      if (rowsMatch && method === 'POST') {
        const table = rowsMatch[1];
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!active || !isProjectConfigured(active)) return json(res, { error: 'Active project not configured' }, 401);
        const body = await readBody(req);
        const restUrl = projectRestUrl(active, `/rest/v1/${encodeURIComponent(table)}`);
        const r = await httpsReq(restUrl, {
          method: 'POST',
          headers: projectHeaders(active, {
            'Content-Profile': url.searchParams.get('_schema') || 'public',
            'Prefer': 'return=representation',
          }),
        }, body);
        return json(res, r.data, r.status);
      }

      if (rowsMatch && method === 'PATCH') {
        const table = rowsMatch[1];
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!active || !isProjectConfigured(active)) return json(res, { error: 'Active project not configured' }, 401);
        const body = await readBody(req);
        const qs = new URLSearchParams(url.searchParams);
        for (const k of [...qs.keys()]) if (k.startsWith('_') || k === 'project' || k === 'repo') qs.delete(k);
        const restUrl = projectRestUrl(active, `/rest/v1/${encodeURIComponent(table)}?${qs.toString()}`);
        const r = await httpsReq(restUrl, {
          method: 'PATCH',
          headers: projectHeaders(active, {
            'Content-Profile': url.searchParams.get('_schema') || 'public',
            'Prefer': 'return=representation',
          }),
        }, body);
        return json(res, r.data, r.status);
      }

      if (rowsMatch && method === 'DELETE') {
        const table = rowsMatch[1];
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!active || !isProjectConfigured(active)) return json(res, { error: 'Active project not configured' }, 401);
        const qs = new URLSearchParams(url.searchParams);
        for (const k of [...qs.keys()]) if (k.startsWith('_') || k === 'project' || k === 'repo' || k === 'confirm') qs.delete(k);
        // Safety: require at least one filter, else gate.
        const filterKeys = [...qs.keys()];
        const confirm = url.searchParams.get('confirm');
        if (filterKeys.length === 0 && !confirm) {
          const token = issueConfirmToken('rows:delete-all', { table, projectRef: active.projectRef });
          return json(res, {
            confirmRequired: true,
            warning: 'No filter provided -- this would delete ALL rows.',
            token, retryWith: `?confirm=${token}`,
          }, soft409);
        }
        if (filterKeys.length === 0) {
          const payload = consumeConfirmToken(confirm, 'rows:delete-all');
          if (!payload || payload.table !== table || payload.projectRef !== active.projectRef) {
            return json(res, { error: 'Invalid or expired confirmation token' }, 403);
          }
        }
        const restUrl = projectRestUrl(active, `/rest/v1/${encodeURIComponent(table)}?${qs.toString()}`);
        const r = await httpsReq(restUrl, {
          method: 'DELETE',
          headers: projectHeaders(active, {
            'Content-Profile': url.searchParams.get('_schema') || 'public',
            'Prefer': 'return=representation',
          }),
        });
        return json(res, r.data, r.status);
      }

      // RPC (call a database function from PostgREST)
      const rpcMatch = subpath.match(/^\/rpc\/([^/]+)$/);
      if (rpcMatch && method === 'POST') {
        const fn = rpcMatch[1];
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!active || !isProjectConfigured(active)) return json(res, { error: 'Active project not configured' }, 401);
        const body = await readBody(req);
        const restUrl = projectRestUrl(active, `/rest/v1/rpc/${encodeURIComponent(fn)}`);
        const r = await httpsReq(restUrl, {
          method: 'POST',
          headers: projectHeaders(active),
        }, body || {});
        return json(res, r.data, r.status);
      }

      // =====================================================================
      // AUTH (GoTrue admin)
      // =====================================================================

      if (subpath === '/auth/users' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!active || !isProjectConfigured(active)) return json(res, { error: 'Active project not configured' }, 401);
        const page = url.searchParams.get('page') || '1';
        const perPage = url.searchParams.get('per_page') || '50';
        const q = (url.searchParams.get('q') || '').trim();
        // GoTrue's admin list has no search; with a search term and the management token, ask the database.
        if (q && cfg.managementToken) {
          const like = '%' + q.replace(/[%_\\]/g, (m) => '\\' + m) + '%';
          const lim = Math.min(Math.max(parseInt(perPage, 10) || 50, 1), 500);
          const off = (Math.max(parseInt(page, 10) || 1, 1) - 1) * lim;
          const sql = `select id, aud, role, email, phone, email_confirmed_at, phone_confirmed_at, invited_at, confirmation_sent_at, last_sign_in_at, raw_app_meta_data as app_metadata, raw_user_meta_data as user_metadata, created_at, updated_at, banned_until, is_anonymous, (select count(*) from auth.users u2 where u2.email ilike ${sqlLiteral(like)} or u2.phone ilike ${sqlLiteral(like)} or u2.id::text = ${sqlLiteral(q)}) as _total from auth.users where email ilike ${sqlLiteral(like)} or phone ilike ${sqlLiteral(like)} or id::text = ${sqlLiteral(q)} order by created_at desc limit ${lim} offset ${off}`;
          const rr = await runSql(cfg, active.projectRef, sql, { readOnly: true });
          const rows = Array.isArray(rr.data) ? rr.data : [];
          const total = rows.length ? Number(rows[0]._total) : 0;
          return json(res, { users: rows.map(({ _total, ...u }) => u), total, aud: 'authenticated', nextPage: off + rows.length < total ? (parseInt(page, 10) || 1) + 1 : null }, rr.status >= 400 ? rr.status : 200);
        }
        const restUrl = projectRestUrl(active, `/auth/v1/admin/users?page=${page}&per_page=${perPage}`);
        const r = await httpsReq(restUrl, { headers: projectHeaders(active) });
        return json(res, r.data, r.status);
      }

      if (subpath === '/auth/users' && method === 'POST') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!active || !isProjectConfigured(active)) return json(res, { error: 'Active project not configured' }, 401);
        const body = await readBody(req);
        const restUrl = projectRestUrl(active, `/auth/v1/admin/users`);
        const r = await httpsReq(restUrl, { method: 'POST', headers: projectHeaders(active) }, body);
        return json(res, r.data, r.status);
      }

      const authUserMatch = subpath.match(/^\/auth\/users\/([^/]+)$/);
      if (authUserMatch && method === 'GET') {
        const id = authUserMatch[1];
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!active || !isProjectConfigured(active)) return json(res, { error: 'Active project not configured' }, 401);
        const r = await httpsReq(projectRestUrl(active, `/auth/v1/admin/users/${encodeURIComponent(id)}`), { headers: projectHeaders(active) });
        return json(res, r.data, r.status);
      }

      if (authUserMatch && method === 'PUT') {
        const id = authUserMatch[1];
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!active || !isProjectConfigured(active)) return json(res, { error: 'Active project not configured' }, 401);
        const body = await readBody(req);
        const r = await httpsReq(projectRestUrl(active, `/auth/v1/admin/users/${encodeURIComponent(id)}`), { method: 'PUT', headers: projectHeaders(active) }, body);
        return json(res, r.data, r.status);
      }

      if (authUserMatch && method === 'DELETE') {
        const id = authUserMatch[1];
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!active || !isProjectConfigured(active)) return json(res, { error: 'Active project not configured' }, 401);
        const confirm = url.searchParams.get('confirm');
        if (!confirm) {
          const token = issueConfirmToken('auth:delete-user', { id, projectRef: active.projectRef });
          return json(res, { confirmRequired: true, userId: id, token, retryWith: `?confirm=${token}` }, soft409);
        }
        const payload = consumeConfirmToken(confirm, 'auth:delete-user');
        if (!payload || payload.id !== id || payload.projectRef !== active.projectRef) {
          return json(res, { error: 'Invalid or expired confirmation token' }, 403);
        }
        if (!(await gate(res, 'DELETE /api/plugins/supabase/auth/users', `Delete the auth user ${id}`))) return;
        const r = await httpsReq(projectRestUrl(active, `/auth/v1/admin/users/${encodeURIComponent(id)}`), { method: 'DELETE', headers: projectHeaders(active) });
        return json(res, r.data, r.status);
      }

      if (subpath === '/auth/invite' && method === 'POST') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!active || !isProjectConfigured(active)) return json(res, { error: 'Active project not configured' }, 401);
        const body = await readBody(req);
        const r = await httpsReq(projectRestUrl(active, `/auth/v1/invite`), { method: 'POST', headers: projectHeaders(active) }, body);
        return json(res, r.data, r.status);
      }

      // Generate an admin "magic link" / recovery / signup link.
      if (subpath === '/auth/generate-link' && method === 'POST') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!active || !isProjectConfigured(active)) return json(res, { error: 'Active project not configured' }, 401);
        const body = await readBody(req);
        if (!body.type || !body.email) return json(res, { error: 'type and email required' }, 400);
        const r = await httpsReq(projectRestUrl(active, `/auth/v1/admin/generate_link`), { method: 'POST', headers: projectHeaders(active) }, body);
        return json(res, r.data, r.status);
      }

      // Password reset: gated
      if (subpath === '/auth/reset-password' && method === 'POST') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!active || !isProjectConfigured(active)) return json(res, { error: 'Active project not configured' }, 401);
        const body = await readBody(req);
        if (!body.email) return json(res, { error: 'email required' }, 400);
        const confirm = url.searchParams.get('confirm');
        if (!confirm) {
          const token = issueConfirmToken('auth:reset', { email: body.email, projectRef: active.projectRef });
          return json(res, { confirmRequired: true, email: body.email, token, retryWith: `?confirm=${token}` }, soft409);
        }
        const payload = consumeConfirmToken(confirm, 'auth:reset');
        if (!payload || payload.email !== body.email) return json(res, { error: 'Invalid or expired confirmation token' }, 403);
        const r = await httpsReq(projectRestUrl(active, `/auth/v1/recover`), { method: 'POST', headers: projectHeaders(active) }, { email: body.email });
        return json(res, r.data, r.status);
      }

      // Auth config (via Management API)
      if (subpath === '/auth/config' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/config/auth`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      if (subpath === '/auth/config' && method === 'PATCH') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const body = await readBody(req);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/config/auth`, { method: 'PATCH', headers: managementHeaders(cfg) }, body);
        return json(res, r.data, r.status);
      }

      // =====================================================================
      // STORAGE
      // =====================================================================

      if (subpath === '/storage/buckets' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!active || !isProjectConfigured(active)) return json(res, { error: 'Active project not configured' }, 401);
        const r = await httpsReq(projectRestUrl(active, `/storage/v1/bucket`), { headers: projectHeaders(active) });
        return json(res, r.data, r.status);
      }

      if (subpath === '/storage/buckets' && method === 'POST') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!active || !isProjectConfigured(active)) return json(res, { error: 'Active project not configured' }, 401);
        const body = await readBody(req);
        if (!body.id && !body.name) return json(res, { error: 'id or name required' }, 400);
        const r = await httpsReq(projectRestUrl(active, `/storage/v1/bucket`), { method: 'POST', headers: projectHeaders(active) }, body);
        return json(res, r.data, r.status);
      }

      const bucketMatch = subpath.match(/^\/storage\/buckets\/([^/]+)$/);
      if (bucketMatch && method === 'GET') {
        const id = bucketMatch[1];
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!active || !isProjectConfigured(active)) return json(res, { error: 'Active project not configured' }, 401);
        const r = await httpsReq(projectRestUrl(active, `/storage/v1/bucket/${encodeURIComponent(id)}`), { headers: projectHeaders(active) });
        return json(res, r.data, r.status);
      }

      if (bucketMatch && method === 'PUT') {
        const id = bucketMatch[1];
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!active || !isProjectConfigured(active)) return json(res, { error: 'Active project not configured' }, 401);
        const body = await readBody(req);
        const r = await httpsReq(projectRestUrl(active, `/storage/v1/bucket/${encodeURIComponent(id)}`), { method: 'PUT', headers: projectHeaders(active) }, body);
        return json(res, r.data, r.status);
      }

      if (bucketMatch && method === 'DELETE') {
        const id = bucketMatch[1];
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!active || !isProjectConfigured(active)) return json(res, { error: 'Active project not configured' }, 401);
        if (!(await gate(res, 'DELETE /api/plugins/supabase/storage/buckets', `Delete the storage bucket ${id}`))) return;
        const r = await httpsReq(projectRestUrl(active, `/storage/v1/bucket/${encodeURIComponent(id)}`), { method: 'DELETE', headers: projectHeaders(active) });
        return json(res, r.data, r.status);
      }

      if (subpath.match(/^\/storage\/buckets\/([^/]+)\/empty$/) && method === 'POST') {
        const id = subpath.split('/')[3];
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!active || !isProjectConfigured(active)) return json(res, { error: 'Active project not configured' }, 401);
        const confirm = url.searchParams.get('confirm');
        if (!confirm) {
          const token = issueConfirmToken('bucket:empty', { id, projectRef: active.projectRef });
          return json(res, { confirmRequired: true, bucket: id, warning: 'Deletes ALL objects in this bucket.', token, retryWith: `?confirm=${token}` }, soft409);
        }
        const payload = consumeConfirmToken(confirm, 'bucket:empty');
        if (!payload || payload.id !== id) return json(res, { error: 'Invalid or expired confirmation token' }, 403);
        const r = await httpsReq(projectRestUrl(active, `/storage/v1/bucket/${encodeURIComponent(id)}/empty`), { method: 'POST', headers: projectHeaders(active) });
        return json(res, r.data, r.status);
      }

      // List objects in a bucket: POST /object/list/:bucket with { prefix, limit, offset, sortBy }
      if (subpath.match(/^\/storage\/list\/([^/]+)$/) && method === 'POST') {
        const bucket = subpath.split('/')[3];
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!active || !isProjectConfigured(active)) return json(res, { error: 'Active project not configured' }, 401);
        const body = await readBody(req);
        const r = await httpsReq(projectRestUrl(active, `/storage/v1/object/list/${encodeURIComponent(bucket)}`), {
          method: 'POST',
          headers: projectHeaders(active),
        }, body || {});
        return json(res, r.data, r.status);
      }

      // Signed URL
      if (subpath.match(/^\/storage\/sign\/([^/]+)\/(.+)$/) && method === 'POST') {
        const [, bucket, path0] = subpath.match(/^\/storage\/sign\/([^/]+)\/(.+)$/);
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!active || !isProjectConfigured(active)) return json(res, { error: 'Active project not configured' }, 401);
        const body = await readBody(req);
        const expires = body && body.expiresIn ? body.expiresIn : 3600;
        const r = await httpsReq(projectRestUrl(active, `/storage/v1/object/sign/${encodeURIComponent(bucket)}/${path0}`), {
          method: 'POST',
          headers: projectHeaders(active),
        }, { expiresIn: expires });
        return json(res, r.data, r.status);
      }

      // Delete one or more objects
      if (subpath.match(/^\/storage\/objects\/([^/]+)$/) && method === 'DELETE') {
        const bucket = subpath.split('/')[3];
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!active || !isProjectConfigured(active)) return json(res, { error: 'Active project not configured' }, 401);
        const body = await readBody(req);
        if (!body || !Array.isArray(body.prefixes)) return json(res, { error: 'prefixes array required' }, 400);
        if (!(await gate(res, 'DELETE /api/plugins/supabase/storage/objects', `Delete ${body.prefixes.length} object${body.prefixes.length === 1 ? '' : 's'} from ${bucket}`))) return;
        const r = await httpsReq(projectRestUrl(active, `/storage/v1/object/${encodeURIComponent(bucket)}`), {
          method: 'DELETE',
          headers: projectHeaders(active),
        }, { prefixes: body.prefixes });
        return json(res, r.data, r.status);
      }

      // Move object
      if (subpath === '/storage/move' && method === 'POST') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!active || !isProjectConfigured(active)) return json(res, { error: 'Active project not configured' }, 401);
        const body = await readBody(req);
        const r = await httpsReq(projectRestUrl(active, `/storage/v1/object/move`), {
          method: 'POST',
          headers: projectHeaders(active),
        }, body);
        return json(res, r.data, r.status);
      }

      // Copy object
      if (subpath === '/storage/copy' && method === 'POST') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!active || !isProjectConfigured(active)) return json(res, { error: 'Active project not configured' }, 401);
        const body = await readBody(req);
        const r = await httpsReq(projectRestUrl(active, `/storage/v1/object/copy`), {
          method: 'POST',
          headers: projectHeaders(active),
        }, body);
        return json(res, r.data, r.status);
      }

      // =====================================================================
      // EDGE FUNCTIONS
      // =====================================================================

      if (subpath === '/edge/functions' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/functions`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      const fnSlugMatch = subpath.match(/^\/edge\/functions\/([^/]+)$/);
      if (fnSlugMatch && method === 'GET') {
        const slug = fnSlugMatch[1];
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/functions/${encodeURIComponent(slug)}`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      if (fnSlugMatch && method === 'PATCH') {
        const slug = fnSlugMatch[1];
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const body = await readBody(req);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/functions/${encodeURIComponent(slug)}`, { method: 'PATCH', headers: managementHeaders(cfg) }, body);
        return json(res, r.data, r.status);
      }

      if (fnSlugMatch && method === 'DELETE') {
        const slug = fnSlugMatch[1];
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        if (!(await gate(res, 'DELETE /api/plugins/supabase/edge/functions', `Delete the edge function ${slug}`))) return;
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/functions/${encodeURIComponent(slug)}`, { method: 'DELETE', headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      // Deploy (create or update) a function's body/config.
      if (subpath === '/edge/deploy' && method === 'POST') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const body = await readBody(req);
        if (!body.slug || typeof body.body !== 'string') {
          return json(res, { error: 'slug and body (source code as string) required' }, 400);
        }
        const payload = {
          slug: body.slug,
          name: body.name || body.slug,
          body: body.body,
          verify_jwt: body.verify_jwt !== false,
        };
        let r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/functions`, {
          method: 'POST',
          headers: managementHeaders(cfg),
        }, payload);
        // The slug exists already: a new version of it, not a second function.
        if (r.status >= 400 && r.data && /duplicated/i.test(String(r.data.message || ''))) {
          r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/functions/${encodeURIComponent(body.slug)}`, { method: 'PATCH', headers: managementHeaders(cfg) }, { name: payload.name, body: payload.body, verify_jwt: payload.verify_jwt });
        }
        return json(res, r.data, r.status);
      }

      // Invoke a function (uses per-project URL + service role by default).
      if (subpath.match(/^\/edge\/invoke\/([^/]+)$/) && method === 'POST') {
        const slug = subpath.split('/')[3];
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!active || !isProjectConfigured(active)) return json(res, { error: 'Active project not configured' }, 401);
        const body = await readBody(req);
        const r = await httpsReq(projectRestUrl(active, `/functions/v1/${encodeURIComponent(slug)}`), {
          method: 'POST',
          headers: projectHeaders(active),
        }, body);
        return json(res, r.data, r.status);
      }

      // =====================================================================
      // SECRETS / ENV VARS (for edge functions, via Management API)
      // =====================================================================

      if (subpath === '/secrets' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/secrets`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      if (subpath === '/secrets' && method === 'POST') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const body = await readBody(req);
        if (!Array.isArray(body)) return json(res, { error: 'body must be an array of {name, value}' }, 400);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/secrets`, {
          method: 'POST',
          headers: managementHeaders(cfg),
        }, body);
        return json(res, r.data, r.status);
      }

      if (subpath === '/secrets' && method === 'DELETE') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const body = await readBody(req);
        if (!Array.isArray(body)) return json(res, { error: 'body must be an array of secret names' }, 400);
        if (!(await gate(res, 'DELETE /api/plugins/supabase/secrets', `Delete the secret${body.length === 1 ? '' : 's'} ${body.join(', ')}`))) return;
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/secrets`, {
          method: 'DELETE',
          headers: managementHeaders(cfg),
        }, body);
        return json(res, r.data, r.status);
      }

      // =====================================================================
      // DATABASE WEBHOOKS (via Management API)
      // =====================================================================

      if (subpath === '/webhooks' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/database/webhooks`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      // Enable the webhooks feature
      if (subpath === '/webhooks/enable' && method === 'POST') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/database/webhooks/enable`, { method: 'POST', headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      // =====================================================================
      // BACKUPS / PITR
      // =====================================================================

      if (subpath === '/backups' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/database/backups`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      if (subpath === '/backups/restore' && method === 'POST') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const body = await readBody(req);
        const confirm = url.searchParams.get('confirm');
        if (!confirm) {
          const token = issueConfirmToken('backup:restore', { projectRef: active.projectRef, body });
          return json(res, { confirmRequired: true, warning: 'Restores the database from backup; overwrites current state.', token, retryWith: `?confirm=${token}` }, soft409);
        }
        const payload = consumeConfirmToken(confirm, 'backup:restore');
        if (!payload) return json(res, { error: 'Invalid or expired confirmation token' }, 403);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/database/backups/restore-pitr`, {
          method: 'POST',
          headers: managementHeaders(cfg),
        }, body);
        return json(res, r.data, r.status);
      }

      // =====================================================================
      // MIGRATIONS (via Management API)
      // =====================================================================

      if (subpath === '/migrations' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/database/migrations`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      if (subpath === '/migrations' && method === 'POST') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const body = await readBody(req);
        if (!body.query || !body.name) return json(res, { error: 'name and query required' }, 400);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/database/migrations`, {
          method: 'POST',
          headers: managementHeaders(cfg),
        }, body);
        return json(res, r.data, r.status);
      }

      // =====================================================================
      // TYPES GENERATION (TypeScript types from schema)
      // =====================================================================

      if (subpath === '/types/typescript' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const schemas = url.searchParams.get('schemas') || 'public';
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/types/typescript?included_schemas=${encodeURIComponent(schemas)}`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      // =====================================================================
      // LOGS (Management API -- analytics endpoint)
      // =====================================================================

      if (subpath === '/logs' && method === 'POST') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const body = await readBody(req);
        // body: { sql: "..." } or { iso_timestamp_start, iso_timestamp_end, source: "postgres|api|auth|functions" }
        const qs = new URLSearchParams();
        if (body.sql) qs.set('sql', body.sql);
        if (body.iso_timestamp_start) qs.set('iso_timestamp_start', body.iso_timestamp_start);
        if (body.iso_timestamp_end) qs.set('iso_timestamp_end', body.iso_timestamp_end);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/analytics/endpoints/logs.all?${qs.toString()}`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      // =====================================================================
      // VECTOR (pgvector helpers)
      // =====================================================================

      if (subpath === '/vector/indexes' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await runSql(cfg, active.projectRef, `
          select n.nspname as schema, c.relname as table, i.relname as index_name,
                 am.amname as index_type, pg_get_indexdef(ix.indexrelid) as definition
          from pg_index ix
          join pg_class i on i.oid = ix.indexrelid
          join pg_class c on c.oid = ix.indrelid
          join pg_am am on am.oid = i.relam
          join pg_namespace n on n.oid = c.relnamespace
          where am.amname in ('ivfflat','hnsw')
          order by n.nspname, c.relname, i.relname
        `, { readOnly: true });
        return json(res, r.data, r.status);
      }

      // =====================================================================
      // SUMMARY -- one-shot overview
      // =====================================================================

      if (subpath === '/summary' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await runSql(cfg, active.projectRef, `
          with t as (
            select
              (select count(*) from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE') as public_tables,
              (select count(*) from pg_policies where schemaname = 'public') as public_policies,
              (select count(*) from pg_matviews where schemaname = 'public') as public_matviews,
              (select count(*) from information_schema.routines where routine_schema = 'public') as public_functions,
              (select count(*) from pg_trigger where not tgisinternal) as triggers,
              (select count(*) from pg_extension) as extensions,
              (select count(*) from auth.users) as auth_users,
              (select count(*) from storage.buckets) as buckets,
              (select count(*) from storage.objects) as storage_objects
          )
          select * from t
        `, { readOnly: true });
        return json(res, {
          project: { name: active.name, projectRef: active.projectRef, url: active.url },
          summary: (r.data && r.data[0]) || null,
          raw: r.data,
        }, r.status);
      }

      // =====================================================================
      // ADVISORS
      // =====================================================================

      if (subpath === '/advisors/security' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/advisors/security`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      if (subpath === '/advisors/performance' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/advisors/performance`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      // =====================================================================
      // ANALYTICS / USAGE
      // =====================================================================

      if (subpath === '/analytics/usage/api-counts' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const qs = url.searchParams.toString();
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/analytics/endpoints/usage.api-counts${qs ? '?' + qs : ''}`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      if (subpath === '/analytics/usage/api-requests' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const qs = url.searchParams.toString();
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/analytics/endpoints/usage.api-requests-count${qs ? '?' + qs : ''}`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      if (subpath === '/analytics/functions-stats' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const qs = url.searchParams.toString();
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/analytics/endpoints/functions.combined-stats${qs ? '?' + qs : ''}`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      // =====================================================================
      // BRANCHES (preview environments)
      // =====================================================================

      if (subpath === '/branches' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/branches`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      if (subpath === '/branches' && method === 'POST') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const body = await readBody(req);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/branches`, { method: 'POST', headers: managementHeaders(cfg) }, body);
        return json(res, r.data, r.status);
      }

      const branchOpMatch = subpath.match(/^\/branches\/([^/]+)\/(push|merge|reset|restore|diff)$/);
      if (branchOpMatch) {
        const [, branchId, op] = branchOpMatch;
        const cfg = readCfg();
        if (!cfg.managementToken) return json(res, { error: 'Not configured' }, 401);
        const httpMethod = op === 'diff' ? 'GET' : 'POST';
        if (method !== httpMethod) return json(res, { error: `Use ${httpMethod} for this op` }, 405);
        const body = httpMethod === 'POST' ? await readBody(req) : null;
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/branches/${encodeURIComponent(branchId)}/${op}`, { method: httpMethod, headers: managementHeaders(cfg) }, body);
        return json(res, r.data, r.status);
      }

      const branchByIdMatch = subpath.match(/^\/branches\/([^/]+)$/);
      if (branchByIdMatch && !['push', 'merge', 'reset', 'restore', 'diff'].includes(branchByIdMatch[1])) {
        const branchId = branchByIdMatch[1];
        const cfg = readCfg();
        if (!cfg.managementToken) return json(res, { error: 'Not configured' }, 401);
        if (method === 'GET') {
          const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/branches/${encodeURIComponent(branchId)}`, { headers: managementHeaders(cfg) });
          return json(res, r.data, r.status);
        }
        if (method === 'PATCH') {
          const body = await readBody(req);
          const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/branches/${encodeURIComponent(branchId)}`, { method: 'PATCH', headers: managementHeaders(cfg) }, body);
          return json(res, r.data, r.status);
        }
        if (method === 'DELETE') {
          const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/branches/${encodeURIComponent(branchId)}`, { method: 'DELETE', headers: managementHeaders(cfg) });
          return json(res, r.data, r.status);
        }
      }

      // =====================================================================
      // API KEYS MANAGEMENT (new publishable/secret key format)
      // =====================================================================

      if (subpath === '/api-keys' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/api-keys`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      if (subpath === '/api-keys' && method === 'POST') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const body = await readBody(req);
        if (!body.type || !body.name) return json(res, { error: 'type (publishable|secret) and name required' }, 400);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/api-keys`, { method: 'POST', headers: managementHeaders(cfg) }, body);
        return json(res, r.data, r.status);
      }

      const apiKeyMatch = subpath.match(/^\/api-keys\/([^/]+)$/);
      if (apiKeyMatch && apiKeyMatch[1] !== 'legacy') {
        const id = apiKeyMatch[1];
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        if (method === 'GET') {
          const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/api-keys/${encodeURIComponent(id)}`, { headers: managementHeaders(cfg) });
          return json(res, r.data, r.status);
        }
        if (method === 'PATCH') {
          const body = await readBody(req);
          const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/api-keys/${encodeURIComponent(id)}`, { method: 'PATCH', headers: managementHeaders(cfg) }, body);
          return json(res, r.data, r.status);
        }
        if (method === 'DELETE') {
          const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/api-keys/${encodeURIComponent(id)}`, { method: 'DELETE', headers: managementHeaders(cfg) });
          return json(res, r.data, r.status);
        }
      }

      if (subpath === '/api-keys/legacy' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/api-keys/legacy`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      // =====================================================================
      // JWT SIGNING KEYS
      // =====================================================================

      if (subpath === '/signing-keys' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/config/auth/signing-keys`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      if (subpath === '/signing-keys' && method === 'POST') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const body = await readBody(req);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/config/auth/signing-keys`, { method: 'POST', headers: managementHeaders(cfg) }, body);
        return json(res, r.data, r.status);
      }

      const signingKeyMatch = subpath.match(/^\/signing-keys\/([^/]+)$/);
      if (signingKeyMatch && signingKeyMatch[1] !== 'legacy') {
        const id = signingKeyMatch[1];
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        if (method === 'PATCH') {
          const body = await readBody(req);
          const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/config/auth/signing-keys/${encodeURIComponent(id)}`, { method: 'PATCH', headers: managementHeaders(cfg) }, body);
          return json(res, r.data, r.status);
        }
        if (method === 'DELETE') {
          const confirm = url.searchParams.get('confirm');
          if (!confirm) {
            const token = issueConfirmToken('signing-key:delete', { id, projectRef: active.projectRef });
            return json(res, { confirmRequired: true, warning: 'Deleting a signing key invalidates every session signed with it.', token, retryWith: `?confirm=${token}` }, soft409);
          }
          const payload = consumeConfirmToken(confirm, 'signing-key:delete');
          if (!payload || payload.id !== id) return json(res, { error: 'Invalid or expired confirmation token' }, 403);
          const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/config/auth/signing-keys/${encodeURIComponent(id)}`, { method: 'DELETE', headers: managementHeaders(cfg) });
          return json(res, r.data, r.status);
        }
      }

      // =====================================================================
      // SSO PROVIDERS
      // =====================================================================

      if (subpath === '/sso-providers' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/config/auth/sso/providers`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      if (subpath === '/sso-providers' && method === 'POST') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const body = await readBody(req);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/config/auth/sso/providers`, { method: 'POST', headers: managementHeaders(cfg) }, body);
        return json(res, r.data, r.status);
      }

      const ssoMatch = subpath.match(/^\/sso-providers\/([^/]+)$/);
      if (ssoMatch) {
        const id = ssoMatch[1];
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        if (method === 'GET') {
          const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/config/auth/sso/providers/${encodeURIComponent(id)}`, { headers: managementHeaders(cfg) });
          return json(res, r.data, r.status);
        }
        if (method === 'PUT') {
          const body = await readBody(req);
          const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/config/auth/sso/providers/${encodeURIComponent(id)}`, { method: 'PUT', headers: managementHeaders(cfg) }, body);
          return json(res, r.data, r.status);
        }
        if (method === 'DELETE') {
          const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/config/auth/sso/providers/${encodeURIComponent(id)}`, { method: 'DELETE', headers: managementHeaders(cfg) });
          return json(res, r.data, r.status);
        }
      }

      // =====================================================================
      // CUSTOM HOSTNAME / VANITY SUBDOMAIN
      // =====================================================================

      if (subpath === '/custom-hostname' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/custom-hostname`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      if (subpath === '/custom-hostname' && method === 'DELETE') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/custom-hostname`, { method: 'DELETE', headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      const hostnameOp = subpath.match(/^\/custom-hostname\/(initialize|reverify|activate)$/);
      if (hostnameOp && method === 'POST') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const body = await readBody(req);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/custom-hostname/${hostnameOp[1]}`, { method: 'POST', headers: managementHeaders(cfg) }, body);
        return json(res, r.data, r.status);
      }

      if (subpath === '/vanity-subdomain' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/vanity-subdomain`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      if (subpath === '/vanity-subdomain' && method === 'DELETE') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/vanity-subdomain`, { method: 'DELETE', headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      if (subpath === '/vanity-subdomain/check' && method === 'POST') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const body = await readBody(req);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/vanity-subdomain/check-availability`, { method: 'POST', headers: managementHeaders(cfg) }, body);
        return json(res, r.data, r.status);
      }

      if (subpath === '/vanity-subdomain/activate' && method === 'POST') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const body = await readBody(req);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/vanity-subdomain/activate`, { method: 'POST', headers: managementHeaders(cfg) }, body);
        return json(res, r.data, r.status);
      }

      // =====================================================================
      // NETWORK RESTRICTIONS / BANS
      // =====================================================================

      if (subpath === '/network-restrictions' && method === 'PATCH') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const body = await readBody(req);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/network-restrictions`, { method: 'PATCH', headers: managementHeaders(cfg) }, body);
        return json(res, r.data, r.status);
      }

      if (subpath === '/network-restrictions/apply' && method === 'POST') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const body = await readBody(req);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/network-restrictions/apply`, { method: 'POST', headers: managementHeaders(cfg) }, body);
        return json(res, r.data, r.status);
      }

      if (subpath === '/network-bans' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/network-bans/retrieve`, { method: 'POST', headers: managementHeaders(cfg) }, {});
        return json(res, r.data, r.status);
      }

      if (subpath === '/network-bans' && method === 'DELETE') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const body = await readBody(req);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/network-bans`, { method: 'DELETE', headers: managementHeaders(cfg) }, body);
        return json(res, r.data, r.status);
      }

      // =====================================================================
      // READ REPLICAS / UPGRADE / POOLER / POSTGREST
      // =====================================================================

      if (subpath === '/read-replicas/setup' && method === 'POST') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const body = await readBody(req);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/read-replicas/setup`, { method: 'POST', headers: managementHeaders(cfg) }, body);
        return json(res, r.data, r.status);
      }

      if (subpath === '/read-replicas/remove' && method === 'POST') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const body = await readBody(req);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/read-replicas/remove`, { method: 'POST', headers: managementHeaders(cfg) }, body);
        return json(res, r.data, r.status);
      }

      if (subpath === '/upgrade/eligibility' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/upgrade/eligibility`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      if (subpath === '/upgrade/status' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/upgrade/status`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      if (subpath === '/upgrade' && method === 'POST') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const body = await readBody(req);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/upgrade`, { method: 'POST', headers: managementHeaders(cfg) }, body);
        return json(res, r.data, r.status);
      }

      if (subpath === '/postgrest-config' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/postgrest`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      if (subpath === '/postgrest-config' && method === 'PATCH') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const body = await readBody(req);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/postgrest`, { method: 'PATCH', headers: managementHeaders(cfg) }, body);
        return json(res, r.data, r.status);
      }

      if (subpath === '/pooler-config' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/config/database/pooler`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      if (subpath === '/pooler-config' && method === 'PATCH') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const body = await readBody(req);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/config/database/pooler`, { method: 'PATCH', headers: managementHeaders(cfg) }, body);
        return json(res, r.data, r.status);
      }

      if (subpath === '/storage-config' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/config/storage`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      if (subpath === '/storage-config' && method === 'PATCH') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const body = await readBody(req);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/config/storage`, { method: 'PATCH', headers: managementHeaders(cfg) }, body);
        return json(res, r.data, r.status);
      }

      // =====================================================================
      // REALTIME: BROADCAST + CONFIG
      // =====================================================================

      if (subpath === '/realtime/broadcast' && method === 'POST') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!active || !isProjectConfigured(active)) return json(res, { error: 'Active project not configured' }, 401);
        const body = await readBody(req);
        if (!body.messages) return json(res, { error: 'messages array required' }, 400);
        const r = await httpsReq(projectRestUrl(active, `/realtime/v1/api/broadcast`), {
          method: 'POST',
          headers: projectHeaders(active),
        }, body);
        return json(res, r.data, r.status);
      }

      if (subpath === '/realtime/config' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/config/realtime`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      if (subpath === '/realtime/config' && method === 'PATCH') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const body = await readBody(req);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/config/realtime`, { method: 'PATCH', headers: managementHeaders(cfg) }, body);
        return json(res, r.data, r.status);
      }

      if (subpath === '/realtime/shutdown' && method === 'POST') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const confirm = url.searchParams.get('confirm');
        if (!confirm) {
          const token = issueConfirmToken('realtime:shutdown', { projectRef: active.projectRef });
          return json(res, { confirmRequired: true, warning: 'Force-kills ALL Realtime connections on this project.', token, retryWith: `?confirm=${token}` }, soft409);
        }
        const payload = consumeConfirmToken(confirm, 'realtime:shutdown');
        if (!payload || payload.projectRef !== active.projectRef) return json(res, { error: 'Invalid or expired confirmation token' }, 403);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/config/realtime/shutdown`, { method: 'POST', headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      // =====================================================================
      // AUTH: USER FACTORS + SIGN-OUT + PASSWORD ROTATE
      // =====================================================================

      const userFactorsMatch = subpath.match(/^\/auth\/users\/([^/]+)\/factors$/);
      if (userFactorsMatch && method === 'GET') {
        const id = userFactorsMatch[1];
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!active || !isProjectConfigured(active)) return json(res, { error: 'Active project not configured' }, 401);
        const r = await httpsReq(projectRestUrl(active, `/auth/v1/admin/users/${encodeURIComponent(id)}/factors`), { headers: projectHeaders(active) });
        return json(res, r.data, r.status);
      }

      const userFactorDeleteMatch = subpath.match(/^\/auth\/users\/([^/]+)\/factors\/([^/]+)$/);
      if (userFactorDeleteMatch && method === 'DELETE') {
        const [, id, factorId] = userFactorDeleteMatch;
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!active || !isProjectConfigured(active)) return json(res, { error: 'Active project not configured' }, 401);
        const r = await httpsReq(projectRestUrl(active, `/auth/v1/admin/users/${encodeURIComponent(id)}/factors/${encodeURIComponent(factorId)}`), { method: 'DELETE', headers: projectHeaders(active) });
        return json(res, r.data, r.status);
      }

      const userSignOutMatch = subpath.match(/^\/auth\/users\/([^/]+)\/sign-out$/);
      if (userSignOutMatch && method === 'POST') {
        const id = userSignOutMatch[1];
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!active || !isProjectConfigured(active)) return json(res, { error: 'Active project not configured' }, 401);
        const body = await readBody(req);
        const scope = (body && body.scope) || 'global';
        // GoTrue has no admin sign-out; the sessions table is the truth. Drop the user's sessions (refresh tokens cascade).
        if (cfg.managementToken) {
          const rr = await runSql(cfg, active.projectRef, `with gone as (delete from auth.sessions where user_id = ${sqlLiteral(id)} returning id) select count(*)::int as sessions from gone`);
          if (rr.status < 400) return json(res, { ok: true, userId: id, scope, sessionsEnded: Array.isArray(rr.data) && rr.data[0] ? rr.data[0].sessions : 0 });
          return json(res, rr.data, rr.status);
        }
        const r = await httpsReq(projectRestUrl(active, `/auth/v1/admin/users/${encodeURIComponent(id)}/logout?scope=${encodeURIComponent(scope)}`), { method: 'POST', headers: projectHeaders(active) }, {});
        return json(res, r.data, r.status);
      }

      if (subpath === '/auth/audit' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!active || !isProjectConfigured(active)) return json(res, { error: 'Active project not configured' }, 401);
        const qs = url.searchParams.toString();
        const r = await httpsReq(projectRestUrl(active, `/auth/v1/admin/audit${qs ? '?' + qs : ''}`), { headers: projectHeaders(active) });
        return json(res, r.data, r.status);
      }

      // Postgres DB password rotate (Management API) -- gated
      if (subpath === '/database/password' && method === 'PATCH') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const confirm = url.searchParams.get('confirm');
        if (!confirm) {
          const token = issueConfirmToken('db:rotate-password', { projectRef: active.projectRef });
          return json(res, { confirmRequired: true, warning: 'Rotates Postgres password. Direct-connection clients will break.', token, retryWith: `?confirm=${token}` }, soft409);
        }
        const payload = consumeConfirmToken(confirm, 'db:rotate-password');
        if (!payload || payload.projectRef !== active.projectRef) return json(res, { error: 'Invalid or expired confirmation token' }, 403);
        const body = await readBody(req);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/database/password`, { method: 'PATCH', headers: managementHeaders(cfg) }, body);
        return json(res, r.data, r.status);
      }

      // =====================================================================
      // OPENAPI SPEC (PostgREST auto-generated for the project)
      // =====================================================================

      if (subpath === '/openapi' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/database/openapi`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      // =====================================================================
      // SNIPPETS
      // =====================================================================

      if (subpath === '/snippets' && method === 'GET') {
        const cfg = readCfg();
        if (!cfg.managementToken) return json(res, { error: 'Not configured' }, 401);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/snippets`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      const snippetMatch = subpath.match(/^\/snippets\/([^/]+)$/);
      if (snippetMatch && method === 'GET') {
        const id = snippetMatch[1];
        const cfg = readCfg();
        if (!cfg.managementToken) return json(res, { error: 'Not configured' }, 401);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/snippets/${encodeURIComponent(id)}`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      // =====================================================================
      // STORAGE: signed-upload URL, bulk sign, info
      // =====================================================================

      if (subpath.match(/^\/storage\/sign-upload\/([^/]+)\/(.+)$/) && method === 'POST') {
        const [, bucket, p] = subpath.match(/^\/storage\/sign-upload\/([^/]+)\/(.+)$/);
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!active || !isProjectConfigured(active)) return json(res, { error: 'Active project not configured' }, 401);
        const r = await httpsReq(projectRestUrl(active, `/storage/v1/object/upload/sign/${encodeURIComponent(bucket)}/${p}`), {
          method: 'POST',
          headers: projectHeaders(active),
        });
        return json(res, r.data, r.status);
      }

      if (subpath.match(/^\/storage\/sign-many\/([^/]+)$/) && method === 'POST') {
        const bucket = subpath.split('/')[3];
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!active || !isProjectConfigured(active)) return json(res, { error: 'Active project not configured' }, 401);
        const body = await readBody(req);
        const r = await httpsReq(projectRestUrl(active, `/storage/v1/object/sign/${encodeURIComponent(bucket)}`), {
          method: 'POST',
          headers: projectHeaders(active),
        }, body);
        return json(res, r.data, r.status);
      }

      // =====================================================================
      // REPO ACCESS (optional, like Sanity plugin)
      // =====================================================================

      if (subpath === '/repo/info' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!active) return json(res, { error: 'No active project' }, 400);
        return json(res, { repoPath: active.repoPath || '', hasRepo: !!active.repoPath });
      }

      if (subpath.startsWith('/repo/file/') && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!active || !active.repoPath) return json(res, { error: 'No repo path configured' }, 400);
        const rel = subpath.slice('/repo/file/'.length);
        const abs = path.join(active.repoPath, rel);
        if (!abs.startsWith(path.resolve(active.repoPath))) return json(res, { error: 'Invalid path' }, 400);
        try {
          const content = fs.readFileSync(abs, 'utf8');
          return json(res, { path: rel, content });
        } catch (e) {
          return json(res, { error: e.message }, 404);
        }
      }

      // =====================================================================
      // ORGANIZATIONS -- full surface
      // =====================================================================

      if (subpath === '/mgmt/organizations' && method === 'POST') {
        const cfg = readCfg();
        if (!cfg.managementToken) return json(res, { error: 'Management token not configured' }, 401);
        const body = await readBody(req);
        if (!body.name) return json(res, { error: 'name required' }, 400);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/organizations`, { method: 'POST', headers: managementHeaders(cfg) }, body);
        return json(res, r.data, r.status);
      }

      const orgBySlug = subpath.match(/^\/mgmt\/organizations\/([^/]+)$/);
      if (orgBySlug && method === 'GET') {
        const cfg = readCfg();
        if (!cfg.managementToken) return json(res, { error: 'Management token not configured' }, 401);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/organizations/${encodeURIComponent(orgBySlug[1])}`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      const orgMembers = subpath.match(/^\/mgmt\/organizations\/([^/]+)\/members$/);
      if (orgMembers && method === 'GET') {
        const cfg = readCfg();
        if (!cfg.managementToken) return json(res, { error: 'Management token not configured' }, 401);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/organizations/${encodeURIComponent(orgMembers[1])}/members`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      const orgProjects = subpath.match(/^\/mgmt\/organizations\/([^/]+)\/projects$/);
      if (orgProjects && method === 'GET') {
        const cfg = readCfg();
        if (!cfg.managementToken) return json(res, { error: 'Management token not configured' }, 401);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/organizations/${encodeURIComponent(orgProjects[1])}/projects`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      const orgEntitlements = subpath.match(/^\/mgmt\/organizations\/([^/]+)\/entitlements$/);
      if (orgEntitlements && method === 'GET') {
        const cfg = readCfg();
        if (!cfg.managementToken) return json(res, { error: 'Management token not configured' }, 401);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/organizations/${encodeURIComponent(orgEntitlements[1])}/entitlements`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      // Project claim (transfer project into this org)
      const orgClaimGet = subpath.match(/^\/mgmt\/organizations\/([^/]+)\/project-claim\/([^/]+)$/);
      if (orgClaimGet && method === 'GET') {
        const [, slug, token] = orgClaimGet;
        const cfg = readCfg();
        if (!cfg.managementToken) return json(res, { error: 'Management token not configured' }, 401);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/organizations/${encodeURIComponent(slug)}/project-claim/${encodeURIComponent(token)}`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }
      if (orgClaimGet && method === 'POST') {
        const [, slug, token] = orgClaimGet;
        const cfg = readCfg();
        if (!cfg.managementToken) return json(res, { error: 'Management token not configured' }, 401);
        const confirm = url.searchParams.get('confirm');
        if (!confirm) {
          const tok = issueConfirmToken('org:claim', { slug, token });
          return json(res, { confirmRequired: true, warning: 'Transfers a project into this organization.', token: tok, retryWith: `?confirm=${tok}` }, soft409);
        }
        const payload = consumeConfirmToken(confirm, 'org:claim');
        if (!payload || payload.slug !== slug || payload.token !== token) return json(res, { error: 'Invalid or expired confirmation token' }, 403);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/organizations/${encodeURIComponent(slug)}/project-claim/${encodeURIComponent(token)}`, { method: 'POST', headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      // =====================================================================
      // PROJECTS -- create + metadata siblings
      // =====================================================================

      // Create project
      if (subpath === '/mgmt/projects' && method === 'POST') {
        const cfg = readCfg();
        if (!cfg.managementToken) return json(res, { error: 'Management token not configured' }, 401);
        const body = await readBody(req);
        const required = ['organization_id', 'name', 'db_pass', 'region'];
        const missing = required.filter(k => !body[k]);
        if (missing.length) return json(res, { error: `Missing required fields: ${missing.join(', ')}` }, 400);
        const confirm = url.searchParams.get('confirm');
        if (!confirm) {
          const tok = issueConfirmToken('project:create', { name: body.name, organization_id: body.organization_id });
          return json(res, { confirmRequired: true, warning: 'Creates a new Supabase project. Billing may apply to the organization.', name: body.name, organization_id: body.organization_id, region: body.region, plan: body.plan || 'free', token: tok, retryWith: `?confirm=${tok}` }, soft409);
        }
        const payload = consumeConfirmToken(confirm, 'project:create');
        if (!payload || payload.name !== body.name) return json(res, { error: 'Invalid or expired confirmation token' }, 403);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects`, { method: 'POST', headers: managementHeaders(cfg) }, body);
        return json(res, r.data, r.status);
      }

      // Available regions for project creation
      if (subpath === '/mgmt/regions' && method === 'GET') {
        const cfg = readCfg();
        if (!cfg.managementToken) return json(res, { error: 'Management token not configured' }, 401);
        // The API now wants the organization: given as ?org=<slug>, or the first one the token sees.
        let org = url.searchParams.get('org');
        if (!org) { const orgs = await httpsReq(`https://${MANAGEMENT_HOST}/v1/organizations`, { headers: managementHeaders(cfg) }); org = Array.isArray(orgs.data) && orgs.data[0] ? (orgs.data[0].slug || orgs.data[0].id) : ''; }
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/available-regions?organization_slug=${encodeURIComponent(org)}`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      // Update project (name / metadata)
      if (subpath === '/mgmt/project' && method === 'PATCH') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const body = await readBody(req);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}`, { method: 'PATCH', headers: managementHeaders(cfg) }, body);
        return json(res, r.data, r.status);
      }

      // Project service health (db/auth/rest/realtime/storage/functions)
      if (subpath === '/mgmt/project/health' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const services = url.searchParams.get('services') || 'db,auth,rest,realtime,storage';
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/health?services=${encodeURIComponent(services)}`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      // Read-only mode
      if (subpath === '/mgmt/project/readonly' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/readonly`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      if (subpath === '/mgmt/project/readonly/disable' && method === 'POST') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/readonly/temporary-disable`, { method: 'POST', headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      // Restart project (services)
      if (subpath === '/mgmt/project/restart-services' && method === 'POST') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const body = await readBody(req);
        const confirm = url.searchParams.get('confirm');
        if (!confirm) {
          const tok = issueConfirmToken('project:restart', { projectRef: active.projectRef });
          return json(res, { confirmRequired: true, warning: 'Restarts project services. Brief downtime.', token: tok, retryWith: `?confirm=${tok}` }, soft409);
        }
        const payload = consumeConfirmToken(confirm, 'project:restart');
        if (!payload || payload.projectRef !== active.projectRef) return json(res, { error: 'Invalid or expired confirmation token' }, 403);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/restart-services`, { method: 'POST', headers: managementHeaders(cfg) }, body || {});
        return json(res, r.data, r.status);
      }

      // =====================================================================
      // BILLING ADDONS (compute, disk, pitr, custom-domain, etc.)
      // =====================================================================

      if (subpath === '/mgmt/addons' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/billing/addons`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      if (subpath === '/mgmt/addons' && method === 'PATCH') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const body = await readBody(req);
        if (!body.addon_type || !body.addon_variant) return json(res, { error: 'addon_type and addon_variant required' }, 400);
        const confirm = url.searchParams.get('confirm');
        if (!confirm) {
          const tok = issueConfirmToken('addon:apply', { projectRef: active.projectRef, payload: body });
          return json(res, { confirmRequired: true, warning: 'Applies an addon. May change monthly cost.', addon_type: body.addon_type, addon_variant: body.addon_variant, token: tok, retryWith: `?confirm=${tok}` }, soft409);
        }
        const payload = consumeConfirmToken(confirm, 'addon:apply');
        if (!payload || payload.projectRef !== active.projectRef) return json(res, { error: 'Invalid or expired confirmation token' }, 403);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/billing/addons`, { method: 'PATCH', headers: managementHeaders(cfg) }, body);
        return json(res, r.data, r.status);
      }

      const addonRemove = subpath.match(/^\/mgmt\/addons\/([^/]+)$/);
      if (addonRemove && method === 'DELETE') {
        const variant = addonRemove[1];
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const confirm = url.searchParams.get('confirm');
        if (!confirm) {
          const tok = issueConfirmToken('addon:remove', { projectRef: active.projectRef, variant });
          return json(res, { confirmRequired: true, warning: 'Removes an addon. May revert compute size or remove features.', variant, token: tok, retryWith: `?confirm=${tok}` }, soft409);
        }
        const payload = consumeConfirmToken(confirm, 'addon:remove');
        if (!payload || payload.projectRef !== active.projectRef || payload.variant !== variant) return json(res, { error: 'Invalid or expired confirmation token' }, 403);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/billing/addons/${encodeURIComponent(variant)}`, { method: 'DELETE', headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      // =====================================================================
      // DISK CONFIG
      // =====================================================================

      if (subpath === '/mgmt/disk' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/config/disk`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      if (subpath === '/mgmt/disk' && method === 'POST') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const body = await readBody(req);
        const confirm = url.searchParams.get('confirm');
        if (!confirm) {
          const tok = issueConfirmToken('disk:modify', { projectRef: active.projectRef });
          return json(res, { confirmRequired: true, warning: 'Modifies disk. May incur additional charges.', token: tok, retryWith: `?confirm=${tok}` }, soft409);
        }
        const payload = consumeConfirmToken(confirm, 'disk:modify');
        if (!payload || payload.projectRef !== active.projectRef) return json(res, { error: 'Invalid or expired confirmation token' }, 403);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/config/disk`, { method: 'POST', headers: managementHeaders(cfg) }, body);
        return json(res, r.data, r.status);
      }

      if (subpath === '/mgmt/disk/autoscale' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/config/disk/autoscale`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      if (subpath === '/mgmt/disk/util' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/config/disk/util`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      // =====================================================================
      // POSTGRES CONFIG (PUT)
      // =====================================================================

      if (subpath === '/mgmt/postgres-config' && method === 'PUT') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const body = await readBody(req);
        const confirm = url.searchParams.get('confirm');
        if (!confirm) {
          const tok = issueConfirmToken('pgconfig:update', { projectRef: active.projectRef });
          return json(res, { confirmRequired: true, warning: 'Updates Postgres runtime settings. May trigger a restart.', token: tok, retryWith: `?confirm=${tok}` }, soft409);
        }
        const payload = consumeConfirmToken(confirm, 'pgconfig:update');
        if (!payload || payload.projectRef !== active.projectRef) return json(res, { error: 'Invalid or expired confirmation token' }, 403);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/config/database/postgres`, { method: 'PUT', headers: managementHeaders(cfg) }, body);
        return json(res, r.data, r.status);
      }

      // PgBouncer (legacy) config (GET only, read-only)
      if (subpath === '/mgmt/pgbouncer-config' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/config/database/pgbouncer`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      // =====================================================================
      // DATABASE CONTEXT + BACKUPS EXTENDED
      // =====================================================================

      if (subpath === '/database/context' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/database/context`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      if (subpath === '/backups/restore-points' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/database/backups/restore-point`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      if (subpath === '/backups/restore-points' && method === 'POST') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const body = await readBody(req);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/database/backups/restore-point`, { method: 'POST', headers: managementHeaders(cfg) }, body || {});
        return json(res, r.data, r.status);
      }

      if (subpath === '/backups/undo' && method === 'POST') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const body = await readBody(req);
        const confirm = url.searchParams.get('confirm');
        if (!confirm) {
          const tok = issueConfirmToken('backup:undo', { projectRef: active.projectRef });
          return json(res, { confirmRequired: true, warning: 'Rolls the database back to a named restore point. Irreversible via this endpoint.', token: tok, retryWith: `?confirm=${tok}` }, soft409);
        }
        const payload = consumeConfirmToken(confirm, 'backup:undo');
        if (!payload || payload.projectRef !== active.projectRef) return json(res, { error: 'Invalid or expired confirmation token' }, 403);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/database/backups/undo`, { method: 'POST', headers: managementHeaders(cfg) }, body || {});
        return json(res, r.data, r.status);
      }

      // =====================================================================
      // MIGRATIONS EXTENDED
      // =====================================================================

      const migByVersion = subpath.match(/^\/migrations\/([^/]+)$/);
      if (migByVersion && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/database/migrations/${encodeURIComponent(migByVersion[1])}`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }
      if (migByVersion && method === 'PATCH') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const body = await readBody(req);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/database/migrations/${encodeURIComponent(migByVersion[1])}`, { method: 'PATCH', headers: managementHeaders(cfg) }, body);
        return json(res, r.data, r.status);
      }

      if (subpath === '/migrations' && method === 'PUT') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const body = await readBody(req);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/database/migrations`, { method: 'PUT', headers: managementHeaders(cfg) }, body);
        return json(res, r.data, r.status);
      }
      if (subpath === '/migrations' && method === 'DELETE') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const body = await readBody(req);
        const confirm = url.searchParams.get('confirm');
        if (!confirm) {
          const tok = issueConfirmToken('migrations:rollback', { projectRef: active.projectRef });
          return json(res, { confirmRequired: true, warning: 'Rolls back migrations. May alter schema irreversibly.', token: tok, retryWith: `?confirm=${tok}` }, soft409);
        }
        const payload = consumeConfirmToken(confirm, 'migrations:rollback');
        if (!payload || payload.projectRef !== active.projectRef) return json(res, { error: 'Invalid or expired confirmation token' }, 403);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/database/migrations`, { method: 'DELETE', headers: managementHeaders(cfg) }, body || {});
        return json(res, r.data, r.status);
      }

      // =====================================================================
      // EDGE FUNCTIONS EXTENDED (create, bulk, download body)
      // =====================================================================

      if (subpath === '/edge/functions' && method === 'POST') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const body = await readBody(req);
        if (!body.slug) return json(res, { error: 'slug required' }, 400);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/functions`, { method: 'POST', headers: managementHeaders(cfg) }, body);
        return json(res, r.data, r.status);
      }

      if (subpath === '/edge/functions' && method === 'PUT') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const body = await readBody(req);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/functions`, { method: 'PUT', headers: managementHeaders(cfg) }, body);
        return json(res, r.data, r.status);
      }

      const fnBody = subpath.match(/^\/edge\/functions\/([^/]+)\/body$/);
      if (fnBody && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/functions/${encodeURIComponent(fnBody[1])}/body`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      // =====================================================================
      // THIRD-PARTY AUTH (Firebase / Auth0 / Cognito import)
      // =====================================================================

      if (subpath === '/auth/third-party' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/config/auth/third-party-auth`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }
      if (subpath === '/auth/third-party' && method === 'POST') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const body = await readBody(req);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/config/auth/third-party-auth`, { method: 'POST', headers: managementHeaders(cfg) }, body);
        return json(res, r.data, r.status);
      }

      const tpaById = subpath.match(/^\/auth\/third-party\/([^/]+)$/);
      if (tpaById && method === 'DELETE') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/config/auth/third-party-auth/${encodeURIComponent(tpaById[1])}`, { method: 'DELETE', headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      // =====================================================================
      // ACTIONS (dashboard Activity tab)
      // =====================================================================

      if (subpath === '/mgmt/actions' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const qs = url.searchParams.toString();
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/actions${qs ? '?' + qs : ''}`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      const actionById = subpath.match(/^\/mgmt\/actions\/([^/]+)$/);
      if (actionById && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/actions/${encodeURIComponent(actionById[1])}`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      const actionLogs = subpath.match(/^\/mgmt\/actions\/([^/]+)\/logs$/);
      if (actionLogs && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/actions/${encodeURIComponent(actionLogs[1])}/logs`, { headers: managementHeaders(cfg) });
        return json(res, r.data, r.status);
      }

      const actionStatus = subpath.match(/^\/mgmt\/actions\/([^/]+)\/status$/);
      if (actionStatus && method === 'PATCH') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const body = await readBody(req);
        const r = await httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}/actions/${encodeURIComponent(actionStatus[1])}/status`, { method: 'PATCH', headers: managementHeaders(cfg) }, body);
        return json(res, r.data, r.status);
      }

      // =====================================================================
      // DEEP STATS -- SQL-backed (dashboard "Database Reports" page)
      // =====================================================================

      if (subpath === '/stats/db' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await runSql(cfg, active.projectRef, `
          select
            pg_database_size(current_database()) as size_bytes,
            (select count(*) from pg_stat_activity) as active_connections,
            (select count(*) from pg_stat_activity where state='idle') as idle_connections,
            (select count(*) from pg_stat_activity where state='active') as running_queries,
            (select setting::int from pg_settings where name='max_connections') as max_connections,
            current_database() as database,
            version() as pg_version,
            (select pg_postmaster_start_time()) as started_at,
            (select now()) as now
        `, { readOnly: true });
        return json(res, r.data, r.status);
      }

      if (subpath === '/stats/tables' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const schema = url.searchParams.get('schema');
        const r = await runSql(cfg, active.projectRef, `
          select
            schemaname as schema,
            relname as name,
            n_live_tup as live_rows,
            n_dead_tup as dead_rows,
            pg_total_relation_size(relid) as total_bytes,
            pg_relation_size(relid) as table_bytes,
            pg_indexes_size(relid) as index_bytes,
            seq_scan, seq_tup_read, idx_scan, idx_tup_fetch,
            n_tup_ins as inserts, n_tup_upd as updates, n_tup_del as deletes,
            last_vacuum, last_autovacuum, last_analyze, last_autoanalyze
          from pg_stat_user_tables
          ${schema ? `where schemaname = ${q(schema)}` : ''}
          order by pg_total_relation_size(relid) desc
          limit 100
        `, { readOnly: true });
        return json(res, r.data, r.status);
      }

      if (subpath === '/stats/indexes' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await runSql(cfg, active.projectRef, `
          select
            schemaname as schema,
            relname as table,
            indexrelname as index,
            idx_scan as scans,
            idx_tup_read as tuples_read,
            idx_tup_fetch as tuples_fetched,
            pg_relation_size(indexrelid) as bytes
          from pg_stat_user_indexes
          order by idx_scan desc
          limit 200
        `, { readOnly: true });
        return json(res, r.data, r.status);
      }

      if (subpath === '/stats/unused-indexes' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await runSql(cfg, active.projectRef, `
          select
            s.schemaname as schema,
            s.relname as table,
            s.indexrelname as index,
            s.idx_scan as scans,
            pg_relation_size(s.indexrelid) as bytes
          from pg_stat_user_indexes s
          join pg_index i on i.indexrelid = s.indexrelid
          where s.idx_scan = 0
            and not i.indisprimary
            and not i.indisunique
          order by pg_relation_size(s.indexrelid) desc
        `, { readOnly: true });
        return json(res, r.data, r.status);
      }

      if (subpath === '/stats/slow-queries' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const limit = parseInt(url.searchParams.get('limit') || '50', 10);
        const r = await runSql(cfg, active.projectRef, `
          select
            query,
            calls,
            total_exec_time,
            mean_exec_time,
            min_exec_time,
            max_exec_time,
            rows,
            shared_blks_hit,
            shared_blks_read
          from pg_stat_statements
          order by total_exec_time desc
          limit ${Math.min(Math.max(limit, 1), 500)}
        `, { readOnly: true });
        if (r.status >= 400 && /pg_stat_statements/.test(JSON.stringify(r.data || ''))) return json(res, { unavailable: true, rows: [], note: 'pg_stat_statements is not enabled on this database.' });
        return json(res, r.data, r.status);
      }

      if (subpath === '/stats/long-running' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const minMinutes = parseInt(url.searchParams.get('minMinutes') || '5', 10);
        const r = await runSql(cfg, active.projectRef, `
          select
            pid,
            usename,
            application_name,
            state,
            (now() - query_start) as duration,
            wait_event,
            wait_event_type,
            query
          from pg_stat_activity
          where state <> 'idle'
            and now() - query_start > interval '${minMinutes} minutes'
          order by query_start asc
        `, { readOnly: true });
        return json(res, r.data, r.status);
      }

      if (subpath === '/stats/blocking' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await runSql(cfg, active.projectRef, `
          select
            blocked.pid as blocked_pid,
            blocked.usename as blocked_user,
            blocking.pid as blocking_pid,
            blocking.usename as blocking_user,
            blocked.query as blocked_query,
            blocking.query as blocking_query,
            (now() - blocked.query_start) as blocked_duration
          from pg_stat_activity blocked
          join pg_stat_activity blocking on blocking.pid = any(pg_blocking_pids(blocked.pid))
          where blocked.pid <> blocking.pid
        `, { readOnly: true });
        return json(res, r.data, r.status);
      }

      if (subpath === '/stats/locks' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await runSql(cfg, active.projectRef, `
          select
            l.locktype,
            coalesce(l.relation::regclass::text, '-') as relation,
            l.mode,
            l.granted,
            l.pid,
            a.usename,
            a.query
          from pg_locks l
          left join pg_stat_activity a on a.pid = l.pid
          where l.pid <> pg_backend_pid()
          order by l.granted, l.pid
        `, { readOnly: true });
        return json(res, r.data, r.status);
      }

      if (subpath === '/stats/cache-hit' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await runSql(cfg, active.projectRef, `
          select
            'heap' as kind,
            sum(heap_blks_read) as blocks_read,
            sum(heap_blks_hit) as blocks_hit,
            case when sum(heap_blks_hit + heap_blks_read) = 0 then null
                 else sum(heap_blks_hit)::float / sum(heap_blks_hit + heap_blks_read) end as hit_ratio
          from pg_statio_user_tables
          union all
          select
            'index' as kind,
            sum(idx_blks_read),
            sum(idx_blks_hit),
            case when sum(idx_blks_hit + idx_blks_read) = 0 then null
                 else sum(idx_blks_hit)::float / sum(idx_blks_hit + idx_blks_read) end
          from pg_statio_user_indexes
        `, { readOnly: true });
        return json(res, r.data, r.status);
      }

      if (subpath === '/stats/vacuum' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await runSql(cfg, active.projectRef, `
          select
            schemaname as schema,
            relname as table,
            n_live_tup as live_rows,
            n_dead_tup as dead_rows,
            case when n_live_tup > 0 then round((n_dead_tup::numeric / n_live_tup) * 100, 2) else null end as dead_pct,
            last_vacuum,
            last_autovacuum,
            last_analyze,
            last_autoanalyze,
            vacuum_count,
            autovacuum_count
          from pg_stat_user_tables
          order by n_dead_tup desc
          limit 100
        `, { readOnly: true });
        return json(res, r.data, r.status);
      }

      if (subpath === '/stats/replication-slots' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await runSql(cfg, active.projectRef, `
          select
            slot_name,
            plugin,
            slot_type,
            database,
            active,
            restart_lsn,
            confirmed_flush_lsn,
            pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) as restart_lag_bytes,
            pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn) as confirmed_lag_bytes
          from pg_replication_slots
        `, { readOnly: true });
        return json(res, r.data, r.status);
      }

      if (subpath === '/stats/roles' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await runSql(cfg, active.projectRef, `
          select
            coalesce(usename, '<anon>') as role,
            count(*) as total,
            count(*) filter (where state = 'active') as active,
            count(*) filter (where state = 'idle') as idle,
            count(*) filter (where state = 'idle in transaction') as idle_in_tx
          from pg_stat_activity
          group by usename
          order by total desc
        `, { readOnly: true });
        return json(res, r.data, r.status);
      }

      if (subpath === '/stats/bucket-sizes' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await runSql(cfg, active.projectRef, `
          select
            b.id,
            b.name,
            b.public,
            b.file_size_limit,
            count(o.id) as object_count,
            coalesce(sum((o.metadata->>'size')::bigint), 0) as total_bytes,
            max(o.created_at) as last_upload
          from storage.buckets b
          left join storage.objects o on o.bucket_id = b.id
          group by b.id, b.name, b.public, b.file_size_limit
          order by total_bytes desc
        `, { readOnly: true });
        return json(res, r.data, r.status);
      }

      // =====================================================================
      // DEEP AUTH STATS (SQL-backed against auth schema)
      // =====================================================================

      if (subpath === '/stats/auth/summary' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await runSql(cfg, active.projectRef, `
          select
            count(*) as total_users,
            count(*) filter (where email_confirmed_at is not null) as confirmed_users,
            count(*) filter (where email_confirmed_at is null) as unconfirmed_users,
            count(*) filter (where banned_until > now()) as banned_users,
            count(*) filter (where is_anonymous) as anonymous_users,
            count(*) filter (where created_at > now() - interval '24 hours') as signups_last_24h,
            count(*) filter (where created_at > now() - interval '7 days') as signups_last_7d,
            count(*) filter (where created_at > now() - interval '30 days') as signups_last_30d,
            count(*) filter (where last_sign_in_at > now() - interval '24 hours') as active_24h,
            count(*) filter (where last_sign_in_at > now() - interval '7 days') as active_7d,
            count(*) filter (where last_sign_in_at > now() - interval '30 days') as active_30d
          from auth.users
        `, { readOnly: true });
        return json(res, r.data, r.status);
      }

      if (subpath === '/stats/auth/growth' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const days = parseInt(url.searchParams.get('days') || '30', 10);
        const r = await runSql(cfg, active.projectRef, `
          with d as (
            select generate_series(
              date_trunc('day', now()) - interval '${Math.min(Math.max(days,1),365) - 1} days',
              date_trunc('day', now()),
              interval '1 day'
            )::date as day
          )
          select
            d.day,
            (select count(*) from auth.users u where date_trunc('day', u.created_at) = d.day) as signups,
            (select count(*) from auth.users u where date_trunc('day', u.last_sign_in_at) = d.day) as sign_ins
          from d
          order by d.day
        `, { readOnly: true });
        return json(res, r.data, r.status);
      }

      if (subpath === '/stats/auth/providers' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await runSql(cfg, active.projectRef, `
          select
            provider,
            count(*) as identity_count,
            count(distinct user_id) as user_count,
            max(updated_at) as last_used
          from auth.identities
          group by provider
          order by identity_count desc
        `, { readOnly: true });
        return json(res, r.data, r.status);
      }

      if (subpath === '/stats/auth/mfa' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await runSql(cfg, active.projectRef, `
          select
            factor_type,
            status,
            count(*) as count
          from auth.mfa_factors
          group by factor_type, status
          order by count desc
        `, { readOnly: true });
        return json(res, r.data, r.status);
      }

      if (subpath === '/stats/auth/sessions' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await runSql(cfg, active.projectRef, `
          select
            count(*) as total_sessions,
            count(*) filter (where not_after is null or not_after > now()) as active_sessions,
            count(*) filter (where refreshed_at > now() - interval '24 hours') as refreshed_24h,
            count(distinct user_id) as distinct_users
          from auth.sessions
        `, { readOnly: true });
        return json(res, r.data, r.status);
      }

      // Per-user deep info (sessions + identities + MFA in one shot via SQL)
      const userDetail = subpath.match(/^\/auth\/users\/([^/]+)\/detail$/);
      if (userDetail && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const id = userDetail[1];
        const r = await runSql(cfg, active.projectRef, `
          select
            (select row_to_json(u) from auth.users u where u.id = ${q(id)}::uuid) as user,
            (select coalesce(json_agg(row_to_json(i)), '[]'::json) from auth.identities i where i.user_id = ${q(id)}::uuid) as identities,
            (select coalesce(json_agg(row_to_json(s)), '[]'::json) from auth.sessions s where s.user_id = ${q(id)}::uuid) as sessions,
            (select coalesce(json_agg(row_to_json(m)), '[]'::json) from auth.mfa_factors m where m.user_id = ${q(id)}::uuid) as mfa_factors,
            (select count(*) from auth.audit_log_entries where (payload->>'actor_id')::text = ${q(id)}) as audit_events
        `, { readOnly: true });
        return json(res, r.data, r.status);
      }

      // =====================================================================
      // REALTIME CHANNELS (via realtime admin HTTP API on project host)
      // =====================================================================

      if (subpath === '/realtime/channels' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!active || !isProjectConfigured(active)) return json(res, { error: 'Active project not configured' }, 401);
        const r = await httpsReq(projectRestUrl(active, `/realtime/v1/api/channels`), { headers: projectHeaders(active) });
        return json(res, r.data, r.status);
      }

      if (subpath === '/realtime/tenants/health' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!active || !isProjectConfigured(active)) return json(res, { error: 'Active project not configured' }, 401);
        const r = await httpsReq(projectRestUrl(active, `/realtime/v1/api/tenants/_health`), { headers: projectHeaders(active) });
        return json(res, r.data, r.status);
      }

      // =====================================================================
      // COMPREHENSIVE STATS BUNDLE (for dashboard "Stats" tab, one-shot)
      // =====================================================================

      if (subpath === '/stats/overview' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const r = await runSql(cfg, active.projectRef, `
          select
            jsonb_build_object(
              'database', (select row_to_json(d) from (
                select
                  pg_database_size(current_database()) as size_bytes,
                  (select count(*) from pg_stat_activity) as connections,
                  (select setting::int from pg_settings where name='max_connections') as max_connections,
                  version() as pg_version
              ) d),
              'auth', (select row_to_json(a) from (
                select
                  count(*) as total_users,
                  count(*) filter (where email_confirmed_at is not null) as confirmed,
                  count(*) filter (where is_anonymous) as anonymous,
                  count(*) filter (where banned_until > now()) as banned,
                  count(*) filter (where created_at > now() - interval '24 hours') as signups_24h,
                  count(*) filter (where last_sign_in_at > now() - interval '24 hours') as active_24h
                from auth.users
              ) a),
              'storage', (select row_to_json(s) from (
                select
                  (select count(*) from storage.buckets) as buckets,
                  (select count(*) from storage.objects) as objects,
                  (select coalesce(sum((metadata->>'size')::bigint), 0) from storage.objects) as bytes
              ) s),
              'schema_counts', (select row_to_json(c) from (
                select
                  (select count(*) from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE') as public_tables,
                  (select count(*) from pg_policies where schemaname = 'public') as public_policies,
                  (select count(*) from pg_matviews where schemaname = 'public') as public_matviews,
                  (select count(*) from information_schema.routines where routine_schema = 'public') as public_functions,
                  (select count(*) from pg_trigger where not tgisinternal) as triggers,
                  (select count(*) from pg_extension) as extensions
              ) c)
            ) as overview
        `, { readOnly: true });
        return json(res, r.data, r.status);
      }

      // =====================================================================
      // USAGE (daily counts aggregated from logs)
      // =====================================================================

      // =====================================================================
      // 3.0 SURFACE: the project at a glance, one table in full, insights
      // =====================================================================

      if (subpath === '/overview' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken) return json(res, { error: 'Management token not configured' }, 401);
        if (!active) return json(res, { error: 'No active project' }, 400);
        const refresh = url.searchParams.get('refresh') === '1';
        const cached = overviewCache.get(active.projectRef);
        if (!refresh && cached && Date.now() - cached.ts < 60000) return json(res, cached.data);
        const out = { name: active.name, projectRef: active.projectRef, url: active.url, repoPath: active.repoPath || '', dashboardUrl: `https://supabase.com/dashboard/project/${active.projectRef}`, keys: { serviceRole: !!active.serviceRoleKey, anon: !!active.anonKey }, services: [], project: null, database: null, auth: null, storage: null, counts: null, tables: [], buckets: [], functions: [], advisors: { errors: 0, warnings: 0, info: 0, security: 0, performance: 0 }, disk: null, backups: null, migrations: 0, recentUsers: [], issues: [] };
        const mgmt = (p) => httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}${p}`, { headers: managementHeaders(cfg) }).then((r) => (r.status < 400 ? r.data : null)).catch(() => null);
        const [health, project, stats, tables, buckets, fns, sec, perf, disk, backups, migrations, recent] = await Promise.all([
          mgmt('/health?services=db,auth,rest,realtime,storage'),
          httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}`, { headers: managementHeaders(cfg) }).then((r) => (r.status < 400 ? r.data : null)).catch(() => null),
          runSql(cfg, active.projectRef, `
            select jsonb_build_object(
              'database', (select row_to_json(d) from (select pg_database_size(current_database()) as size_bytes, (select count(*) from pg_stat_activity) as connections, (select setting::int from pg_settings where name='max_connections') as max_connections, version() as pg_version, (select pg_postmaster_start_time()) as started_at) d),
              'auth', (select row_to_json(a) from (select count(*) as total_users, count(*) filter (where email_confirmed_at is not null) as confirmed, count(*) filter (where is_anonymous) as anonymous, count(*) filter (where banned_until > now()) as banned, count(*) filter (where created_at > now() - interval '7 days') as signups_7d, count(*) filter (where last_sign_in_at > now() - interval '7 days') as active_7d, count(*) filter (where created_at > now() - interval '24 hours') as signups_24h, count(*) filter (where last_sign_in_at > now() - interval '24 hours') as active_24h from auth.users) a),
              'storage', (select row_to_json(s) from (select (select count(*) from storage.buckets) as buckets, (select count(*) from storage.objects) as objects, (select coalesce(sum((metadata->>'size')::bigint), 0) from storage.objects) as bytes) s),
              'counts', (select row_to_json(c) from (select (select count(*) from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE') as public_tables, (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','p') and not c.relrowsecurity) as tables_without_rls, (select count(*) from pg_policies where schemaname = 'public') as public_policies, (select count(*) from pg_matviews where schemaname = 'public') as public_matviews, (select count(*) from information_schema.routines where routine_schema = 'public') as public_functions, (select count(*) from pg_trigger where not tgisinternal) as triggers, (select count(*) from pg_extension) as extensions, (select count(*) from pg_catalog.pg_namespace where nspname not like 'pg_%' and nspname not in ('information_schema','pg_toast','extensions','graphql','graphql_public','pgsodium','pgsodium_masks','realtime','supabase_functions','vault','net','cron','pgbouncer','auth','storage','supabase_migrations')) as user_schemas) c)
            ) as overview`, { readOnly: true }).then((r) => (r.status < 400 && r.data && r.data[0] ? r.data[0].overview : null)).catch(() => null),
          runSql(cfg, active.projectRef, `select c.relname as name, n.nspname as schema, pg_total_relation_size(c.oid) as size_bytes, c.reltuples::bigint as approx_rows, c.relrowsecurity as rls_enabled, (select count(*) from pg_policies p where p.schemaname = n.nspname and p.tablename = c.relname) as policies, exists(select 1 from pg_index i where i.indrelid = c.oid and i.indisprimary) as has_pk from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r','p') and n.nspname = 'public' order by pg_total_relation_size(c.oid) desc`, { readOnly: true }).then((r) => (r.status < 400 && Array.isArray(r.data) ? r.data : [])).catch(() => []),
          isProjectConfigured(active) ? httpsReq(projectRestUrl(active, '/storage/v1/bucket'), { headers: projectHeaders(active) }).then((r) => (r.status < 400 && Array.isArray(r.data) ? r.data : [])).catch(() => []) : Promise.resolve([]),
          mgmt('/functions'),
          mgmt('/advisors/security'),
          mgmt('/advisors/performance'),
          mgmt('/config/disk/util'),
          mgmt('/database/backups'),
          mgmt('/database/migrations'),
          runSql(cfg, active.projectRef, `select id, email, created_at, last_sign_in_at, raw_app_meta_data->>'provider' as provider, email_confirmed_at is not null as confirmed, banned_until > now() as banned from auth.users order by created_at desc limit 8`, { readOnly: true }).then((r) => (r.status < 400 && Array.isArray(r.data) ? r.data : [])).catch(() => []),
        ]);
        out.services = Array.isArray(health) ? health.map((s) => ({ name: s.name, healthy: !!s.healthy, status: s.status, version: s.info && s.info.version })) : [];
        if (project) out.project = { status: project.status, region: project.region, createdAt: project.created_at, organizationId: project.organization_id, postgresVersion: project.database && project.database.version, engine: project.database && project.database.postgres_engine };
        if (stats) { out.database = stats.database; out.auth = stats.auth; out.storage = stats.storage; out.counts = stats.counts; }
        out.tables = tables;
        out.buckets = buckets.map((b) => ({ id: b.id, name: b.name, public: !!b.public, fileSizeLimit: b.file_size_limit, allowed: b.allowed_mime_types || null, createdAt: b.created_at }));
        out.functions = Array.isArray(fns) ? fns.map((f) => ({ id: f.id, slug: f.slug, name: f.name, status: f.status, version: f.version, verifyJwt: f.verify_jwt, updatedAt: f.updated_at })) : [];
        for (const [kind, data] of [['security', sec], ['performance', perf]]) { for (const l of ((data && data.lints) || [])) { out.advisors[kind]++; if (l.level === 'ERROR') out.advisors.errors++; else if (l.level === 'WARN') out.advisors.warnings++; else out.advisors.info++; } }
        if (disk && disk.metrics) out.disk = { sizeBytes: disk.metrics.fs_size_bytes, usedBytes: disk.metrics.fs_used_bytes, availBytes: disk.metrics.fs_avail_bytes, at: disk.timestamp };
        if (backups) out.backups = { pitr: !!backups.pitr_enabled, walg: !!backups.walg_enabled, region: backups.region, count: Array.isArray(backups.backups) ? backups.backups.length : 0, latest: Array.isArray(backups.backups) && backups.backups.length ? backups.backups[backups.backups.length - 1] : null };
        out.migrations = Array.isArray(migrations) ? migrations.length : 0;
        out.recentUsers = recent;
        const down = out.services.filter((s) => !s.healthy);
        if (down.length) out.issues.push({ level: 'error', issue: 'service', message: `${down.map((s) => s.name).join(', ')} ${down.length === 1 ? 'is' : 'are'} not healthy.` });
        if (out.advisors.errors) out.issues.push({ level: 'error', issue: 'advisor', message: `${out.advisors.errors} advisor error${out.advisors.errors === 1 ? '' : 's'} (security or performance).` });
        if (out.counts && out.counts.tables_without_rls) out.issues.push({ level: 'warn', issue: 'rls', message: `${out.counts.tables_without_rls} public table${out.counts.tables_without_rls === 1 ? '' : 's'} without row level security.` });
        if (out.advisors.warnings) out.issues.push({ level: 'warn', issue: 'advisor', message: `${out.advisors.warnings} advisor warning${out.advisors.warnings === 1 ? '' : 's'}.` });
        if (out.disk && out.disk.sizeBytes && out.disk.usedBytes / out.disk.sizeBytes > 0.8) out.issues.push({ level: 'warn', issue: 'disk', message: `Disk is ${Math.round(out.disk.usedBytes / out.disk.sizeBytes * 100)}% full.` });
        if (out.database && out.database.max_connections && out.database.connections / out.database.max_connections > 0.8) out.issues.push({ level: 'warn', issue: 'connections', message: `${out.database.connections} of ${out.database.max_connections} connections in use.` });
        if (out.backups && !out.backups.pitr) out.issues.push({ level: 'info', issue: 'backups', message: 'Point-in-time recovery is off; only daily backups apply.' });
        if (!active.serviceRoleKey) out.issues.push({ level: 'warn', issue: 'keys', message: 'No service role key on this project: rows, auth, storage and functions cannot be reached.' });
        overviewCache.set(active.projectRef, { ts: Date.now(), data: out });
        return json(res, out);
      }

      if (subpath === '/table' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const schema = url.searchParams.get('schema') || 'public';
        const table = url.searchParams.get('name');
        if (!table) return json(res, { error: 'name required' }, 400);
        const r = await runSql(cfg, active.projectRef, `
          select jsonb_build_object(
            'table', (select row_to_json(t) from (select c.relname as name, n.nspname as schema, case c.relkind when 'r' then 'table' when 'v' then 'view' when 'm' then 'materialized_view' when 'p' then 'partitioned_table' when 'f' then 'foreign_table' end as kind, obj_description(c.oid) as comment, pg_total_relation_size(c.oid) as size_bytes, pg_relation_size(c.oid) as table_bytes, pg_indexes_size(c.oid) as index_bytes, c.reltuples::bigint as approx_rows, c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = ${q(schema)} and c.relname = ${q(table)}) t),
            'columns', (select coalesce(json_agg(row_to_json(col) order by col.ordinal), '[]'::json) from (select a.attnum as ordinal, a.attname as name, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as not_null, pg_get_expr(ad.adbin, ad.adrelid) as default_value, coalesce(i.indisprimary, false) as is_primary_key, col_description(a.attrelid, a.attnum) as comment, a.attidentity <> '' as identity, a.attgenerated <> '' as generated, (select json_build_object('schema', fn.nspname, 'table', fc.relname, 'column', fa.attname) from pg_constraint con join pg_class fc on fc.oid = con.confrelid join pg_namespace fn on fn.oid = fc.relnamespace join pg_attribute fa on fa.attrelid = con.confrelid and fa.attnum = con.confkey[1] where con.conrelid = a.attrelid and con.contype = 'f' and a.attnum = con.conkey[1] limit 1) as references from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace left join pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum left join pg_index i on i.indrelid = a.attrelid and a.attnum = any(i.indkey) and i.indisprimary where n.nspname = ${q(schema)} and c.relname = ${q(table)} and a.attnum > 0 and not a.attisdropped) col),
            'indexes', (select coalesce(json_agg(row_to_json(ix)), '[]'::json) from (select i.indexname as name, i.indexdef as definition, coalesce(s.idx_scan, 0) as scans, pg_relation_size((quote_ident(i.schemaname) || '.' || quote_ident(i.indexname))::regclass) as bytes from pg_indexes i left join pg_stat_user_indexes s on s.schemaname = i.schemaname and s.indexrelname = i.indexname where i.schemaname = ${q(schema)} and i.tablename = ${q(table)}) ix),
            'policies', (select coalesce(json_agg(row_to_json(p)), '[]'::json) from (select policyname as name, permissive, roles, cmd as command, qual as using_expression, with_check as check_expression from pg_policies where schemaname = ${q(schema)} and tablename = ${q(table)} order by policyname) p),
            'triggers', (select coalesce(json_agg(row_to_json(tg)), '[]'::json) from (select t.tgname as name, pg_get_triggerdef(t.oid) as definition, t.tgenabled <> 'D' as enabled from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where not t.tgisinternal and n.nspname = ${q(schema)} and c.relname = ${q(table)}) tg),
            'constraints', (select coalesce(json_agg(row_to_json(cn)), '[]'::json) from (select con.conname as name, con.contype as type, pg_get_constraintdef(con.oid) as definition from pg_constraint con join pg_class c on c.oid = con.conrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = ${q(schema)} and c.relname = ${q(table)}) cn),
            'referenced_by', (select coalesce(json_agg(row_to_json(rb)), '[]'::json) from (select n2.nspname as schema, c2.relname as table, con.conname as constraint from pg_constraint con join pg_class c2 on c2.oid = con.conrelid join pg_namespace n2 on n2.oid = c2.relnamespace join pg_class c on c.oid = con.confrelid join pg_namespace n on n.oid = c.relnamespace where con.contype = 'f' and n.nspname = ${q(schema)} and c.relname = ${q(table)}) rb),
            'stats', (select row_to_json(st) from (select n_live_tup as live_rows, n_dead_tup as dead_rows, seq_scan, idx_scan, n_tup_ins as inserts, n_tup_upd as updates, n_tup_del as deletes, last_autovacuum, last_autoanalyze from pg_stat_user_tables where schemaname = ${q(schema)} and relname = ${q(table)}) st)
          ) as detail`, { readOnly: true });
        if (r.status >= 400) return json(res, { error: (r.data && r.data.message) || 'Query failed' }, r.status);
        const d = r.data && r.data[0] ? r.data[0].detail : null;
        if (!d || !d.table) return json(res, { error: 'Table not found' }, 404);
        return json(res, { ...d, dashboardUrl: `https://supabase.com/dashboard/project/${active.projectRef}/editor` });
      }

      if (subpath === '/insights' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const mgmt = (p) => httpsReq(`https://${MANAGEMENT_HOST}/v1/projects/${active.projectRef}${p}`, { headers: managementHeaders(cfg) }).then((r) => (r.status < 400 ? r.data : null)).catch(() => null);
        const sql = (s) => runSql(cfg, active.projectRef, s, { readOnly: true }).then((r) => (r.status < 400 && Array.isArray(r.data) ? r.data : [])).catch(() => []);
        const [sec, perf, noRls, noPk, unused, cache, bloat, longRunning, slow] = await Promise.all([
          mgmt('/advisors/security'), mgmt('/advisors/performance'),
          sql(`select n.nspname as schema, c.relname as name, c.reltuples::bigint as approx_rows from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r','p') and n.nspname = 'public' and not c.relrowsecurity order by c.relname`),
          sql(`select n.nspname as schema, c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r','p') and n.nspname = 'public' and not exists (select 1 from pg_index i where i.indrelid = c.oid and i.indisprimary) order by c.relname`),
          sql(`select s.schemaname as schema, s.relname as table, s.indexrelname as index, pg_relation_size(s.indexrelid) as bytes from pg_stat_user_indexes s join pg_index i on i.indexrelid = s.indexrelid where s.idx_scan = 0 and not i.indisprimary and not i.indisunique and s.schemaname = 'public' order by pg_relation_size(s.indexrelid) desc`),
          sql(`select 'heap' as kind, sum(heap_blks_read) as blocks_read, sum(heap_blks_hit) as blocks_hit, case when sum(heap_blks_hit) + sum(heap_blks_read) = 0 then null else sum(heap_blks_hit)::float / (sum(heap_blks_hit) + sum(heap_blks_read)) end as hit_ratio from pg_statio_user_tables union all select 'index', sum(idx_blks_read), sum(idx_blks_hit), case when sum(idx_blks_hit) + sum(idx_blks_read) = 0 then null else sum(idx_blks_hit)::float / (sum(idx_blks_hit) + sum(idx_blks_read)) end from pg_statio_user_indexes`),
          sql(`select schemaname as schema, relname as name, n_live_tup as live_rows, n_dead_tup as dead_rows, last_autovacuum from pg_stat_user_tables where n_dead_tup > 1000 and n_dead_tup > n_live_tup * 0.2 order by n_dead_tup desc limit 20`),
          sql(`select pid, now() - query_start as duration, state, left(query, 200) as query from pg_stat_activity where state <> 'idle' and query_start < now() - interval '5 minutes' and pid <> pg_backend_pid() order by query_start`),
          runSql(cfg, active.projectRef, `select left(query, 300) as query, calls, round(total_exec_time::numeric, 1) as total_ms, round(mean_exec_time::numeric, 2) as mean_ms, rows from pg_stat_statements where query not like '%pg_stat_statements%' order by total_exec_time desc limit 15`, { readOnly: true }).then((r) => (r.status < 400 && Array.isArray(r.data) ? { rows: r.data } : { unavailable: true })).catch(() => ({ unavailable: true })),
        ]);
        const lints = [];
        for (const [kind, data] of [['security', sec], ['performance', perf]]) for (const l of ((data && data.lints) || [])) lints.push({ kind, name: l.name, title: l.title, level: l.level, detail: String(l.detail || '').replace(/\\`/g, '`'), description: l.description, remediation: l.remediation, schema: l.metadata && l.metadata.schema, object: l.metadata && l.metadata.name, type: l.metadata && l.metadata.type, key: l.cache_key });
        const counts = { lints: lints.length, errors: lints.filter((l) => l.level === 'ERROR').length, warnings: lints.filter((l) => l.level === 'WARN').length, info: lints.filter((l) => l.level === 'INFO').length, security: lints.filter((l) => l.kind === 'security').length, performance: lints.filter((l) => l.kind === 'performance').length, tablesWithoutRls: noRls.length, tablesWithoutPk: noPk.length, unusedIndexes: unused.length, unusedIndexBytes: unused.reduce((n, i) => n + Number(i.bytes || 0), 0), bloated: bloat.length, longRunning: longRunning.length };
        return json(res, { counts, lints, tablesWithoutRls: noRls, tablesWithoutPk: noPk, unusedIndexes: unused, cacheHit: cache, bloated: bloat, longRunning, slowQueries: slow });
      }

      if (subpath === '/usage/daily' && method === 'GET') {
        const cfg = readCfg();
        const active = getActiveProject(cfg);
        if (!cfg.managementToken || !active) return json(res, { error: 'Not configured' }, 401);
        const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '7', 10), 1), 90);
        const r = await runSql(cfg, active.projectRef, `
          with d as (
            select generate_series(
              date_trunc('day', now()) - interval '${days - 1} days',
              date_trunc('day', now()),
              interval '1 day'
            )::date as day
          )
          select
            d.day,
            (select count(*) from auth.users u where date_trunc('day', u.created_at) = d.day) as new_users,
            (select count(*) from auth.users u where date_trunc('day', u.last_sign_in_at) = d.day) as active_users,
            (select count(*) from auth.sessions s where date_trunc('day', s.created_at) = d.day) as new_sessions
          from d
          order by d.day
        `, { readOnly: true });
        return json(res, r.data, r.status);
      }

      return json(res, { error: 'Not found', subpath, method }, 404);
    } catch (err) {
      return json(res, { error: err.message || String(err) }, 500);
    }
  });
};

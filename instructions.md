## Supabase Plugin -- AI Instructions

You have access to a dashboard-class Supabase control plane via the Symphonee API. Every action the Supabase dashboard or CLI performs is reachable here as a REST route AND as a dashboard UI action. The user should never have to leave Symphonee to manage Supabase.

**All routes are at** `http://127.0.0.1:3800/api/plugins/supabase/`

### IMPORTANT: Start every session by fetching context

```bash
curl -s http://127.0.0.1:3800/api/plugins/supabase/config
curl -s http://127.0.0.1:3800/api/plugins/supabase/health
curl -s http://127.0.0.1:3800/api/plugins/supabase/stats/overview   # rich snapshot
```

Covers: whether a Management Personal Access Token (PAT) is set, the active project, Postgres version + schema counts, users, storage, extensions, triggers.

If no PAT or no active project: tell the user to configure the plugin (Settings -> Supabase) before proceeding.

### Multi-project

One global Management PAT (`sbp_...`) is stored at the plugin level and covers every project the user's Supabase account has access to. Each Symphonee-side project config carries: `name`, `projectRef`, `serviceRoleKey`, `anonKey`, `url`, and optionally `repoPath`.

```bash
curl -s http://127.0.0.1:3800/api/plugins/supabase/projects                   # Symphonee-registered
curl -s http://127.0.0.1:3800/api/plugins/supabase/mgmt/projects              # all projects on the account
curl -s -X POST http://127.0.0.1:3800/api/plugins/supabase/projects/active \
  -H "Content-Type: application/json" -d '{"name":"My Project"}'
```

`POST /projects` (Symphonee-local) adds a project to the sidebar list. `POST /mgmt/projects` (below) actually creates a Supabase cloud project.

### Pre-made scripts

From **bash**:
```bash
powershell.exe -ExecutionPolicy Bypass -NoProfile -File "./dashboard/plugins/supabase/scripts/ScriptName.ps1"
powershell.exe -ExecutionPolicy Bypass -NoProfile -Command "./dashboard/plugins/supabase/scripts/ScriptName.ps1 -Param 'value'"
```

| Script | Purpose |
|--------|---------|
| `Get-Projects.ps1` | List Symphonee-registered projects |
| `Add-Project.ps1` | Register an existing Supabase project with Symphonee |
| `Switch-Project.ps1` | Switch the active project |
| `Remove-Project.ps1` | Unregister a project from Symphonee |
| `New-CloudProject.ps1 -Name -OrganizationId -DbPass -Region [-Plan] [-Confirm]` | **Create a new Supabase cloud project** |
| `Get-Regions.ps1` | Available regions for project creation |
| `New-Organization.ps1 -Name` | **Create a new Supabase organization** |
| `Get-Organizations.ps1 [-Slug] [-Members] [-Projects] [-Entitlements]` | List organizations / drill into one |
| `Get-ProjectHealth.ps1 [-Services 'db,auth,...']` | Per-service health status |
| `Restart-Services.ps1 [-Services] [-Confirm]` | Restart project services |
| `Get-Overview.ps1` | Rich overview (DB size, users, storage, schema counts) |
| `Get-DbStats.ps1 -Kind <overview\|tables\|indexes\|unused-indexes\|slow-queries\|long-running\|blocking\|locks\|cache-hit\|vacuum\|replication-slots\|roles\|bucket-sizes>` | **Deep database statistics** |
| `Get-UserStats.ps1 -Kind <summary\|growth\|providers\|mfa\|sessions>` | **Deep auth statistics** |
| `Get-UserDetail.ps1 -UserId` | **Per-user deep info** (user, identities, sessions, MFA, audit count) |
| `Get-Usage.ps1 [-Days 7]` | Daily user/session counts |
| `Get-Addons.ps1` | List billing addons (compute, disk, PITR, custom-domain) |
| `Set-Addon.ps1 -AddonType -AddonVariant [-Confirm]` | Apply/resize compute or other addons |
| `Get-Disk.ps1 [-Util] [-Autoscale]` | Disk config / utilization / autoscale |
| `Get-FunctionBody.ps1 -Slug [-OutFile]` | **Download source of a deployed edge function** |
| `Get-RealtimeChannels.ps1` | Active realtime channels |
| `Get-Health.ps1` | Quick health check (Postgres version, counts) |
| `Get-Summary.ps1` | Simple counts |
| `Invoke-Sql.ps1 -Query [-ReadOnly] [-Force]` | Run SQL (destructive queries prompt) |
| `Get-Tables.ps1 [-Schema]` / `Get-Columns.ps1 -Table` / `Get-Policies.ps1` / `Enable-Rls.ps1` / `New-Policy.ps1` | Schema inspection + RLS |
| `Get-AuthUsers.ps1 [-Page] [-PerPage]` / `New-AuthUser.ps1 -Email -Password` / `Send-MagicLink.ps1 -Email` | Auth admin |
| `Get-Buckets.ps1` / `Get-Objects.ps1 -Bucket` / `New-SignedUrl.ps1 -Bucket -Path [-ExpiresIn]` | Storage |
| `Get-EdgeFunctions.ps1` / `Invoke-EdgeFunction.ps1 -Slug -Body '{}'` | Edge functions |
| `Get-Secrets.ps1` / `Set-Secret.ps1 -Name -Value` | Runtime secrets |
| `Get-Advisors.ps1 [-Kind security\|performance]` | Security + performance advisors |
| `Get-Logs.ps1 -Sql` | Query logs via BigQuery-style SQL |
| `Get-Types.ps1 [-Schemas] [-OutFile]` | Generate TypeScript types |
| `Get-Backups.ps1` | PITR backup windows |
| `New-Migration.ps1 -Name -JsonFile` | Apply a migration |

### The SQL runner

`POST /api/plugins/supabase/sql` proxies `POST https://api.supabase.com/v1/projects/{ref}/database/query`.

```bash
curl -s -X POST http://127.0.0.1:3800/api/plugins/supabase/sql \
  -H "Content-Type: application/json" \
  -d '{"query":"select * from profiles limit 10"}'

curl -s -X POST http://127.0.0.1:3800/api/plugins/supabase/sql/select \
  -H "Content-Type: application/json" \
  -d '{"query":"select count(*) from profiles"}'
```

**Destructive-SQL safety gate.** If your SQL contains `DROP`, `TRUNCATE`, `DELETE` without `WHERE`, or `ALTER ... DROP`, the first call returns 409 with a `confirmRequired` token. Retry within 10 minutes with `?confirm=<token>` on the URL, or set `body.force: true` to skip the gate. Tell the user *what* is about to be destroyed before retrying.

---

### Organizations (full surface)

```bash
# List
curl -s http://127.0.0.1:3800/api/plugins/supabase/mgmt/organizations

# Create (triggers org setup flow -- free plan by default)
curl -s -X POST http://127.0.0.1:3800/api/plugins/supabase/mgmt/organizations \
  -H "Content-Type: application/json" -d '{"name":"My Company"}'

# Drill down by slug
curl -s http://127.0.0.1:3800/api/plugins/supabase/mgmt/organizations/<slug>
curl -s http://127.0.0.1:3800/api/plugins/supabase/mgmt/organizations/<slug>/members
curl -s http://127.0.0.1:3800/api/plugins/supabase/mgmt/organizations/<slug>/projects
curl -s http://127.0.0.1:3800/api/plugins/supabase/mgmt/organizations/<slug>/entitlements   # plan limits/quotas

# Project claim (transfer existing project into this org)
curl -s http://127.0.0.1:3800/api/plugins/supabase/mgmt/organizations/<slug>/project-claim/<token>
curl -s -X POST http://127.0.0.1:3800/api/plugins/supabase/mgmt/organizations/<slug>/project-claim/<token>
```

**Member invite/remove and invoices/billing dollars are NOT on the public Management API.** Don't try to add them -- Supabase dashboard uses a private platform API. Use `entitlements` for quota info.

---

### Projects -- create, update, restart

```bash
# List available regions first
curl -s http://127.0.0.1:3800/api/plugins/supabase/mgmt/regions

# Create a cloud project (gated)
curl -s -X POST http://127.0.0.1:3800/api/plugins/supabase/mgmt/projects \
  -H "Content-Type: application/json" \
  -d '{
    "name":"my-new-project",
    "organization_id":"<org id from /mgmt/organizations>",
    "db_pass":"<strong password>",
    "region":"us-east-1",
    "plan":"free",
    "desired_instance_size":"micro"
  }'
# -> 409 with token -> retry with ?confirm=<token>

# Update project metadata (name, etc.)
curl -s -X PATCH http://127.0.0.1:3800/api/plugins/supabase/mgmt/project \
  -H "Content-Type: application/json" -d '{"name":"new-name"}'

# Service health
curl -s "http://127.0.0.1:3800/api/plugins/supabase/mgmt/project/health?services=db,auth,rest,realtime,storage,functions"

# Read-only mode
curl -s http://127.0.0.1:3800/api/plugins/supabase/mgmt/project/readonly
curl -s -X POST http://127.0.0.1:3800/api/plugins/supabase/mgmt/project/readonly/disable

# Restart services (gated)
curl -s -X POST http://127.0.0.1:3800/api/plugins/supabase/mgmt/project/restart-services \
  -H "Content-Type: application/json" -d '{"services":["auth","rest"]}'

# Pause / Restore / Delete (all gated, already covered elsewhere)
```

After creating a project, Supabase provisions it asynchronously. Wait for `status == "ACTIVE_HEALTHY"` via `/mgmt/project/health`, then the user still has to add it to Symphonee (via `POST /projects`) with the service-role key from `/mgmt/api-keys`.

---

### Billing / Addons

Compute size, disk size/iops/throughput, PITR, custom domain, all live as "addons".

```bash
# List current and available addons
curl -s http://127.0.0.1:3800/api/plugins/supabase/mgmt/addons

# Apply or resize (gated, changes monthly cost)
curl -s -X PATCH http://127.0.0.1:3800/api/plugins/supabase/mgmt/addons \
  -H "Content-Type: application/json" \
  -d '{"addon_type":"compute_instance","addon_variant":"ci_medium"}'

# Remove an addon
curl -s -X DELETE http://127.0.0.1:3800/api/plugins/supabase/mgmt/addons/<addon_variant>
```

---

### Disk config

```bash
curl -s http://127.0.0.1:3800/api/plugins/supabase/mgmt/disk
curl -s http://127.0.0.1:3800/api/plugins/supabase/mgmt/disk/util      # current usage %
curl -s http://127.0.0.1:3800/api/plugins/supabase/mgmt/disk/autoscale
# Modify (gated)
curl -s -X POST http://127.0.0.1:3800/api/plugins/supabase/mgmt/disk \
  -H "Content-Type: application/json" -d '{"provisioned_iops":3000,"size_gb":16}'
```

---

### Postgres runtime settings

```bash
curl -s http://127.0.0.1:3800/api/plugins/supabase/mgmt/postgres-config
# Update (gated, may restart the database)
curl -s -X PUT http://127.0.0.1:3800/api/plugins/supabase/mgmt/postgres-config \
  -H "Content-Type: application/json" \
  -d '{"max_connections":100,"shared_buffers":"256MB"}'
```

Safe to tune with a small compute instance: `work_mem`, `maintenance_work_mem`, `effective_cache_size`, `statement_timeout`. NEVER touch `wal_level` or `archive_*` without talking to the user.

---

### DEEP STATS (what the dashboard "Database Reports" page runs)

These routes run read-only SQL against `pg_catalog`, `pg_stat_*`, `auth.*`, and `storage.*`. They don't consume Management-API rate limit.

```bash
# DB: size, connections, version, start time
curl -s http://127.0.0.1:3800/api/plugins/supabase/stats/db

# Per-table stats: live/dead rows, table+index size, vacuum state, seq/idx scans
curl -s "http://127.0.0.1:3800/api/plugins/supabase/stats/tables?schema=public"

# Indexes: usage counters + size
curl -s http://127.0.0.1:3800/api/plugins/supabase/stats/indexes

# Unused indexes (safe to drop candidates)
curl -s http://127.0.0.1:3800/api/plugins/supabase/stats/unused-indexes

# Slow queries (needs pg_stat_statements extension; create with POST /extensions if missing)
curl -s "http://127.0.0.1:3800/api/plugins/supabase/stats/slow-queries?limit=50"

# Long-running queries (>= 5 min by default)
curl -s "http://127.0.0.1:3800/api/plugins/supabase/stats/long-running?minMinutes=5"

# Blocking / blocked PIDs
curl -s http://127.0.0.1:3800/api/plugins/supabase/stats/blocking

# Current locks
curl -s http://127.0.0.1:3800/api/plugins/supabase/stats/locks

# Cache hit ratio (aim > 0.99)
curl -s http://127.0.0.1:3800/api/plugins/supabase/stats/cache-hit

# Vacuum / autovacuum status + dead-tuple % per table
curl -s http://127.0.0.1:3800/api/plugins/supabase/stats/vacuum

# Logical replication slots + WAL lag in bytes
curl -s http://127.0.0.1:3800/api/plugins/supabase/stats/replication-slots

# Active connections per role
curl -s http://127.0.0.1:3800/api/plugins/supabase/stats/roles

# Storage buckets: object count + total bytes per bucket
curl -s http://127.0.0.1:3800/api/plugins/supabase/stats/bucket-sizes
```

**Overview (one shot):**
```bash
curl -s http://127.0.0.1:3800/api/plugins/supabase/stats/overview
# -> { overview: { database, auth, storage, schema_counts } }
```

---

### DEEP AUTH STATS

```bash
# Summary: total/confirmed/banned/anon users, signups 24h/7d/30d, active 24h/7d/30d
curl -s http://127.0.0.1:3800/api/plugins/supabase/stats/auth/summary

# Daily growth (signups + sign-ins per day for last N days)
curl -s "http://127.0.0.1:3800/api/plugins/supabase/stats/auth/growth?days=30"

# Which auth providers are in use (Google, GitHub, email, etc.)
curl -s http://127.0.0.1:3800/api/plugins/supabase/stats/auth/providers

# MFA factor counts by type + status
curl -s http://127.0.0.1:3800/api/plugins/supabase/stats/auth/mfa

# Session counts
curl -s http://127.0.0.1:3800/api/plugins/supabase/stats/auth/sessions

# Per-user deep detail: user row + identities + sessions + mfa factors + audit count
curl -s http://127.0.0.1:3800/api/plugins/supabase/auth/users/<user-id>/detail

# Daily usage summary
curl -s "http://127.0.0.1:3800/api/plugins/supabase/usage/daily?days=7"
```

Use these BEFORE recommending changes. Example: if the user says "I think my users aren't signing in", pull `stats/auth/summary` + `stats/auth/growth` and show them the actual numbers.

---

### Database context / backups / restore points

```bash
# Dashboard "database context" (size, version, connection counts)
curl -s http://127.0.0.1:3800/api/plugins/supabase/database/context

# Backups (PITR window)
curl -s http://127.0.0.1:3800/api/plugins/supabase/backups

# Named restore points (pre-migration snapshots)
curl -s http://127.0.0.1:3800/api/plugins/supabase/backups/restore-points
curl -s -X POST http://127.0.0.1:3800/api/plugins/supabase/backups/restore-points \
  -H "Content-Type: application/json" -d '{"name":"before_refactor"}'

# PITR restore (gated)
curl -s -X POST http://127.0.0.1:3800/api/plugins/supabase/backups/restore \
  -H "Content-Type: application/json" -d '{"recovery_time_target_unix":1700000000}'

# Roll back to a named restore point (gated)
curl -s -X POST http://127.0.0.1:3800/api/plugins/supabase/backups/undo \
  -H "Content-Type: application/json" -d '{"restore_point":"before_refactor"}'
```

**Always create a restore point before big destructive migrations.**

---

### Migrations (full CRUD)

```bash
# List
curl -s http://127.0.0.1:3800/api/plugins/supabase/migrations

# Get one
curl -s http://127.0.0.1:3800/api/plugins/supabase/migrations/<version>

# Apply
curl -s -X POST http://127.0.0.1:3800/api/plugins/supabase/migrations \
  -H "Content-Type: application/json" \
  -d '{"name":"add_profiles","query":"create table public.profiles (...);"}'

# Upsert without applying (repair history)
curl -s -X PUT http://127.0.0.1:3800/api/plugins/supabase/migrations \
  -H "Content-Type: application/json" -d '{"name":"add_profiles","query":"..."}'

# Edit one history entry (repair)
curl -s -X PATCH http://127.0.0.1:3800/api/plugins/supabase/migrations/<version> \
  -H "Content-Type: application/json" -d '{"status":"applied"}'

# Rollback (gated)
curl -s -X DELETE http://127.0.0.1:3800/api/plugins/supabase/migrations \
  -H "Content-Type: application/json" -d '{"to":"0"}'
```

---

### Edge functions -- create, deploy, download, invoke

```bash
# Create (metadata only, no body)
curl -s -X POST http://127.0.0.1:3800/api/plugins/supabase/edge/functions \
  -H "Content-Type: application/json" -d '{"slug":"hello","name":"Hello","verify_jwt":true}'

# Deploy (with source body)
curl -s -X POST http://127.0.0.1:3800/api/plugins/supabase/edge/deploy \
  -H "Content-Type: application/json" \
  -d '{"slug":"hello","body":"Deno.serve(()=>new Response(\"hi\"))","verify_jwt":true}'

# Bulk update / replace
curl -s -X PUT http://127.0.0.1:3800/api/plugins/supabase/edge/functions \
  -H "Content-Type: application/json" -d '[{"slug":"hello","verify_jwt":false}]'

# Download source
curl -s http://127.0.0.1:3800/api/plugins/supabase/edge/functions/hello/body

# Invoke
curl -s -X POST http://127.0.0.1:3800/api/plugins/supabase/edge/invoke/hello \
  -H "Content-Type: application/json" -d '{"name":"world"}'

# Update single
curl -s -X PATCH http://127.0.0.1:3800/api/plugins/supabase/edge/functions/hello \
  -H "Content-Type: application/json" -d '{"verify_jwt":false}'

# Delete
curl -s -X DELETE http://127.0.0.1:3800/api/plugins/supabase/edge/functions/hello
```

Multi-file bundles still need the Supabase CLI (`supabase functions deploy` with an Import Map). A single inline body is fine for most cases.

---

### Third-party auth (Firebase / Auth0 / Cognito import)

```bash
curl -s http://127.0.0.1:3800/api/plugins/supabase/auth/third-party
curl -s -X POST http://127.0.0.1:3800/api/plugins/supabase/auth/third-party \
  -H "Content-Type: application/json" \
  -d '{"type":"firebase","project_id":"my-fb-project"}'
curl -s -X DELETE http://127.0.0.1:3800/api/plugins/supabase/auth/third-party/<id>
```

---

### Actions (dashboard Activity tab -- CI-style runs)

```bash
curl -s "http://127.0.0.1:3800/api/plugins/supabase/mgmt/actions?status=running"
curl -s http://127.0.0.1:3800/api/plugins/supabase/mgmt/actions/<run_id>
curl -s http://127.0.0.1:3800/api/plugins/supabase/mgmt/actions/<run_id>/logs
curl -s -X PATCH http://127.0.0.1:3800/api/plugins/supabase/mgmt/actions/<run_id>/status \
  -H "Content-Type: application/json" -d '{"status":"cancelled"}'
```

Use this to watch branch merges, deploys, or restores.

---

### Realtime channels (live)

```bash
# Active channels on the project (names + connected count)
curl -s http://127.0.0.1:3800/api/plugins/supabase/realtime/channels

# Tenant health
curl -s http://127.0.0.1:3800/api/plugins/supabase/realtime/tenants/health

# Broadcast a message (REST, no websocket needed)
curl -s -X POST http://127.0.0.1:3800/api/plugins/supabase/realtime/broadcast \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"topic":"room-1","event":"msg","payload":{"text":"hello"}}]}'
```

---

### Row CRUD (PostgREST)

```bash
curl -s "http://127.0.0.1:3800/api/plugins/supabase/rows/profiles?id=eq.1&select=*"
curl -s -X POST http://127.0.0.1:3800/api/plugins/supabase/rows/profiles \
  -H "Content-Type: application/json" -d '{"email":"x@y.com"}'
curl -s -X PATCH "http://127.0.0.1:3800/api/plugins/supabase/rows/profiles?id=eq.1" \
  -H "Content-Type: application/json" -d '{"name":"New"}'
curl -s -X DELETE "http://127.0.0.1:3800/api/plugins/supabase/rows/profiles?id=eq.1"
curl -s -X POST http://127.0.0.1:3800/api/plugins/supabase/rpc/match_documents \
  -H "Content-Type: application/json" -d '{"embedding":[0.1,...],"match_count":5}'
```

Schema switch: add `?_schema=<name>` to the URL. Empty-filter DELETE is gated.

---

### RLS policies + Auth admin + Storage + Secrets + Webhooks + Backups + Branches + API keys + Signing keys + SSO + Custom hostname + Network + Read replicas + Upgrade

All covered (same as before). Full list at `/api/plugins/supabase/` route table; see the "Pre-made scripts" table above for the script forms.

---

### Common workflows

**1. Create a brand-new project from scratch.**
- `GET /mgmt/organizations` to find the org id (or create one with `POST /mgmt/organizations`).
- `GET /mgmt/regions` to pick a region.
- `POST /mgmt/projects` with `{ name, organization_id, db_pass, region, plan }`.
- Wait (Supabase provisions async); poll `GET /mgmt/project/health`.
- `GET /mgmt/api-keys` to fetch the service-role + anon keys.
- `POST /projects` to register the new project with Symphonee.

**2. Audit a project for the user.**
- `GET /advisors/security` -> flag RLS-disabled public tables, permissive policies, exposed secrets.
- `GET /advisors/performance` -> surface missing-index suggestions.
- `GET /stats/unused-indexes` -> extra bloat candidates.
- `GET /stats/cache-hit` -> warn if hit ratio < 0.99.
- `GET /stats/vacuum` -> warn if dead_pct > 20 on big tables.
- Show the user findings in priority order; offer to fix each one.

**3. "My users aren't logging in" investigation.**
- `GET /stats/auth/summary` -> total, confirmed, banned, signups 24h, active 24h.
- `GET /stats/auth/growth?days=30` -> daily signups vs sign-ins trend.
- `GET /stats/auth/providers` -> which providers actually see traffic.
- If a specific user: `GET /auth/users/<id>/detail` -> identities, sessions, MFA, audit count.

**4. Slow query triage.**
- First enable pg_stat_statements if missing: `POST /extensions {"name":"pg_stat_statements"}`.
- `GET /stats/slow-queries?limit=50` -> slowest by total_exec_time.
- `GET /stats/blocking` -> see if anything is stuck behind a lock.
- `GET /stats/long-running` -> kill candidates with `select pg_terminate_backend(<pid>)`.
- Check missing indexes via `GET /advisors/performance`.

**5. Clone data into a branch DB.**
- `POST /branches` with a branch name.
- Switch active project to the branch (via dashboard, or add it to Symphonee).
- Use `pg_dump | psql` externally OR `COPY` statements via `/sql`.

**6. Ship a new edge function.**
- `POST /edge/deploy` with `{ slug, body, verify_jwt }`.
- `POST /secrets` for any env vars (no `SUPABASE_` prefix allowed).
- `POST /edge/invoke/<slug>` to smoke-test.

**7. Create / grow / shrink compute size.**
- `GET /mgmt/addons` -> see current compute + options.
- `PATCH /mgmt/addons` with `{ addon_type:"compute_instance", addon_variant:"ci_medium" }`.
- Or remove: `DELETE /mgmt/addons/<variant>` to return to the default.

**8. Generate TS types after schema changes.**
- `GET /types/typescript?schemas=public` -> write to `src/types/supabase.ts`.

---

### Gotchas the AI should internalize

- **Management API rate limit: 120 req/min** per project per user per scope. Prefer `/stats/*` (SQL-backed) when you can; they don't count against it.
- `/sql` returns an array of rows. Non-SELECT DDL/DML returns `[]`.
- `auth.users.email` changes require `email_confirm:true` or the user can't log in until they re-confirm.
- `DELETE FROM <table>` without a `WHERE` clause is gated. Pass `body.force:true` only when the user has explicitly asked.
- Secrets whose name starts with `SUPABASE_` are rejected.
- Rotating a signing key, DB password, or pgsodium root key breaks live sessions/connections. Tell the user BEFORE rotating.
- Edge functions default to `verify_jwt:true`. Set `verify_jwt:false` for webhook-style functions.
- `auth.users` is a special system table. Don't `INSERT` directly via PostgREST -- use the Auth admin API.
- `storage.objects` RLS is what gates per-user file access. Edit those policies via `/policies?schema=storage&table=objects`.
- `pg_stat_statements` must be enabled for `/stats/slow-queries` to return anything: `CREATE EXTENSION IF NOT EXISTS pg_stat_statements`.
- Billing/invoice endpoints are NOT on the public Management API. `/mgmt/organizations/<slug>/entitlements` is the closest public substitute (plan limits and quotas).
- Member invite/remove endpoints are NOT on the public Management API. Tell the user to use the Supabase dashboard for those.

---

### Secrets to NEVER log

Service-role keys, Management PATs, user JWTs, refresh tokens, `action_link` / `hashed_token` from generate-link responses, `/api-keys` response bodies, `db_pass` from project responses, raw bodies of `POST /secrets`, and any SQL containing `alter role ... with password '...'`.

---

### Opening in the dashboard tab

```bash
curl -s -X POST http://127.0.0.1:3800/api/ui/view-plugin \
  -H "Content-Type: application/json" -d '{"plugin":"supabase"}'
```

---

### Reference docs

- Management API: https://supabase.com/docs/reference/api/introduction
- OpenAPI spec (live): https://api.supabase.com/api/v1
- Run SQL query: https://supabase.com/docs/reference/api/v1-run-a-query
- API keys (new format): https://supabase.com/docs/guides/api/api-keys
- JWT signing keys: https://supabase.com/docs/guides/auth/signing-keys
- PostgREST Data API: https://supabase.com/docs/guides/api
- Auth admin: https://supabase.com/docs/reference/self-hosting-auth/introduction
- Storage REST: https://supabase.com/docs/reference/self-hosting-storage/introduction
- Edge Functions: https://supabase.com/docs/guides/functions
- RLS: https://supabase.com/docs/guides/database/postgres/row-level-security
- Database webhooks: https://supabase.com/docs/guides/database/webhooks
- Realtime broadcast REST: https://supabase.com/docs/guides/realtime/broadcast
- CLI: https://supabase.com/docs/reference/cli

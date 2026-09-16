# Supabase plugin (Cadence 3.0)

Supabase as a screen inside Cadence: the project at a glance, every table with its rows, columns,
policies, indexes and triggers, SQL with a guard on destructive statements, users, storage, edge
functions and secrets, the advisors as insights, the project itself (services, disk, backups,
migrations, extensions, settings, logs, types), an Ask page, and one script per action for every CLI.

Everything goes through the Cadence server that opened your shell: `$CADENCE_API`
(`$env:CADENCE_API` in PowerShell; fall back to `http://127.0.0.1:3800` when unset). Mutating
calls (POST, PUT, PATCH, DELETE) need the header `x-cadence-token: $CADENCE_TOKEN`. The scripts
attach both for you; prefer them.

## Which project

The plugin knows several Supabase projects, each with a `projectRef`, an API URL, a service role
key and an anon key typed once and never shown again, and optionally the repository of the app that
uses it. Every request picks its project in this order:

1. `?project=<name>` on the request (scripts: `-Project '<name>'`).
2. `?repo=<path>`: the project whose `repoPath` is that path or contains it (scripts send
   `CADENCE_ACTIVE_REPO_PATH` automatically, so a shell opened for a repository talks to its
   project without saying so).
3. The active project (`POST /projects/active {name}` or `Switch-SBProject`).

Never ask the user "which project?" when a shell carries a repository: it is already chosen.

## Keys and what they unlock

- Management token (`sbp_...`, one per account): SQL, schema, policies, functions, secrets, advisors,
  settings, logs, backups, migrations, types, organizations. `Set-SBManagementToken`.
- Service role key (per project): rows through PostgREST, auth users, storage, invoking functions.
  It bypasses row level security; it never leaves the machine, and the API only ever reports
  `serviceRoleKeySet: true`.
- Anon key (per project, optional): recorded for the app, not used by the plugin.

`GET /test` (or `Test-SBConnection`) checks both against Supabase.

## Confirmations and permissions

Two layers protect the project:

- Cadence's permission gate. In `review` and `edit` modes a write shows the user an approval modal.
  A `403 deny` or `403 rejected by user` means stop: do not retry, do not route around.
- The plugin's own confirmation token for what cannot be undone: destructive SQL (DROP, TRUNCATE,
  DELETE or UPDATE without WHERE, ALTER ... DROP), deleting a user, emptying a bucket, restarting
  services, changing add-ons (the bill), creating or deleting cloud projects, restoring backups,
  disabling RLS. The first call answers `{confirmRequired: true, token, retryWith}`; repeat within
  10 minutes with `?confirm=<token>`. Without `?soft=1` that first answer is a `409`; with
  `?soft=1` it is a `200` so clients that throw on non-2xx still see the token. The scripts do this
  for you: run once, read the token, run again with `-ConfirmToken <token>`. Tell the user what is
  about to happen before the second call.

Nothing in this plugin runs a hidden write: an AI answering a question (the Ask page, or you)
uses GET routes and `POST /sql/select`, which is read-only.

## Scripts (PowerShell, run from the Cadence directory)

All take `-Project '<name>'` (optional). Output is JSON unless noted. `Get-*` scripts read only.

Project at a glance
- `Get-SBOverview [-Refresh]`: services, database, users, storage, tables with RLS, buckets, functions, advisors, disk, backups, migrations, issues (cached 60 s).
- `Get-SBSummary` (plain text), `Get-SBHealth`, `Get-SBInsights`, `Get-SBAdvisors [-Kind security|performance|both]`, `Get-SBUsage [-Days 30]`.

Schema
- `Get-SBSchemas`, `Get-SBTables [-Schema public]`, `Get-SBTable -Table <t>`, `Get-SBColumns -Table <t>`, `Get-SBPolicies [-Table <t>]`, `Get-SBIndexes [-Unused]`, `Get-SBFunctions`, `Get-SBExtensions [-Installed]`, `Get-SBTypes [-OutFile path]`.
- `Set-SBExtension -Name <ext> [-Remove]`.
- `Enable-SBRls -Table <t> [-Disable]`, `New-SBPolicy -Table <t> -Name <n> [-Command SELECT] [-Roles authenticated] [-Using '<expr>'] [-Check '<expr>']`, `Remove-SBPolicy -Table <t> -Name <n>`.

SQL and rows
- `Invoke-SBSql -Query '<sql>' | -File x.sql [-ReadOnly] [-ConfirmToken t]`: reads through the read-only route with `-ReadOnly`; otherwise through the gated route, with the confirmation flow on destructive statements.
- `Get-SBRows -Table <t> [-Select 'a,b'] [-Filter 'col=eq.v' ...] [-Order 'col.desc'] [-Limit 50] [-Offset 0]`: PostgREST filters, returns `{rows, total}`.
- `New-SBRow -Table <t> -JsonFile row.json` (object or array), `Update-SBRows -Table <t> -Filter ... -JsonFile patch.json`, `Remove-SBRows -Table <t> -Filter ...`. A filter is mandatory on update and delete.
- `Get-SBDbStats -Kind overview|db|tables|cache-hit|locks|blocking|vacuum|long-running|slow-queries|unused-indexes|roles|replication-slots`.

Auth
- `Get-SBAuthUsers [-Query text] [-Page 1] [-PerPage 50]`, `Get-SBUserDetail -Id <uuid>`, `Get-SBUserStats [-Days 30]`.
- `New-SBAuthUser -Email e -Password p [-Unconfirmed] [-MetadataJsonFile f]`, `Send-SBInvite -Email e`, `New-SBAuthLink -Email e [-Type magiclink|recovery|invite|signup]` (prints the link, sends no mail).
- `Set-SBAuthUser -Id <uuid> [-Ban 24h|none] [-ConfirmEmail] [-Password p] [-SignOut] [-JsonFile f]`, `Remove-SBAuthUser -Id <uuid> [-ConfirmToken t]`.

Storage
- `Get-SBBuckets`, `Get-SBObjects -Bucket b [-Prefix 'folder/'] [-Limit 100]`, `New-SBSignedUrl -Bucket b -Path 'a/b.png' [-ExpiresIn 3600]`.
- `New-SBBucket -Name b [-Public] [-FileSizeLimit bytes] [-AllowedTypes image/png,...]`, `Remove-SBBucket -Name b [-Empty] [-ConfirmToken t]`, `Remove-SBObjects -Bucket b -Path 'a','b'`.

Edge functions and secrets
- `Get-SBEdgeFunctions`, `Get-SBEdgeFunctionBody -Slug s [-OutFile f]` (the source as the management API returns it), `Deploy-SBEdgeFunction -Slug s -File index.ts [-Name n] [-NoJwt]` (creates or publishes a new version), `Invoke-SBEdgeFunction -Slug s [-Body '{}' | -JsonFile f]`, `Remove-SBEdgeFunction -Slug s`.
- `Get-SBSecrets` (names only), `Set-SBSecret -Name N -Value v` / `-Remove`.

Project operations
- `Get-SBLogs [-Source postgres_logs|edge_logs|auth_logs|function_logs|storage_logs] [-Limit 50] [-Sql '<sql>']`.
- `Get-SBBackups`, `Get-SBMigrations`, `New-SBMigration -Name n -File m.sql`, `Get-SBAddons`, `Set-SBAddon -Type t -Variant v [-ConfirmToken t]`, `Get-SBDisk`, `Restart-SBServices [-ConfirmToken t]`.
- `Get-SBOrganizations`, `Get-SBRegions [-Org slug]`, `New-SBCloudProject -OrganizationId o -Name n -Region r -DbPassword p [-ConfirmToken t]`.

Projects known here
- `Get-SBProjects`, `Add-SBProject -Name n -ProjectRef ref [-ServiceRoleKey k] [-AnonKey k] [-Url u] [-RepoPath p] [-Activate]`, `Set-SBManagementToken -Token sbp_...`, `Switch-SBProject -Name n`, `Remove-SBProject -Name n` (forgets it here only), `Test-SBConnection`.

From bash: `powershell.exe -ExecutionPolicy Bypass -NoProfile -File "./dashboard/plugins/supabase/scripts/Get-SBTables.ps1" -Schema public`. Windows paths for `-File`/`-JsonFile`; Git Bash `/c/...` paths are not understood by PowerShell.

## Routes (under `/api/plugins/supabase`)

Read (GET, no token needed):
- `/config` (public shape: `*Set` booleans, active project), `/projects`, `/test`, `/health`, `/summary`
- `/overview[?refresh=1]`, `/insights`, `/advisors/security`, `/advisors/performance`, `/usage/daily?days=`
- `/schemas`, `/tables?schema=`, `/table?schema=&name=`, `/policies?schema=[&table=]`, `/indexes?schema=`, `/functions?schema=`, `/triggers?schema=`, `/views`, `/materialized-views`, `/enums`, `/sequences`, `/constraints`, `/roles`, `/publications`, `/extensions`, `/types/typescript?schemas=`
- `/rows/<table>?<postgrest filters>&_schema=&_meta=1` (`_meta=1` returns `{rows,total}`; `_`-prefixed, `project` and `repo` never reach PostgREST)
- `/stats/*` (overview, db, tables, cache-hit, locks, blocking, vacuum, long-running, slow-queries, unused-indexes, indexes, roles, replication-slots, bucket-sizes, auth/summary, auth/growth?days=, auth/providers, auth/mfa, auth/sessions)
- `/auth/users?page=&per_page=`, `/auth/users/<id>/detail`, `/auth/config`, `/auth/audit`
- `/storage/buckets`, `/storage-config`, `/edge/functions`, `/edge/functions/<slug>/body`, `/secrets`
- `/backups`, `/migrations`, `/mgmt/addons`, `/mgmt/disk`, `/mgmt/disk/util`, `/mgmt/project/health`, `/mgmt/postgres-config`, `/pooler-config`, `/postgrest-config`, `/mgmt/organizations`, `/mgmt/projects`, `/mgmt/regions[?org=]`, `/realtime/config`, `/webhooks`

Write (token header; permission gate; confirmation tokens where noted):
- `POST /config {managementToken}` (blank keeps the stored one), `POST /projects`, `PUT|PATCH /projects/<name>` (blank keys keep the stored ones), `DELETE /projects/<name>`, `POST /projects/active {name}`
- `POST /sql {query, readOnly?, force?}` (destructive: confirmation), `POST /sql/select {query}` (read-only, safe)
- `POST /rows/<table>`, `PATCH /rows/<table>?<filter>`, `DELETE /rows/<table>?<filter>`, `POST /rpc/<fn>`
- `POST /policies {schema, table, name, command, roles, using, check}`, `DELETE /policies/<schema>/<table>/<name>`, `POST /rls/enable/<schema>/<table>`, `POST /rls/disable/<schema>/<table>` (confirmation)
- `POST /extensions {name}`, `DELETE /extensions/<name>`, `POST /migrations {name, query}`
- `POST /auth/users`, `PUT /auth/users/<id>`, `DELETE /auth/users/<id>` (confirmation), `POST /auth/users/<id>/sign-out`, `POST /auth/invite {email}`, `POST /auth/generate-link {type, email}`, `PATCH /auth/config`
- `POST /storage/buckets`, `PATCH|DELETE /storage/buckets/<id>`, `POST /storage/buckets/<id>/empty` (confirmation), `POST /storage/list/<bucket> {prefix, limit, offset}`, `POST /storage/sign/<bucket>/<path> {expiresIn}`, `POST /storage/move`, `POST /storage/copy`, `DELETE /storage/objects/<bucket> {prefixes}`
- `POST /edge/deploy {slug, name?, body, verify_jwt?}`, `PATCH|DELETE /edge/functions/<slug>`, `POST /edge/invoke/<slug>`, `POST /secrets [{name,value}]`, `DELETE /secrets [names]`
- `POST /logs {sql}`, `POST /mgmt/project/restart-services` (confirmation), `POST /mgmt/project/pause` (confirmation), `PATCH /mgmt/addons` (confirmation), `POST /mgmt/projects` (confirmation), `POST /backups/restore` (confirmation)

The screen (`ui/sb.js`) uses exactly these routes; nothing is hardcoded to one project. Labels come from
the project's own data.

## How to work

1. Bootstrap Cadence first, as always. If the user's task mentions Supabase, Postgres, RLS, a table,
   users, a bucket or an edge function and this plugin is installed, ask once whether to use it.
2. Start with `Get-SBOverview` (or `/overview`): it tells you the tables, the RLS gaps, the users,
   the storage and the issues in one call.
3. Read before writing: `Get-SBTable` before touching a table, `Get-SBPolicies` before writing a
   policy, `Get-SBRows -Limit 5` before an update or delete, with the same filter you will use.
4. Prefer PostgREST rows routes for data and `/sql/select` for questions; keep `/sql` writes to schema
   work, and let the confirmation flow run for destructive statements (never pass `force` unprompted).
5. Take a Cadence checkpoint before a migration or bulk change.
6. Clean up anything you created to test.

## Do not

- Do not print or log keys or tokens. `config.json` holds them and is gitignored; never commit it.
- Do not pass `force: true` to `/sql`, disable RLS, delete users, empty buckets, restart services or
  change add-ons without telling the user what is about to happen.
- Do not shell out to the Supabase CLI for anything these routes cover.
- Do not assume `pg_stat_statements` is on: `/stats/slow-queries` and `/insights.slowQueries` say
  `unavailable: true` when it is not.

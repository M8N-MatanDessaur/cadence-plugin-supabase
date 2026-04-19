# Symphonee Supabase Plugin

Full Supabase control plane for Symphonee. Manage every corner of a Supabase project without opening supabase.com: database and SQL, row-level security, auth users, storage buckets, edge functions, realtime, webhooks, and more. Multi-project with fast project switching.

## Install

Install via the Symphonee plugin store, or drop this folder into `dashboard/plugins/`.

## Configure

Open the plugin's **Settings** tab.

1. Paste your Supabase **Management Personal Access Token** once, at the plugin level. You can create one at `https://supabase.com/dashboard/account/tokens`. This token is used for SQL execution, project-level operations, and anything the REST project keys can't do.
2. Add each Supabase project you want to manage:
   - **Name** -- any label you want (shown in the switcher)
   - **Project Ref** -- the `<ref>` in `https://<ref>.supabase.co` (e.g. `abcdefghijklmnop`)
   - **Service Role Key** -- `sbp_...` / `eyJ...` from Project Settings -> API
   - **Anon Key** -- the public anon key
   - **URL** -- the project's full REST base (e.g. `https://<ref>.supabase.co`)
   - **Repo Path** (optional) -- local path of the repo that uses this Supabase project, so the plugin can read your migrations/types
3. Pick an active project with the switcher at the top of the tab.

## What the AI can do

Everything you'd normally open the Supabase dashboard for:

- Run arbitrary SQL (SELECT/INSERT/UPDATE/DDL) with a destructive-op safety gate
- Browse schemas, tables, columns, indexes, constraints, triggers, functions, extensions, enums, sequences
- Row CRUD through PostgREST
- RLS policies: list, create, edit, drop
- Auth: list/create/update/delete users, invites, magic links, MFA factors, sessions
- Storage: buckets and files, signed URLs
- Edge functions: list, deploy, invoke, logs, secrets
- Database webhooks: list/create/update/delete
- Realtime publications inspect
- Logs (API, Postgres, auth, functions)
- pgvector: list indexes, similarity search
- Generate TypeScript types from schema

See `instructions.md` for the full API reference.

## Safety gates

The following operations require an explicit confirmation token (returned as a 409 on the first attempt):

- Destructive SQL: `DROP`, `TRUNCATE`, `DELETE` without `WHERE`
- Project-level ops: pause, restore, delete project
- `bucket.empty`, bulk file delete
- User delete, password reset

Pass `?confirm=<token>` on the retry to proceed.

## License

MIT.

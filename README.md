# Supabase for Cadence

Supabase as a screen inside Cadence 3.0, and as scripts for every CLI.

## The screen

Open it from Plugins. The left column is the project: Overview, Database, SQL, Users, Storage,
Functions, Insights, Project, Ask, Projects. The middle is the work. The right pane is the detail of
what is selected.

- **Overview**: services, users, storage, the tables with rows, size and RLS, the buckets, the
  functions, the advisor counts, disk, backups, and the issues to fix first.
- **Database**: the tables of a schema; one table with its rows (filter, sort, page, edit a cell,
  add a row, delete a row), columns, policies (turn RLS on or off, new policy from a template, drop),
  indexes, triggers, constraints, the tables that reference it, and Query it.
- **SQL**: the editor, the read-only chip, results as a table or JSON, copy as CSV or JSON, a
  history, and a confirmation for destructive statements.
- **Users**: totals and growth, invite or create, one user with identities, sessions, MFA, links
  (magic, recovery), confirm, ban, sign out, delete.
- **Storage**: buckets, folders, files with public or signed links, move, delete, new bucket.
- **Functions**: edge functions with source and an invoke form, secrets, database functions and
  triggers.
- **Insights**: the security and performance advisors plus tables without RLS or a primary key,
  unused indexes, cache hit, bloat, long-running statements and slow queries, each with the SQL
  that fixes it or the table it is about.
- **Project**: services (restart), compute and disk, backups, migrations, extensions, Postgres and
  pooler settings, logs by SQL, TypeScript types.
- **Ask**: a question about the project answered by the AI from read-only routes.
- **Projects**: the management token and the projects with their keys and repositories.

## Set up

1. Management token: supabase.com/dashboard/account/tokens. Paste it under Projects (or
   `Set-SBManagementToken`).
2. A project: pick it from the account, paste its service role key (Settings > API keys), and choose
   the repository of the app so the screen follows the shell that is on it.
3. Test the keys.

Keys live in `config.json` on this machine only. The file is gitignored; the API never returns them.

## Scripts

Sixty-three PowerShell scripts under `scripts/`, one per action, all through the Cadence API of the
server that opened the shell. `instructions.md` lists them with their parameters; every CLI gets that
file at bootstrap.

## Files

- `plugin.json`: manifest (sdkVersion 3, one rail surface, the scripts block).
- `routes.js`: the server routes under `/api/plugins/supabase`.
- `ui/`: the surface (`sb.js` shell; `overview`, `database`, `rows`, `sql`, `auth`, `storage`,
  `functions`, `insights`, `project`, `ask`, `projects`; `kit` and `helpers`).
- `scripts/`: the PowerShell scripts.
- `config.template.json`: the shape of `config.json`.

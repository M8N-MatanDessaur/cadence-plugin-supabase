/**
 * Small shared pieces: time, text, the orchestrator wait, the local model, sizes, and the
 * confirm-token dance the Supabase routes use for destructive calls.
 */

export function stripHtml(text) {
  return String(text || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function ago(iso) {
  if (!iso) return 'at some point';
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 90) return 'just now';
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.round(minutes)}m ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)}h ago`;
  const days = hours / 24;
  if (days < 30) return `${Math.round(days)}d ago`;
  return new Date(iso).toISOString().slice(0, 10);
}

export async function waitForTask(api, id, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const t = await api(`/api/orchestrator/task?id=${id}`).catch(() => null);
    if (!t) continue;
    if (t.state === 'completed') return t.result || '(finished with nothing to say)';
    if (['failed', 'cancelled', 'timeout'].includes(t.state)) return t.error || `The worker ${t.state}.`;
  }
  return 'It is taking too long; the answer will land in the orchestrator.';
}

/** The local model first, then a spawned CLI. Returns the text, stripped of the bootstrap tag. */
export async function askModel(api, { prompt, system, maxTokens = 900, from = 'supabase', timeout = 180000 }) {
  let text = '';
  try { text = String((await api('/api/notes/ai', { method: 'POST', body: JSON.stringify({ prompt, system, maxTokens }) })).text || '').trim(); } catch (_) {}
  if (!text) {
    const cfg = await api('/api/config').catch(() => ({}));
    const result = await api('/api/orchestrator/spawn', { method: 'POST', body: JSON.stringify({ cli: cfg.DefaultCli || 'claude', from, timeout, prompt: `${system}\n\n${prompt}\n\nThis is a one-off answer: do not run any bootstrap, do not save anything to Mind or any memory, do not mention either. Reply with the answer only.` }) });
    text = String(result.handledLocally ? result.answer : result.id ? await waitForTask(api, result.id, timeout) : (result.error || '')).replace(/^\s*\[bootstrap:[^\]]*\]\s*/, '').trim();
  }
  return text;
}

export const bytes = (n) => (n === null || n === undefined || n === '' ? '-' : Number(n) > 1073741824 ? `${(Number(n) / 1073741824).toFixed(2)} GB` : Number(n) > 1048576 ? `${(Number(n) / 1048576).toFixed(1)} MB` : Number(n) > 1024 ? `${Math.round(Number(n) / 1024)} KB` : `${Number(n)} B`);
export const num = (n) => (n === null || n === undefined ? '-' : Number(n).toLocaleString());
export const pct = (a, b) => (!b ? '-' : `${Math.round((Number(a) / Number(b)) * 100)}%`);
export const levelColour = (l) => (l === 'ERROR' || l === 'error' ? 'var(--sy-rosin)' : l === 'WARN' || l === 'warn' ? 'var(--sy-brass)' : 'var(--sy-text-3)');
/** A value as a short cell: objects and arrays as compact JSON, long text clipped. */
export const cell = (v, n = 80) => { if (v === null) return 'null'; if (v === undefined) return ''; const s = typeof v === 'object' ? JSON.stringify(v) : String(v); return s.length > n ? `${s.slice(0, n - 1)}...` : s; };
/**
 * Calls a route that may answer 409 with a confirm token. `ask(detail)` decides whether to
 * retry; the retry carries ?confirm=<token>. Returns the final response or null when declined.
 */
export async function withConfirm(call, ask) {
  let first;
  try { first = await call(''); } catch (e) { const d = e && e.body; if (d && d.confirmRequired) first = d; else throw e; }
  if (!first || !first.confirmRequired) return first;
  const go = await ask(first);
  if (!go) return null;
  return call(`confirm=${encodeURIComponent(first.token)}`);
}

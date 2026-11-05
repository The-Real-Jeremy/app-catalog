/**
 * Minimal workspace REST client for the master itself (zero dependencies).
 *
 * Inside the Apps container it authenticates as the app's OWN service principal
 * from the injected DATABRICKS_CLIENT_ID / DATABRICKS_CLIENT_SECRET (OAuth M2M).
 * Locally it uses DATABRICKS_TOKEN if set. It is used for three things only:
 * reading the catalog app's own record (compute size, scopes, bound resources),
 * resolving a child's `valueFrom` against those resources, and nothing else.
 */

/** MEASURED: inside an Apps container DATABRICKS_HOST has NO scheme. */
export function normaliseHost(raw) {
  const t = String(raw ?? '').trim().replace(/\/+$/, '');
  if (!t) return '';
  return /^https?:\/\//i.test(t) ? t : `https://${t}`;
}

const HOST = normaliseHost(process.env.DATABRICKS_HOST);
let spToken = null; // { token, exp }

async function token() {
  if (process.env.DATABRICKS_CLIENT_ID && process.env.DATABRICKS_CLIENT_SECRET) {
    if (spToken && spToken.exp > Date.now() + 60000) return spToken.token;
    const basic = Buffer.from(`${process.env.DATABRICKS_CLIENT_ID}:${process.env.DATABRICKS_CLIENT_SECRET}`).toString('base64');
    const r = await fetch(`${HOST}/oidc/v1/token`, {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials&scope=all-apis',
      signal: AbortSignal.timeout(10000),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || !body.access_token) throw new Error(`service principal token: HTTP ${r.status}`);
    spToken = { token: body.access_token, exp: Date.now() + (Number(body.expires_in) || 3600) * 1000 };
    return spToken.token;
  }
  if (process.env.DATABRICKS_TOKEN) return process.env.DATABRICKS_TOKEN;
  return null;
}

/** GET a workspace API path. Returns { ok, status, body } and never throws. */
export async function wsGet(path) {
  if (!HOST) return { ok: false, status: null, body: null, error: 'DATABRICKS_HOST is not set' };
  try {
    const t = await token();
    if (!t) return { ok: false, status: null, body: null, error: 'no credentials' };
    const r = await fetch(`${HOST}${path}`, { headers: { authorization: `Bearer ${t}` }, signal: AbortSignal.timeout(15000) });
    const text = await r.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 300) }; }
    return { ok: r.ok, status: r.status, body };
  } catch (e) {
    return { ok: false, status: null, body: null, error: String(e?.message ?? e) };
  }
}

let ownCache = null; // { at, value }
/** The catalog app's own record (GET /api/2.0/apps/<own name>), cached 2 min. */
export async function ownApp({ fresh = false } = {}) {
  const name = process.env.DATABRICKS_APP_NAME;
  if (!name) return { ok: false, why: 'not running as a Databricks App (DATABRICKS_APP_NAME unset)' };
  if (!fresh && ownCache && Date.now() - ownCache.at < 120000) return ownCache.value;
  const r = await wsGet(`/api/2.0/apps/${encodeURIComponent(name)}`);
  const value = r.ok ? { ok: true, app: r.body } : { ok: false, why: `apps get ${name}: ${r.status ?? ''} ${r.error ?? r.body?.message ?? ''}`.trim() };
  ownCache = { at: Date.now(), value };
  return value;
}

/** The value Databricks Apps would inject for `valueFrom: <resource>`. */
export async function resourceValue(r) {
  if (r.sql_warehouse?.id) return { ok: true, value: String(r.sql_warehouse.id) };
  if (r.serving_endpoint?.name) return { ok: true, value: String(r.serving_endpoint.name) };
  if (r.job?.id) return { ok: true, value: String(r.job.id) };
  if (r.genie_space?.space_id) return { ok: true, value: String(r.genie_space.space_id) };
  if (r.uc_securable?.securable_full_name) return { ok: true, value: String(r.uc_securable.securable_full_name) };
  if (r.experiment?.experiment_id) return { ok: true, value: String(r.experiment.experiment_id) };
  if (r.app?.name) return { ok: true, value: String(r.app.name) };
  if (r.secret?.scope && r.secret?.key) {
    const s = await wsGet(`/api/2.0/secrets/get?scope=${encodeURIComponent(r.secret.scope)}&key=${encodeURIComponent(r.secret.key)}`);
    if (s.ok && s.body?.value != null) return { ok: true, value: Buffer.from(s.body.value, 'base64').toString('utf8') };
    return { ok: false, why: `secret ${r.secret.scope}/${r.secret.key} could not be read by the catalog's service principal (HTTP ${s.status ?? '?'})` };
  }
  if (r.database) return { ok: false, why: 'database (Lakebase) resources are not resolved by the catalog yet; set the value in catalog.overrides.yaml' };
  return { ok: false, why: `unsupported resource type (${Object.keys(r).filter((k) => !['name', 'description', '_from'].includes(k)).join(', ') || 'unknown'})` };
}

export function resourceKind(r) {
  for (const k of ['sql_warehouse', 'serving_endpoint', 'genie_space', 'job', 'secret', 'uc_securable', 'database', 'experiment', 'app']) if (r[k]) return k;
  return 'other';
}

/** The field that IDENTIFIES a resource, per kind. Not a `??` chain over every field: the
 *  API returns genie_space.name as "" and `??` keeps an empty string, which made a bound
 *  space look unbound and got it bound twice. */
const TARGET_FIELD = {
  sql_warehouse: (v) => v.id, serving_endpoint: (v) => v.name, genie_space: (v) => v.space_id, job: (v) => v.id,
  uc_securable: (v) => v.securable_full_name, experiment: (v) => v.experiment_id, app: (v) => v.name,
  database: (v) => (v.instance_name ? `${v.instance_name}/${v.database_name ?? ''}` : null),
  secret: (v) => (v.scope ? `${v.scope}/${v.key}` : null),
};
export function resourceTarget(r) {
  const k = resourceKind(r);
  const v = r[k] ?? {};
  const t = TARGET_FIELD[k]?.(v);
  return t === undefined || t === null || t === '' ? null : String(t);
}

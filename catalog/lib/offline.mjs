/**
 * Air-gapped installs (APPCEPTION_OFFLINE=1 in the catalog's app.yaml).
 *
 * In a workspace with no internet egress, every `pip install` / `npm install` a child
 * needs at deploy time must be satisfied from files that are already inside the
 * workspace. Three sources, all optional, searched in this order:
 *
 *   1. the platform's pre-installed libraries (streamlit, dash, gradio, flask, fastapi,
 *      uvicorn, databricks-sdk, pandas … in <src>/.venv). In offline mode a requirement
 *      line they already satisfy is NOT re-installed — under --no-index it could not be.
 *   2. the child's own vendored wheels: `wheels/` (or `vendor/wheels/`) in its app root,
 *      or `--find-links` lines in its requirements.txt (the DQX Studio layout).
 *   3. a shared wheelhouse on a UC VOLUME (APPCEPTION_WHEELHOUSE=/Volumes/<c>/<s>/<v>/<dir>),
 *      the same "libraries on a volume" method used for cluster installs. An Apps
 *      container cannot mount /Volumes (measured: PermissionError), so the catalog
 *      copies the wheels into the container over the workspace Files API — a call to
 *      the workspace itself, not the internet — as the catalog's service principal,
 *      which needs READ VOLUME on it (bind the volume as an app resource).
 *
 * Node: offline mode never contacts a registry. A child that needs packages ships its
 * `node_modules/` (built for linux x64) or a bundled server; a frontend ships its built
 * output. Anything else fails fast with a message naming what to vendor.
 *
 * With APPCEPTION_OFFLINE unset, sources 2 and 3 are still used (as extra find-links) and
 * the index stays on, so a vendored child also deploys on a connected workspace.
 */
import { mkdirSync, readdirSync, statSync, writeFileSync, readFileSync, renameSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { normaliseHost } from './workspace.mjs';
import { env } from './env.mjs';

export const isOffline = () => /^(1|true|yes)$/i.test(env('OFFLINE') ?? '');

/** Env that makes every installer refuse the network instead of hanging on it. */
export function offlineEnv() {
  if (!isOffline()) return {};
  return {
    PIP_NO_INDEX: '1', UV_OFFLINE: '1', UV_NO_INDEX: '1',
    npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false',
    // a CPython download is the other thing uv does silently (DQX Studio FINDINGS #2)
    UV_PYTHON_DOWNLOADS: 'never',
  };
}

const hasWheels = (d) => { try { return statSync(d).isDirectory() && readdirSync(d).some((n) => n.endsWith('.whl')); } catch { return false; } };

/** Directories to pass as --find-links for a child, in priority order. */
export function findLinks(appRoot, root) {
  const out = [];
  for (const d of [join(appRoot, 'wheels'), join(appRoot, 'vendor', 'wheels')]) if (hasWheels(d)) out.push(d);
  const shared = wheelhouseDir(root);
  if (hasWheels(shared)) out.push(shared);
  return out;
}

export function wheelhouseDir(root) {
  const base = env('STATE_DIR') ? resolve(env('STATE_DIR')) : join(root, '.catalog');
  return join(base, 'wheelhouse');
}

/* ── shared wheelhouse on a UC volume, copied in over the Files API ────────────────── */

let synced = null; // one sync per process, shared by every child
export function syncWheelhouse(root, log) {
  if (!synced) synced = doSync(root);
  return synced.then((r) => { log?.write(`[catalog] shared wheelhouse: ${r.summary}\n`); return r; });
}

async function spToken(host) {
  const id = process.env.DATABRICKS_CLIENT_ID;
  const secret = process.env.DATABRICKS_CLIENT_SECRET;
  if (!id || !secret) return null;
  const r = await fetch(`${host}/oidc/v1/token`, {
    method: 'POST',
    headers: { authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&scope=all-apis', signal: AbortSignal.timeout(15000),
  });
  const b = await r.json().catch(() => ({}));
  if (!r.ok || !b.access_token) throw new Error(`service principal token: HTTP ${r.status}`);
  return b.access_token;
}

async function doSync(root) {
  const src = (env('WHEELHOUSE') ?? '').trim().replace(/\/+$/, '');
  const dest = wheelhouseDir(root);
  if (!src) return { ok: true, files: 0, summary: 'none configured (APPCEPTION_WHEELHOUSE unset)' };
  if (!/^\/Volumes\/[^/]+\/[^/]+\/[^/]+/.test(src)) return { ok: false, files: 0, summary: `APPCEPTION_WHEELHOUSE must be a /Volumes/<catalog>/<schema>/<volume>/... path, got ${src}` };
  const host = normaliseHost(process.env.DATABRICKS_HOST);
  let token;
  try { token = host ? (await spToken(host)) ?? process.env.DATABRICKS_TOKEN ?? null : null; } catch (e) { return { ok: false, files: 0, summary: `could not authenticate: ${e.message}` }; }
  if (!host || !token) return { ok: false, files: 0, summary: `no workspace credentials in this process (DATABRICKS_HOST/CLIENT_ID/SECRET) — ${src} not copied` };
  const auth = { authorization: `Bearer ${token}` };
  const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
  // list (one level; a wheelhouse is flat), then copy every .whl not already here at the same size
  const names = [];
  let pageToken = '';
  do {
    const r = await fetch(`${host}/api/2.0/fs/directories${enc(src)}${pageToken ? `?page_token=${encodeURIComponent(pageToken)}` : ''}`, { headers: auth, signal: AbortSignal.timeout(30000) }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }));
    if (!r.ok) {
      const body = (await r.text()).slice(0, 200);
      return { ok: false, files: 0, summary: `listing ${src} failed: HTTP ${r.status} ${body}${r.status === 403 ? ' — grant the catalog app READ VOLUME (bind the volume as an app resource)' : ''}` };
    }
    const b = await r.json();
    for (const e of b.contents ?? []) if (!e.is_directory && e.name?.endsWith('.whl')) names.push({ name: e.name, size: Number(e.file_size) });
    pageToken = b.next_page_token ?? '';
  } while (pageToken);
  mkdirSync(dest, { recursive: true });
  let copied = 0;
  let bytes = 0;
  for (const { name, size } of names) {
    const out = join(dest, basename(name));
    try { if (statSync(out).size === size) continue; } catch { /* missing */ }
    const r = await fetch(`${host}/api/2.0/fs/files${enc(`${src}/${name}`)}`, { headers: auth, signal: AbortSignal.timeout(600000) });
    if (!r.ok) return { ok: false, files: copied, summary: `downloading ${name} failed: HTTP ${r.status}` };
    const buf = Buffer.from(await r.arrayBuffer());
    if (Number.isFinite(size) && buf.length !== size) return { ok: false, files: copied, summary: `${name}: got ${buf.length} bytes, listing says ${size}` };
    writeFileSync(`${out}.part`, buf);
    renameSync(`${out}.part`, out);
    copied += 1;
    bytes += buf.length;
  }
  return { ok: true, files: names.length, copied, summary: `${names.length} wheel(s) in ${src}; copied ${copied} (${(bytes / 1e6).toFixed(1)} MB) to ${dest}` };
}

/* ── requirement lines the platform's pre-installed libraries already satisfy ──────── */

// Runs under the PLATFORM interpreter: packaging comes vendored with pip.
const FILTER_PY = String.raw`
import json, os, sys
from importlib import metadata
try:
    from packaging.requirements import Requirement
except ImportError:
    from pip._vendor.packaging.requirements import Requirement
src, out = sys.argv[1], sys.argv[2]
kept, satisfied = [], []
def ok(req, seen):
    try:
        v = metadata.version(req.name)
    except metadata.PackageNotFoundError:
        return False
    if req.specifier and not req.specifier.contains(v, prereleases=True):
        return False
    for extra in req.extras:          # uvicorn[standard] needs uvloop, httptools ... too
        for r in metadata.requires(req.name) or []:
            d = Requirement(r)
            if d.marker and d.marker.evaluate({"extra": extra}) and not (d.marker.evaluate({"extra": ""})):
                if d.name.lower() not in seen and not ok(d, seen | {d.name.lower()}):
                    return False
    return True
for raw in open(src).read().splitlines():
    line = raw.split(" #")[0].strip()
    if not line or line.startswith("#"):
        continue
    if line.startswith("-"):          # --find-links / --no-index / -r ... : keep, paths made absolute
        parts = line.replace("=", " ", 1).split(None, 1) if line.startswith("--") else line.split(None, 1)
        if parts[0] in ("--find-links", "-f", "-r", "--requirement", "-c", "--constraint") and len(parts) == 2 \
                and "://" not in parts[1] and not os.path.isabs(parts[1]):
            line = f"{parts[0]} {os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(src)), parts[1]))}"
        kept.append(line); continue
    try:
        req = Requirement(line)
    except Exception:
        kept.append(raw); continue    # a path or URL: let the installer decide
    if req.marker and not req.marker.evaluate():
        continue
    if ok(req, {req.name.lower()}):
        satisfied.append(f"{req.name}=={metadata.version(req.name)}")
    else:
        kept.append(raw)
open(out, "w").write("\n".join(kept) + "\n")
print(json.dumps({"kept": [k for k in kept if not k.lstrip().startswith("-")], "satisfied": satisfied}))
`;

/** Write `out` = requirements.txt minus the lines the platform venv satisfies. */
export function filterRequirements(platPy, reqFile, out) {
  const r = spawnSync(platPy, ['-I', '-c', FILTER_PY, reqFile, out], { encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0) return { ok: false, error: (r.stderr || r.stdout || '').slice(-600) };
  try { return { ok: true, ...JSON.parse(r.stdout.trim().split('\n').pop()) }; } catch { return { ok: false, error: r.stdout.slice(-300) }; }
}

/** True when a requirements file already carries its own --find-links/--no-index. */
export function requirementsSelfContained(reqFile) {
  try { return /^\s*(--find-links|-f\s|--no-index)/m.test(readFileSync(reqFile, 'utf8')); } catch { return false; }
}

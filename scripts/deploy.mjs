#!/usr/bin/env node
/**
 * Deploy the App Catalog — ONE command, re-runnable:
 *
 *   node scripts/deploy.mjs                       # profile $DATABRICKS_CONFIG_PROFILE (or DEFAULT), app app-catalog
 *   node scripts/deploy.mjs --profile P --app NAME [--dry-run] [--no-build] [--strict] [--prune-remote-children]
 *
 * What it does, in order, and why each step exists:
 *  1. Discovers child_apps/ with the SAME module the server uses (catalog/lib/discover.mjs).
 *  2. Runs a child's own databricks.yml `artifacts` build when its source_code_path does not
 *     exist yet (e.g. an apx app's `.build/`), exactly as `databricks bundle deploy` of that
 *     child would — in a scratch copy, so the child's committed files are never rewritten.
 *  3. Stages ONLY what the platform would ship for each child: its app root (git's view —
 *     tracked + untracked-not-ignored, so nested .gitignore files apply as they do to a
 *     standalone `databricks sync`), plus the metadata the catalog reads (README, licence,
 *     databricks.yml, catalog.yaml, root package.json / pyproject.toml). A child repo's docs,
 *     decks and data never reach the workspace. Files over 10 MB are refused by name.
 *  4. Uploads changed files only (RAW workspace import: bytes exact, never converted to a
 *     notebook) and PRUNES remote files that are no longer staged — the app snapshots the
 *     source folder, so a stale file would otherwise keep being served.
 *  5. Binds the union of every child's declared OBO scopes and resources to the catalog app
 *     (warehouses, serving endpoints, Genie spaces …) — merged with what is already bound,
 *     never removing anything someone added by hand.
 *  6. Deploys, waits for the deployment itself (not the CLI) to finish, then asks the RUNNING
 *     app for /_catalog/api/health and fails unless it reports THIS build id and THIS code
 *     fingerprint. A green exit code is not evidence; the container's answer is.
 *
 * Needs: Node >= 18, the Databricks CLI logged in to the profile. Never prints a token.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverAll, SKIP_DIRS } from '../catalog/lib/discover.mjs';
import { resourceKind, resourceTarget } from '../catalog/lib/workspace.mjs';
import yaml from '../catalog/vendor/js-yaml/js-yaml.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const PROFILE = opt('--profile', process.env.DATABRICKS_CONFIG_PROFILE || 'DEFAULT');
const APP = opt('--app', 'app-catalog');
const DRY = flag('--dry-run');
// --stage-dir <dir>: write exactly what would be shipped into <dir> and stop — no workspace,
// no login (used by scripts/build_airgap_bundle.sh). --only a,b limits the children.
const STAGE_DIR = opt('--stage-dir', null);
const ONLY = opt('--only', null)?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
const NO_BUILD = flag('--no-build');
const STRICT = flag('--strict');
const MAX_FILE = 10 * 1024 * 1024;
const t0 = Date.now();
const log = (...a) => console.log(`[deploy ${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s]`, ...a);
const die = (msg) => { console.error(`\n[deploy] FAILED: ${msg}`); process.exit(1); };

/* ── auth (the token stays in this process) ─────────────────────────────── */
function cliToken() {
  const r = spawnSync('databricks', ['auth', 'token', '--profile', PROFILE], { encoding: 'utf8' });
  if (r.status !== 0) die(`databricks auth token -p ${PROFILE} failed — run: databricks auth login -p ${PROFILE}\n${r.stderr.slice(0, 300)}`);
  return JSON.parse(r.stdout).access_token;
}
function hostFor(profile) {
  const cfg = readFileSync(join(homedir(), '.databrickscfg'), 'utf8');
  const sec = cfg.split(/^\[/m).find((s) => s.startsWith(`${profile}]`));
  const m = sec && /^\s*host\s*=\s*(\S+)/m.exec(sec);
  if (!m) die(`no host for profile ${profile} in ~/.databrickscfg`);
  return m[1].replace(/\/+$/, '');
}
const HOST = STAGE_DIR ? null : hostFor(PROFILE);
let TOKEN = STAGE_DIR ? null : cliToken();
let tokenAt = Date.now();
async function api(method, path, body, { allow = [] } = {}) {
  if (Date.now() - tokenAt > 40 * 60000) { TOKEN = cliToken(); tokenAt = Date.now(); }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const r = await fetch(`${HOST}${path}`, {
      method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(120000),
    }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }));
    const text = await r.text();
    if (r.ok || allow.includes(r.status)) { try { return { status: r.status, body: text ? JSON.parse(text) : {} }; } catch { return { status: r.status, body: { raw: text } }; } }
    if ([429, 500, 502, 503, 504, 0].includes(r.status) && attempt < 3) { await new Promise((s) => setTimeout(s, 1500 * (attempt + 1))); continue; }
    throw new Error(`${method} ${path} -> HTTP ${r.status}: ${text.slice(0, 300)}`);
  }
}

/* ── 1. discover ─────────────────────────────────────────────────────────── */
let { children, problems } = discoverAll(ROOT);
if (problems.length) die(`catalog.overrides.yaml: ${problems.join('; ')}`);
if (ONLY && ONLY.length === 1 && ONLY[0] === 'none') ONLY.length = 0; // --only none: the master alone
if (ONLY) {
  const missing = ONLY.filter((n) => !children.some((c) => c.name === n));
  if (missing.length) die(`--only names children that do not exist: ${missing.join(', ')}`);
  children = children.filter((c) => ONLY.includes(c.name));
}
log(`${children.length} children: ${children.map((c) => c.name).join(', ')}`);

/* ── 2. children whose databricks.yml builds the app first ───────────────── */
function sh(cmd, cwd, timeoutMs = 15 * 60000) {
  const r = spawnSync('sh', ['-c', cmd], { cwd, encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, CI: '1' } });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.slice(-3000), status: r.status, signal: r.signal };
}
function treeHash(dir, exclude) {
  const h = createHash('sha1');
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', '.'], { cwd: dir, encoding: 'utf8' }).split('\n').filter(Boolean)
    .filter((f) => !(exclude && (f === exclude || f.startsWith(`${exclude}/`)))).sort();
  for (const f of files) { h.update(f); try { h.update(readFileSync(join(dir, f))); } catch { /* deleted */ } }
  return h.digest('hex');
}
const built = new Set();
// Every child whose app root is produced by its bundle's artifact build is checked on EVERY
// deploy (by a hash of its source), not only when the output is missing — otherwise a stale
// build would ship silently after the child's source changed.
for (const c of children.filter((x) => x.artifacts)) {
  if (NO_BUILD) { log(`${c.name}: artifact build check skipped (--no-build)`); continue; }
  const cache = join(homedir(), '.cache', 'app-catalog', 'builds', c.name);
  const spec = c.artifacts;
  const outRel = spec.source_code_path.replace(/^\.\//, '');
  const stamp = join(cache, '.catalog-build-source');
  const src = treeHash(c.dir, outRel);
  if (existsSync(join(cache, outRel)) && existsSync(stamp) && readFileSync(stamp, 'utf8') === src) {
    log(`${c.name}: artifact build is current (source unchanged) — reusing ${outRel}/`);
  } else {
    log(`${c.name}: running its databricks.yml artifact build in a scratch copy (${spec.artifacts.map((a) => a.build).join(' && ')})`);
    mkdirSync(cache, { recursive: true });
    const rs = sh(`rsync -a --delete --exclude node_modules --exclude .venv --exclude .git --exclude ${outRel} --exclude .catalog-build-source ${JSON.stringify(`${c.dir}/`)} ${JSON.stringify(`${cache}/`)}`, ROOT);
    if (!rs.ok) die(`${c.name}: rsync to the build cache failed: ${rs.out}`);
    // version tooling (e.g. uv-dynamic-versioning) wants a git repo; the scratch copy gets its own
    if (!existsSync(join(cache, '.git'))) sh('git init -q && git add -A && git -c user.email=catalog@local -c user.name=catalog commit -qm build', cache);
    else sh('git add -A && git -c user.email=catalog@local -c user.name=catalog commit -qm build --allow-empty', cache);
    if (existsSync(join(cache, 'package.json')) && !existsSync(join(cache, 'node_modules'))) {
      const installer = existsSync(join(cache, 'bun.lock')) || existsSync(join(cache, 'bun.lockb')) ? 'bun install'
        : existsSync(join(cache, 'pnpm-lock.yaml')) ? 'corepack pnpm install --frozen-lockfile'
          : existsSync(join(cache, 'package-lock.json')) ? 'npm ci' : 'npm install';
      log(`${c.name}: installing its JS dependencies first (${installer})`);
      const r = sh(installer, cache);
      if (!r.ok) { log(`${c.name}: ${installer} FAILED — the catalog will show it as "needs build"\n${r.out}`); continue; }
    }
    let ok = true;
    for (const a of spec.artifacts) {
      const r = sh(a.build, cache);
      if (!r.ok) { ok = false; log(`${c.name}: "${a.build}" FAILED (exit ${r.status}${r.signal ? `, ${r.signal}` : ''}) — the catalog will show it as "needs build"\n${r.out}`); break; }
    }
    if (!ok || !existsSync(join(cache, outRel))) { if (ok) log(`${c.name}: build finished but ${outRel}/ was not produced`); continue; }
    writeFileSync(stamp, src);
  }
  const dest = join(c.dir, outRel);
  rmSync(dest, { recursive: true, force: true });
  cpSync(join(cache, outRel), dest, { recursive: true });
  built.add(c.name);
  log(`${c.name}: ${outRel}/ ready (${readdirSync(dest).length} entries)`);
}
if (built.size) ({ children } = discoverAll(ROOT));
if (ONLY) children = children.filter((c) => ONLY.includes(c.name));

/* ── 3. stage ────────────────────────────────────────────────────────────── */
const sha = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim() || 'nogit';
const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
const BUILD_ID = `${sha}${dirty ? '-dirty' : ''}-${Math.floor(Date.now() / 1000)}`;
if (dirty) log(`working tree has uncommitted changes — the deploy ships the WORKING TREE (build id marked -dirty):\n${dirty.split('\n').slice(0, 12).map((l) => `   ${l}`).join('\n')}`);
if (!DRY) writeFileSync(join(ROOT, 'catalog', 'BUILD_ID'), `${BUILD_ID}\n`);

const staged = new Map(); // rel path -> abs path
const refused = [];
const skippedEnv = [];
function add(abs, { vendored = false } = {}) {
  const rel = relative(ROOT, abs).split(sep).join('/');
  // a vendored node_modules/ (air-gapped child) is shipped on purpose; every other skip dir is not
  if (rel.split('/').some((seg) => SKIP_DIRS.has(seg) && !(vendored && seg === 'node_modules'))) return;
  if (/(^|\/)\.env(\.|$)/.test(rel)) { skippedEnv.push(rel); return; }
  if (/(^|\/)\.DS_Store$/.test(rel)) return;
  const st = statSync(abs);
  if (!st.isFile()) return;
  if (st.size > MAX_FILE) { refused.push(`${rel} (${(st.size / 1e6).toFixed(1)} MB)`); return; }
  staged.set(rel, abs);
}
function gitFiles(dir) {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.'], { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\0').filter(Boolean).map((f) => join(dir, f));
}
function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) out.push(...walk(p)); } else out.push(p);
  }
  return out;
}
// master
for (const f of ['app.yaml', 'package.json', 'catalog.overrides.yaml']) if (existsSync(join(ROOT, f))) add(join(ROOT, f));
for (const f of walk(join(ROOT, 'catalog'))) add(f);
if (!existsSync(join(ROOT, 'catalog', 'ui', 'index.html'))) die('catalog/ui is not built — run: npm run build:ui');
// children
for (const c of children) {
  for (const n of readdirSync(c.dir)) {
    if (/^(readme|licen[cs]e|notice|copying)(\.|$)/i.test(n) || ['databricks.yml', 'databricks.yaml', 'catalog.yaml', 'catalog.yml', 'package.json', 'pyproject.toml', 'app.yaml', 'app.yml'].includes(n)) {
      if (statSync(join(c.dir, n)).isFile()) add(join(c.dir, n));
    }
  }
  if (!existsSync(c.appRoot)) continue;
  // the platform ships the source_code_path of a built child even though it is git-ignored
  // A built artifact root is usually git-ignored by its own .gitignore ('*' in apx's .build/),
  // and the child's databricks.yml force-includes it; so walk it rather than ask git.
  const files = c.artifactRoot || built.has(c.name) ? walk(c.appRoot) : gitFiles(c.appRoot);
  for (const f of files) add(f);
  // Vendored dependencies are shipped even when a .gitignore hides them (a wheelhouse is
  // often ignored as a build output, and a silently missing wheel only fails at install time).
  for (const d of ['wheels', join('vendor', 'wheels')]) if (existsSync(join(c.appRoot, d))) for (const f of walk(join(c.appRoot, d))) add(f);
  if (c.vendorNodeModules && existsSync(join(c.appRoot, 'node_modules'))) {
    const walkAll = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walkAll(join(dir, e.name)) : [join(dir, e.name)]));
    for (const f of walkAll(join(c.appRoot, 'node_modules'))) add(f, { vendored: true });
  }
}
if (refused.length) die(`files over 10 MB cannot be deployed to Databricks Apps (move them out of the app root):\n  ${refused.join('\n  ')}`);
if (skippedEnv.length) log(`not shipping local .env files: ${skippedEnv.join(', ')}`);
let bytes = 0;
for (const abs of staged.values()) bytes += statSync(abs).size;
log(`staged ${staged.size} files (${(bytes / 1e6).toFixed(1)} MB): master ${[...staged.keys()].filter((k) => !k.startsWith('child_apps/')).length}, ${children.map((c) => `${c.name} ${[...staged.keys()].filter((k) => k.startsWith(`child_apps/${c.name}/`)).length}`).join(', ')}`);

if (STAGE_DIR) {
  const out = resolve(STAGE_DIR);
  if (existsSync(out) && readdirSync(out).length) die(`--stage-dir ${out} is not empty`);
  for (const [rel, abs] of staged) { mkdirSync(dirname(join(out, rel)), { recursive: true }); cpSync(abs, join(out, rel)); }
  const n = (function count(d) { return readdirSync(d, { withFileTypes: true }).reduce((s, e) => s + (e.isDirectory() ? count(join(d, e.name)) : 1), 0); })(out);
  if (n !== staged.size) die(`staged ${staged.size} files but ${n} are in ${out}`);
  log(`stage dir ${out}: ${n} files (== staged)`);
  process.exit(0);
}

/* ── 4. upload changed files, prune stale ones ───────────────────────────── */
const me = (await api('GET', '/api/2.0/preview/scim/v2/Me')).body.userName;
const DEST = opt('--source-path', `/Workspace/Users/${me}/apps/${APP}`);
const stateDir = join(ROOT, '.catalog-deploy');
mkdirSync(stateDir, { recursive: true });
const manifestFile = join(stateDir, `${PROFILE}--${APP}.json`);
const prevManifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : {};

async function listRemote(dir) {
  const out = new Map();
  const queue = [dir];
  while (queue.length) {
    const d = queue.shift();
    const r = await api('GET', `/api/2.0/workspace/list?path=${encodeURIComponent(d)}`, null, { allow: [404] });
    if (r.status === 404) continue;
    for (const o of r.body.objects ?? []) {
      if (o.object_type === 'DIRECTORY') queue.push(o.path);
      else out.set(o.path, o);
    }
  }
  return out;
}
const remote = await listRemote(DEST);
log(`remote ${DEST}: ${remote.size} files`);
const want = new Map([...staged].map(([rel, abs]) => [`${DEST}/${rel}`, { rel, abs }]));
const toUpload = [];
const nextManifest = {};
for (const [rpath, { rel, abs }] of want) {
  const buf = readFileSync(abs);
  const h = createHash('sha1').update(buf).digest('hex');
  nextManifest[rel] = h;
  const r = remote.get(rpath);
  if (prevManifest[rel] === h && r && (r.size == null || Number(r.size) === buf.length)) continue;
  toUpload.push({ rpath, rel, buf });
}
// Teammates add and remove children straight in the workspace folder (README "Teammate flow").
// A child folder that exists ONLY there is theirs: keep it (it is not "stale"), unless asked.
const childOf = (p) => /\/child_apps\/([^/]+)\//.exec(p.slice(DEST.length))?.[1] ?? null;
const localChildren = new Set(children.map((c) => c.name));
const remoteOnly = [...new Set([...remote.keys()].map(childOf).filter((n) => n && !localChildren.has(n)))].sort();
const PRUNE_REMOTE_CHILDREN = flag('--prune-remote-children');
if (remoteOnly.length) {
  log(PRUNE_REMOTE_CHILDREN
    ? `--prune-remote-children: REMOVING workspace-only children ${remoteOnly.join(', ')}`
    : `keeping workspace-only children (added in the workspace, not in this repo): ${remoteOnly.join(', ')} — copy them into child_apps/ to track them, or pass --prune-remote-children to remove them`);
}
const removedRemotely = [...localChildren].filter((n) => Object.keys(prevManifest).some((k) => k.startsWith(`child_apps/${n}/`))
  && ![...remote.keys()].some((p) => childOf(p) === n));
if (removedRemotely.length) log(`NOTE: ${removedRemotely.join(', ')} ${removedRemotely.length > 1 ? 'were' : 'was'} removed from the workspace folder since the last deploy from here; this deploy ADDS ${removedRemotely.length > 1 ? 'them' : 'it'} back (delete the folder from child_apps/ here too if that removal was intended)`);
const toDelete = [...remote.keys()].filter((p) => !want.has(p) && (PRUNE_REMOTE_CHILDREN || !remoteOnly.includes(childOf(p))));
log(`upload ${toUpload.length} changed file(s), prune ${toDelete.length} stale file(s)`);
if (DRY) { log('dry run — nothing written'); for (const u of toUpload.slice(0, 40)) console.log('   +', u.rel); for (const d of toDelete.slice(0, 40)) console.log('   -', d.slice(DEST.length + 1)); process.exit(0); }

const dirs = new Set(toUpload.map((u) => u.rpath.slice(0, u.rpath.lastIndexOf('/'))));
for (const d of [...dirs].sort()) await api('POST', '/api/2.0/workspace/mkdirs', { path: d });
let done = 0;
async function uploader() {
  while (toUpload.length) {
    const u = toUpload.shift();
    await api('POST', '/api/2.0/workspace/import', { path: u.rpath, format: 'RAW', overwrite: true, content: u.buf.toString('base64') });
    done += 1;
    if (done % 25 === 0) log(`  uploaded ${done}`);
  }
}
await Promise.all(Array.from({ length: 8 }, uploader));
// Prune only inside our own folder, and only when it is recognisably ours.
if (toDelete.length) {
  if (!remote.has(`${DEST}/catalog/server.mjs`) && !want.has(`${DEST}/catalog/server.mjs`)) die(`refusing to prune ${DEST}: it does not look like a catalog deployment`);
  mkdirSync(join(stateDir, 'pruned'), { recursive: true });
  writeFileSync(join(stateDir, 'pruned', `${new Date().toISOString().replace(/[:.]/g, '-')}.txt`), `${toDelete.join('\n')}\n`);
  for (const p of toDelete) await api('POST', '/api/2.0/workspace/delete', { path: p, recursive: false }, { allow: [404] });
}
writeFileSync(manifestFile, JSON.stringify(nextManifest, null, 2));
const after = await listRemote(DEST);
const missing = [...want.keys()].filter((p) => !after.has(p));
if (missing.length) die(`${missing.length} staged files are not in the workspace after upload, e.g. ${missing.slice(0, 5).join(', ')}`);
const kept = [...after.keys()].filter((p) => !want.has(p)).length;
log(`workspace folder verified: ${want.size} staged files present${kept ? ` (+ ${kept} kept from workspace-only children)` : ''}`);

/* ── 5. bind the union of scopes and resources ───────────────────────────── */
const DEFAULT_SCOPES = new Set(['iam.access-control:read', 'iam.current-user:read']);
let app = (await api('GET', `/api/2.0/apps/${APP}`, null, { allow: [404] }));
if (app.status === 404) {
  log(`creating app ${APP}`);
  await api('POST', '/api/2.0/apps', { name: APP, description: 'App Catalog: one Databricks App that hosts many child demo apps.', user_api_scopes: [...new Set(children.flatMap((c) => c.scopes))] });
  app = await api('GET', `/api/2.0/apps/${APP}`);
}
app = app.body;
const scopes = new Set((app.user_api_scopes ?? []).filter((s) => !DEFAULT_SCOPES.has(s)));
for (const c of children) for (const s of c.scopes) scopes.add(s);
const shortKind = { sql_warehouse: 'warehouse', serving_endpoint: 'endpoint', genie_space: 'genie', job: 'job', secret: 'secret', uc_securable: 'uc', database: 'lakebase', experiment: 'experiment', app: 'app' };
// Keep everything already bound (including what someone added by hand), once each.
const bound = [];
const boundKeys = new Set();
let dupes = 0;
for (const r of app.resources ?? []) {
  const key = `${resourceKind(r)}:${resourceTarget(r)}`;
  if (resourceTarget(r) && boundKeys.has(key)) { dupes += 1; continue; }
  boundKeys.add(key);
  bound.push(r);
}
const added = [];
// The shared wheelhouse volume named in app.yaml (CATALOG_WHEELHOUSE) — the catalog's SP reads it
// over the Files API at build time, so it needs READ VOLUME, which binding the volume grants.
const masterEnv = (() => { try { return yaml.load(readFileSync(join(ROOT, 'app.yaml'), 'utf8'))?.env ?? []; } catch { return []; } })();
const wheelhouse = masterEnv.find((e) => e?.name === 'CATALOG_WHEELHOUSE')?.value;
const vol = /^\/Volumes\/([^/]+)\/([^/]+)\/([^/]+)/.exec(String(wheelhouse ?? ''));
if (vol) {
  const full = `${vol[1]}.${vol[2]}.${vol[3]}`;
  if (!boundKeys.has(`uc_securable:${full}`)) {
    bound.push({ name: 'wheelhouse', description: 'shared wheelhouse for child installs (CATALOG_WHEELHOUSE)', uc_securable: { securable_type: 'VOLUME', securable_full_name: full, permission: 'READ_VOLUME' } });
    boundKeys.add(`uc_securable:${full}`);
    added.push(`wheelhouse = volume ${full} (READ_VOLUME)`);
  }
}
for (const c of children) {
  for (const r of c.resources) {
    const kind = resourceKind(r);
    const target = resourceTarget(r);
    if (!target || kind === 'other' || boundKeys.has(`${kind}:${target}`)) continue;
    const { name: _n, _from: _f, description: _d, ...spec } = r;
    const name = `${shortKind[kind] ?? kind}-${createHash('sha1').update(String(target)).digest('hex').slice(0, 6)}`;
    bound.push({ name, description: `for ${c.name} (${r.name})`, ...spec });
    boundKeys.add(`${kind}:${target}`);
    added.push(`${name} = ${kind} ${target} (${c.name})`);
  }
}
const scopesChanged = JSON.stringify([...scopes].sort()) !== JSON.stringify((app.user_api_scopes ?? []).filter((s) => !DEFAULT_SCOPES.has(s)).sort());
if (dupes) log(`removing ${dupes} duplicate binding(s) of the same resource`);
if (scopesChanged || added.length || dupes) {
  const body = {
    // NOT compute_size: this API refuses it ("Compute size updates are not supported in this
    // update API"), and omitting it leaves the size unchanged (measured: MEDIUM stayed MEDIUM).
    name: APP, description: app.description,
    user_api_scopes: [...scopes].sort(), resources: bound,
    ...(app.budget_policy_id ? { budget_policy_id: app.budget_policy_id } : {}),
    ...(app.usage_policy_id ? { usage_policy_id: app.usage_policy_id } : {}),
  };
  log(`updating app: scopes ${JSON.stringify(body.user_api_scopes)}${added.length ? `; binding ${added.length} resource(s):\n   ${added.join('\n   ')}` : ''}`);
  // A just-created app's compute is STARTING, and the update API refuses anything but
  // ACTIVE or STOPPED ("Cannot update app ... as its compute is in STARTING state").
  for (let i = 0; i < 120 && !['ACTIVE', 'STOPPED', 'ERROR'].includes(app.compute_status?.state); i += 1) {
    if (i === 0) log(`compute is ${app.compute_status?.state} — waiting before the update`);
    await new Promise((s) => setTimeout(s, 5000));
    app = (await api('GET', `/api/2.0/apps/${APP}`)).body;
  }
  await api('PATCH', `/api/2.0/apps/${APP}`, body);
} else log(`app already has every declared scope (${[...scopes].join(', ') || 'none'}) and resource (${bound.length})`);

/* ── 6. deploy, then ask the running app ─────────────────────────────────── */
app = (await api('GET', `/api/2.0/apps/${APP}`)).body;
if (app.compute_status?.state !== 'ACTIVE') {
  log(`compute is ${app.compute_status?.state} — starting`);
  await api('POST', `/api/2.0/apps/${APP}/start`, {}, { allow: [400, 409] });
  for (let i = 0; i < 120; i += 1) {
    await new Promise((s) => setTimeout(s, 5000));
    app = (await api('GET', `/api/2.0/apps/${APP}`)).body;
    if (app.compute_status?.state === 'ACTIVE') break;
  }
  if (app.compute_status?.state !== 'ACTIVE') die(`compute did not become ACTIVE: ${JSON.stringify(app.compute_status)}`);
}
log(`deploying ${DEST} -> ${APP}`);
const dep = (await api('POST', `/api/2.0/apps/${APP}/deployments`, { source_code_path: DEST, mode: 'SNAPSHOT' })).body;
let d = dep;
for (let i = 0; i < 360 && ['IN_PROGRESS', 'PENDING', undefined].includes(d.status?.state); i += 1) {
  await new Promise((s) => setTimeout(s, 5000));
  d = (await api('GET', `/api/2.0/apps/${APP}/deployments/${dep.deployment_id}`)).body;
  if (i % 6 === 5) log(`  deployment ${dep.deployment_id}: ${d.status?.state} — ${d.status?.message ?? ''}`);
}
if (d.status?.state !== 'SUCCEEDED') die(`deployment ${dep.deployment_id} ended ${d.status?.state}: ${d.status?.message}`);
log(`deployment ${dep.deployment_id} SUCCEEDED — ${d.status?.message}`);

const expectFp = (() => {
  const h = createHash('md5');
  const w = (dd) => { for (const n of readdirSync(dd).sort()) { const p = join(dd, n); const st = statSync(p); if (st.isDirectory()) { if (!['ui', 'vendor'].includes(n)) w(p); } else if (/\.(mjs|js)$/.test(n)) { h.update(n); h.update(readFileSync(p)); } } };
  w(join(ROOT, 'catalog'));
  return h.digest('hex');
})();
let health = null;
for (let i = 0; i < 24; i += 1) {
  const r = await fetch(`${app.url}/_catalog/api/health`, { headers: { authorization: `Bearer ${TOKEN}` }, redirect: 'manual', signal: AbortSignal.timeout(30000) }).catch(() => null);
  const text = r ? await r.text() : '';
  if (r?.status === 200 && text.startsWith('{')) { health = JSON.parse(text); if (health.buildId === BUILD_ID) break; }
  await new Promise((s) => setTimeout(s, 5000));
}
if (!health) die(`${app.url}/_catalog/api/health never answered with JSON`);
if (health.buildId !== BUILD_ID) die(`the running app reports build ${health.buildId}, expected ${BUILD_ID}`);
if (health.fingerprint !== expectFp) die(`the running app's code fingerprint ${health.fingerprint} != local ${expectFp}`);
log(`running app confirms build ${health.buildId} and code fingerprint ${health.fingerprint.slice(0, 12)}`);
console.log('\n  child                       prepared        problems');
let bad = 0;
for (const c of health.children) {
  const ok = c.prepare === 'ready' && !c.problems.length;
  if (!ok) bad += 1;
  console.log(`  ${c.name.padEnd(27)} ${String(c.prepare).padEnd(15)} ${c.problems.join('; ') || (c.prepare === 'needs_build' ? 'needs its artifact build' : '')}`);
}
console.log(`\n  ${app.url}\n  ${health.children.length - bad}/${health.children.length} children prepared · ${((Date.now() - t0) / 1000).toFixed(0)}s total`);
if (STRICT && bad) process.exit(2);

/**
 * App-ception — the master app.
 *
 * ONE Databricks App that serves a catalog of child apps, each found in
 * child_apps/<name>/ and run as a subprocess on its own localhost port, behind
 * this server at /apps/<name>/.
 *
 * Routes (the master owns only "/", "/_catalog/**" and "/apps/<name>/**"):
 *   /                         catalog UI (top-level documents only)
 *   /?app=<name>[&path=…]     the catalog's viewer, with the child in a frame
 *   /apps/<name>/…            the child, prefix stripped
 *   /_catalog/api/…           catalog API
 *   /_catalog/ui/…            catalog UI assets
 *   /_catalog/shim.js         the URL shim injected into child pages
 *   anything else             a root-relative URL that escaped a child: routed
 *                             back to it by Referer, then by the last-child
 *                             cookie (a navigation is redirected under the prefix)
 *
 * Zero npm dependencies: the platform's `npm install` has nothing to fetch.
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, extname, resolve, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { discoverAll } from './lib/discover.mjs';
import { Supervisor, containerMemory, redact } from './lib/supervisor.mjs';
import { proxyHttp, proxyUpgrade } from './lib/proxy.mjs';
import { readState, catalogDirs } from './lib/prepare.mjs';
import { ownApp, resourceValue, resourceKind, resourceTarget } from './lib/workspace.mjs';
import { isOffline, wheelhouseDir } from './lib/offline.mjs';
import { env } from './lib/env.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(env('ROOT') ?? join(HERE, '..'));
const UI_DIR = join(HERE, 'ui');
const PUBLIC_DIR = join(HERE, 'public');
const PORT = Number(process.env.DATABRICKS_APP_PORT || env('PORT') || 8790);
const STARTED_AT = new Date().toISOString();
const BUILD_ID = (() => { try { return readFileSync(join(HERE, 'BUILD_ID'), 'utf8').trim(); } catch { return 'dev'; } })();
const IS_APP = !!process.env.DATABRICKS_APP_NAME;
const DBU_PER_HOUR = { MEDIUM: 0.5, LARGE: 1, XLARGE: 3 };

/** md5 over the server's own code, so a deploy can prove WHICH code is running
 *  (a build stamp only proves a restart). */
const FINGERPRINT = (() => {
  const h = createHash('md5');
  const walk = (d) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      const st = statSync(p);
      if (st.isDirectory()) { if (!['ui', 'vendor'].includes(n)) walk(p); } else if (/\.(mjs|js)$/.test(n)) { h.update(n); h.update(readFileSync(p)); }
    }
  };
  try { walk(HERE); } catch { /* ignore */ }
  return h.digest('hex');
})();
const SHIM_VERSION = (() => { try { return createHash('md5').update(readFileSync(join(PUBLIC_DIR, 'shim.js'))).digest('hex').slice(0, 10); } catch { return '0'; } })();

const discovery = discoverAll(ROOT);
const hostsSeen = new Set();
if (process.env.DATABRICKS_APP_URL) { try { hostsSeen.add(new URL(process.env.DATABRICKS_APP_URL).host.toLowerCase()); } catch { /* ignore */ } }

async function resolveValueFrom(manifest, resName) {
  const declared = manifest.resources.find((r) => r.name === resName);
  if (declared) {
    const v = await resourceValue(declared);
    return v.ok ? { ...v, how: `declared in the child's ${declared._from}` } : v;
  }
  const own = await ownApp();
  if (!own.ok) return { ok: false, why: own.why };
  const list = own.app?.resources ?? [];
  const bound = list.find((r) => r.name === `${manifest.name}--${resName}`) ?? list.find((r) => r.name === resName);
  if (!bound) return { ok: false, why: `no resource named "${resName}" is declared by the child or bound to the catalog app` };
  const v = await resourceValue(bound);
  return v.ok ? { ...v, how: `bound to the catalog app as "${bound.name}"` } : v;
}

const sup = new Supervisor(ROOT, discovery.children, { resolveValueFrom });

/* ───────────────────────── helpers ─────────────────────────────────────────── */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
};

function send(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, { 'content-type': type, 'content-length': buf.length, ...extra });
  res.end(buf);
}
function json(res, status, obj) {
  send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8', { 'cache-control': 'no-store' });
}
function serveFile(res, file, { cache = 'no-cache', req } = {}) {
  try {
    const st = statSync(file);
    if (!st.isFile()) throw new Error('not a file');
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    if (req?.headers['if-none-match'] === etag) { res.writeHead(304, { etag, 'cache-control': cache }); res.end(); return true; }
    send(res, 200, readFileSync(file), MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', { 'cache-control': cache, etag });
    return true;
  } catch { return false; }
}
function safeJoin(base, rel) {
  const p = normalize(join(base, rel));
  return p.startsWith(base) ? p : null;
}
function readBody(req, limit = 1e6) {
  return new Promise((resolveBody) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size <= limit) chunks.push(c); });
    req.on('end', () => { try { resolveBody(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { resolveBody({}); } });
  });
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function isNavigation(req) {
  const mode = req.headers['sec-fetch-mode'];
  if (mode) return mode === 'navigate';
  return req.method === 'GET' && /text\/html/.test(req.headers.accept ?? '');
}
function isTopLevel(req) {
  const dest = req.headers['sec-fetch-dest'];
  return dest ? dest === 'document' : isNavigation(req);
}
function cookie(req, name) {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie ?? '');
  return m ? decodeURIComponent(m[1]) : null;
}
function childFromReferer(req) {
  const ref = req.headers.referer;
  if (!ref) return null;
  try {
    const u = new URL(ref);
    const fwd = String(req.headers['x-forwarded-host'] ?? '').toLowerCase();
    if (fwd && u.host.toLowerCase() !== fwd && !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(u.host)) return null;
    const m = /^\/apps\/([^/]+)/.exec(u.pathname);
    if (m) return sup.get(decodeURIComponent(m[1]));
    if (u.pathname === '/' && u.searchParams.get('app')) return sup.get(u.searchParams.get('app'));
  } catch { /* ignore */ }
  return null;
}
function childFromCookie(req) {
  const n = cookie(req, 'appception_child');
  return n ? sup.get(n) : null;
}

/* ───────────────────────── pages ───────────────────────────────────────────── */

const PAGE_CSS = `:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(1200px 600px at 20% -10%,rgba(45, 108, 223,.10),transparent 60%),#0b0e14;color:#e5e7eb;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.card{width:min(560px,92vw);padding:34px 36px;border-radius:20px;background:rgba(22,28,43,.85);border:1px solid #232b3b;box-shadow:0 30px 80px rgba(0,0,0,.45)}
h1{margin:0 0 6px;font-size:22px;letter-spacing:-.01em}.dim{color:#94a3b8}.phase{margin-top:18px;font:13px/1.4 ui-monospace,Menlo,monospace;color:#2d6cdf}
.bar{margin-top:16px;height:4px;border-radius:4px;background:#1e2636;overflow:hidden}.bar i{display:block;height:100%;width:35%;background:linear-gradient(90deg,#2d6cdf,#4f8ef7);border-radius:4px;animation:slide 1.4s ease-in-out infinite}
@keyframes slide{0%{transform:translateX(-110%)}100%{transform:translateX(320%)}}a,button{color:#ffffff;background:#2d6cdf;border:0;border-radius:999px;padding:9px 16px;font-weight:600;text-decoration:none;cursor:pointer;display:inline-block;margin-top:18px;margin-right:8px}
a.ghost{background:transparent;color:#e5e7eb;border:1px solid #2f394c}pre{white-space:pre-wrap;max-height:220px;overflow:auto;background:#0b0f16;border:1px solid #232b3b;border-radius:10px;padding:10px;font-size:12px;color:#cbd5e1}
@media (prefers-reduced-motion:reduce){.bar i{animation:none;width:100%}}`;

function interstitial(res, child, { error } = {}) {
  const s = child.status();
  const failed = !!error || ['failed', 'crashed', 'needs_build'].includes(s.state);
  const body = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(child.m.title)} · starting</title><style>${PAGE_CSS}</style></head><body><div class="card">
<div class="dim">App-ception</div><h1>${failed ? 'Could not start' : 'Starting'} ${esc(child.m.title)}</h1>
<div class="dim">${esc(child.m.frameworkLabel)} · /apps/${esc(child.name)}/</div>
${failed ? `<pre>${esc(redact(error ?? s.lastError ?? s.prepare?.error ?? 'unknown error'))}</pre><a href="#" onclick="fetch('/_catalog/api/children/${esc(child.name)}/restart',{method:'POST'}).then(()=>location.reload());return false">Retry</a><a class="ghost" href="/?app=${esc(child.name)}">Details</a>`
    : `<div class="phase" id="ph">${esc(s.phase ?? 'waking up…')}</div><div class="bar"><i></i></div>`}
<a class="ghost" href="/">Back to catalog</a></div>
${failed ? '' : `<script>(function(){var t0=Date.now();function poll(){fetch('/_catalog/api/children/${esc(child.name)}',{cache:'no-store'}).then(function(r){return r.json()}).then(function(d){var st=d.status||{};document.getElementById('ph').textContent=(st.phase||st.state)+' · '+Math.round((Date.now()-t0)/1000)+'s';if(st.state==='running'){location.reload();return}if(['failed','crashed','needs_build'].indexOf(st.state)>=0){location.reload();return}setTimeout(poll,700)}).catch(function(){setTimeout(poll,1500)})}poll()})()</script>`}
</body></html>`;
  send(res, failed ? 503 : 200, body, 'text/html; charset=utf-8', { 'cache-control': 'no-store' });
}

function notFoundPage(req, res, msg) {
  if (!isNavigation(req)) return send(res, 404, msg);
  const apps = sup.list().filter((c) => !c.m.hidden).map((c) => `<a class="ghost" href="/?app=${esc(c.name)}">${esc(c.m.title)}</a>`).join('');
  send(res, 404, `<!doctype html><html><head><meta charset="utf-8"><title>Not found</title><style>${PAGE_CSS}</style></head><body><div class="card"><div class="dim">App-ception</div><h1>Nothing here</h1><p class="dim">${esc(msg)}</p><a href="/">Open the catalog</a><div>${apps}</div></div></body></html>`, 'text/html; charset=utf-8');
}

/** Every process in the container (Linux /proc), command line redacted and trimmed. */
function processList() {
  let pids = [];
  try { pids = readdirSync('/proc').filter((n) => /^\d+$/.test(n)); } catch { return null; }
  const out = [];
  for (const pid of pids) {
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
      if (cmd) out.push({ pid: Number(pid), cmd: redact(cmd).slice(0, 200) });
    } catch { /* exited */ }
  }
  return out.sort((a, b) => a.pid - b.pid);
}

/* ───────────────────────── catalog model for the UI ──────────────────────── */

async function catalogModel(req) {
  const own = IS_APP ? await ownApp() : { ok: false, why: 'local run' };
  const app = own.ok ? own.app : null;
  const effective = new Set(app?.effective_user_api_scopes ?? app?.user_api_scopes ?? []);
  const boundKeys = new Set((app?.resources ?? []).map((r) => `${resourceKind(r)}:${resourceTarget(r)}`));
  const mem = containerMemory();
  const size = app?.compute_size ?? (IS_APP ? 'MEDIUM' : null);
  const children = sup.list().map((c) => {
    const missingScopes = app ? c.m.scopes.filter((s) => !effective.has(s)) : [];
    const resources = c.m.resources.map((r) => ({ name: r.name, kind: resourceKind(r), target: resourceTarget(r), bound: app ? boundKeys.has(`${resourceKind(r)}:${resourceTarget(r)}`) : null }));
    return {
      name: c.name, title: c.m.title, description: c.m.description, framework: c.m.framework, frameworkLabel: c.m.frameworkLabel,
      mount: c.m.mount, mountReason: c.m.mountReason, category: c.m.category, hidden: c.m.hidden, icon: c.m.icon, accent: c.m.accent,
      order: c.m.order, keepWarm: c.m.keepWarm, source: c.m.source, licenses: c.m.licenses,
      appRoot: c.m.relAppRoot, appRootReason: c.m.appRootReason, command: c.m.command, commandReason: c.m.commandReason,
      env: c.m.env.map((e) => ({ name: e.name, valueFrom: e.valueFrom ?? null, from: e.from })),
      scopes: c.m.scopes, missingScopes, resources,
      deps: { python: c.m.deps.python, node: c.m.deps.node, nodeBuild: c.m.deps.nodeBuild },
      problems: c.m.problems, warnings: c.m.warnings, needsBuild: !!c.m.needsBuild,
      status: c.status(),
    };
  });
  // Starters are templates: nobody would deploy them as separate apps, so they are not in the cost case.
  const runnable = children.filter((c) => !c.hidden && c.category !== 'starter');
  return {
    master: {
      name: process.env.DATABRICKS_APP_NAME ?? 'local', url: process.env.DATABRICKS_APP_URL ?? null, buildId: BUILD_ID, fingerprint: FINGERPRINT,
      startedAt: STARTED_AT, computeSize: size, dbuPerHour: size ? DBU_PER_HOUR[size] ?? null : null,
      memory: { limit: mem.limit, usage: mem.usage }, cpus: mem.cpus,
      scopes: [...effective], resources: (app?.resources ?? []).map((r) => ({ name: r.name, kind: resourceKind(r), target: resourceTarget(r) })),
      appRecord: own.ok ? 'ok' : own.why,
      viewer: { name: req.headers['x-forwarded-preferred-username'] ?? null, email: req.headers['x-forwarded-email'] ?? null },
      idleMinutes: sup.idleMs / 60000,
    },
    cost: {
      apps: runnable.length,
      separateDbuPerHour: runnable.length * DBU_PER_HOUR.MEDIUM,
      catalogDbuPerHour: size ? DBU_PER_HOUR[size] ?? null : DBU_PER_HOUR.MEDIUM,
      assumption: 'each demo app on its own at the default MEDIUM size (0.5 DBU/h) vs this one app; framework starters excluded; DBU rates from docs.databricks.com compute-size',
    },
    events: sup.events.slice(-30),
    children,
  };
}

/* ───────────────────────── master routes ─────────────────────────────────── */

async function master(req, res, url) {
  const p = url.pathname;
  if (p === '/_catalog/shim.js') return serveFile(res, join(PUBLIC_DIR, 'shim.js'), { cache: 'public, max-age=86400, immutable', req }) || send(res, 404, 'no shim');
  if (p.startsWith('/_catalog/public/')) {
    const f = safeJoin(PUBLIC_DIR, p.slice('/_catalog/public/'.length));
    return (f && serveFile(res, f, { cache: 'public, max-age=3600', req })) || send(res, 404, 'not found');
  }
  if (p.startsWith('/_catalog/ui/')) {
    const f = safeJoin(UI_DIR, p.slice('/_catalog/ui/'.length));
    const immutable = /\/assets\//.test(p);
    return (f && serveFile(res, f, { cache: immutable ? 'public, max-age=31536000, immutable' : 'no-cache', req })) || send(res, 404, 'not found');
  }
  if (p === '/_catalog/api/health') {
    return json(res, 200, {
      ok: true, buildId: BUILD_ID, fingerprint: FINGERPRINT, startedAt: STARTED_AT, shim: SHIM_VERSION,
      children: sup.list().map((c) => ({ name: c.name, state: c.state, pid: c.proc?.pid ?? null, prepare: (c.prepare ?? readState(ROOT, c.name))?.status ?? null, problems: c.m.problems })),
      // What is actually on disk and running, so a removed child's leftovers are checkable.
      venvs: (() => { try { return readdirSync(catalogDirs(ROOT).venvs).sort(); } catch { return []; } })(),
      offline: isOffline(),
      wheelhouse: { source: env('WHEELHOUSE') || null, wheels: (() => { try { return readdirSync(wheelhouseDir(ROOT)).filter((n) => n.endsWith('.whl')).sort(); } catch { return []; } })() },
      processes: processList(),
    });
  }
  if (p === '/_catalog/api/catalog') return json(res, 200, await catalogModel(req));
  if (p === '/_catalog/api/me') return json(res, 200, { name: req.headers['x-forwarded-preferred-username'] ?? null, email: req.headers['x-forwarded-email'] ?? null, user: req.headers['x-forwarded-user'] ?? null, obo: !!req.headers['x-forwarded-access-token'] });
  const m = /^\/_catalog\/api\/children\/([^/]+)(?:\/(start|stop|restart|prepare|logs))?$/.exec(p);
  if (m) {
    const child = sup.get(decodeURIComponent(m[1]));
    if (!child) return json(res, 404, { error: `no child "${m[1]}"` });
    const action = m[2];
    if (!action) return json(res, 200, { name: child.name, title: child.m.title, status: child.status() });
    if (action === 'logs') {
      const tail = Math.min(Number(url.searchParams.get('tail')) || 400, 1500);
      let install = '';
      try { install = readFileSync(join(catalogDirs(ROOT).logs, `${child.name}.install.log`), 'utf8').split('\n').slice(-tail).join('\n'); } catch { install = '(no install log)'; }
      return json(res, 200, { runtime: redact(child.log.tail(tail)), install: redact(install) });
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'POST required' });
    await readBody(req);
    if (action === 'stop') { child.stop('stopped from the catalog'); return json(res, 200, { ok: true, status: child.status() }); }
    if (action === 'prepare') { child.prepare = null; child.ensurePrepared().catch(() => {}); return json(res, 202, { ok: true, status: child.status() }); }
    if (action === 'restart') { child.restarts += 1; child.stop('restart'); await new Promise((r) => setTimeout(r, 400)); }
    if (['failed', 'crashed', 'needs_build'].includes(child.state)) { child.state = 'stopped'; child.prepare = child.prepare?.status === 'ready' ? child.prepare : null; }
    child.start(action).catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    return json(res, 202, { ok: true, status: child.status() });
  }
  return json(res, 404, { error: 'unknown catalog route' });
}

function serveCatalogIndex(req, res) {
  const f = join(UI_DIR, 'index.html');
  if (existsSync(f)) return serveFile(res, f, { cache: 'no-cache', req });
  // UI not built yet: a plain list, so the catalog is never a blank page.
  const items = sup.list().map((c) => `<li><a href="/apps/${esc(c.name)}/">${esc(c.m.title)}</a> <span class="dim">${esc(c.m.frameworkLabel)} · ${esc(c.state)}</span></li>`).join('');
  return send(res, 200, `<!doctype html><html><head><meta charset="utf-8"><title>App-ception</title><style>${PAGE_CSS}</style></head><body><div class="card"><h1>App-ception</h1><ul>${items}</ul></div></body></html>`, 'text/html; charset=utf-8');
}

/* ───────────────────────── child routing ─────────────────────────────────── */

function onChildHtml(req, res, child, headers) {
  const c = `appception_child=${encodeURIComponent(child.name)}; Path=/; SameSite=Lax; HttpOnly`;
  headers['set-cookie'] = [].concat(headers['set-cookie'] ?? [], c);
  headers['cache-control'] = headers['cache-control'] ?? 'no-cache';
}

function onProxyError(req, res, child, err) {
  const msg = `catalog: ${child.name} is not answering (${err.code ?? err.message})`;
  child.log.push(`[catalog] proxy error ${err.code ?? err.message} for ${req.method} ${req.url}`);
  if (!child.proc && child.state === 'running') child.state = 'crashed';
  if (isNavigation(req)) return interstitial(res, child, { error: msg });
  json(res, 502, { error: msg, state: child.state });
}

const proxyCtx = { hosts: [], shimVersion: SHIM_VERSION, onHtml: onChildHtml, onError: onProxyError };

async function toChild(req, res, child, path) {
  proxyCtx.hosts = [...hostsSeen];
  if (child.state === 'running') return proxyHttp(req, res, child, path, proxyCtx);
  if (isNavigation(req)) {
    child.start('navigation').catch(() => {});
    return interstitial(res, child);
  }
  try {
    await child.start('request');
  } catch (e) {
    return json(res, 503, { error: `catalog: ${child.name} could not start: ${redact(e.message)}`, state: child.state });
  }
  return proxyHttp(req, res, child, path, proxyCtx);
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://catalog.local');
  const path = url.pathname;
  const fwd = req.headers['x-forwarded-host'];
  if (fwd) hostsSeen.add(String(fwd).toLowerCase());

  if (path === '/_catalog' || path.startsWith('/_catalog/')) return master(req, res, url);

  const m = /^\/apps\/([^/]+)(\/.*)?$/.exec(path);
  if (m) {
    const child = sup.get(decodeURIComponent(m[1]));
    if (!child) return notFoundPage(req, res, `There is no app called "${m[1]}" in this catalog.`);
    if (m[2] === undefined) { res.writeHead(302, { location: `/apps/${child.name}/${url.search}` }); return res.end(); }
    if (child.m.mount === 'root' && isTopLevel(req)) {
      // A root-mode app strips its prefix from the address bar, so it must live in
      // the viewer's frame: a reload of a top-level "/" would open the catalog.
      const rest = m[2] + url.search;
      res.writeHead(302, { location: `/?app=${encodeURIComponent(child.name)}${rest !== '/' ? `&path=${encodeURIComponent(rest)}` : ''}` });
      return res.end();
    }
    return toChild(req, res, child, m[2] + url.search);
  }

  const fromChild = childFromReferer(req) ?? (path !== '/' ? childFromCookie(req) : null);
  if (path === '/' || path === '/index.html') {
    if (!(req.headers['sec-fetch-dest'] === 'iframe' && fromChild)) return serveCatalogIndex(req, res);
  }
  if (!fromChild) {
    if (path === '/favicon.ico' || path === '/favicon.svg') return serveFile(res, join(PUBLIC_DIR, 'favicon.svg'), { cache: 'public, max-age=3600', req }) || send(res, 404, '');
    return notFoundPage(req, res, `${path} is not part of the catalog, and the request did not come from one of its apps.`);
  }
  if (isNavigation(req) && fromChild.m.mount === 'prefix' && (req.method === 'GET' || req.method === 'HEAD')) {
    res.writeHead(302, { location: fromChild.prefix + path + url.search });
    return res.end();
  }
  return toChild(req, res, fromChild, path + url.search);
}

/* ───────────────────────── server ────────────────────────────────────────── */

const server = createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error('[catalog] handler error', e);
    if (!res.headersSent) json(res, 500, { error: String(e?.message ?? e) });
    else res.destroy();
  });
});
server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;
server.requestTimeout = 0; // long-lived child responses (SSE, streaming) are allowed

server.on('upgrade', async (req, socket, head) => {
  try {
    const url = new URL(req.url, 'http://catalog.local');
    const m = /^\/apps\/([^/]+)(\/.*)?$/.exec(url.pathname);
    let child = null;
    let path = null;
    if (m) { child = sup.get(decodeURIComponent(m[1])); path = (m[2] ?? '/') + url.search; }
    else { child = childFromReferer(req) ?? childFromCookie(req); path = url.pathname + url.search; }
    if (!child) { socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n'); return; }
    if (child.state !== 'running') await child.start('websocket');
    proxyUpgrade(req, socket, head, child, path);
  } catch (e) {
    socket.end(`HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain\r\n\r\n${String(e?.message ?? e)}`);
  }
});

server.listen(PORT, () => {
  console.log(`[catalog] ${BUILD_ID} listening on ${PORT}; ${sup.list().length} children: ${sup.list().map((c) => `${c.name}(${c.m.framework},${c.m.mount}${c.m.ok ? '' : ',NOT OK'})`).join(' ')}`);
  for (const c of sup.list()) {
    for (const pr of c.m.problems) console.log(`[catalog] ${c.name} problem: ${pr}`);
    for (const w of c.m.warnings) console.log(`[catalog] ${c.name} warning: ${w}`);
  }
  sup.startTimers();
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`[catalog] ${sig}: stopping children`);
    sup.stopAll();
    setTimeout(() => process.exit(0), 2500).unref();
    server.close();
  });
}

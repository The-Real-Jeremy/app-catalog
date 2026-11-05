/**
 * Child discovery — turns each directory under child_apps/ into a manifest the
 * supervisor can run, WITHOUT any manifest file of our own being required.
 *
 * Everything is read from what the child's repo already contains, in the same
 * order of authority Databricks Apps itself uses:
 *
 *   app root      catalog.yaml app_dir  >  databricks.yml source_code_path  >
 *                 app.yaml / app.yml (shallowest)  >  the repo root
 *   command       app.yaml `command`  >  platform default (`npm run start` when
 *                 package.json exists, else `python <first .py>`)
 *   env           app.yaml `env` (value / valueFrom)  +  optional overrides
 *   scopes        app.yaml user_authorization.scopes  ∪  databricks.yml user_api_scopes
 *   resources     databricks.yml app resources  ∪  app.yaml resources
 *   title/blurb   catalog.yaml  >  databricks.yml description  >  README  >  package metadata
 *
 * Optional overrides live in two places, both optional: `catalog.yaml` inside the
 * child (metadata the app's author can ship), and `catalog.overrides.yaml` at the
 * master root (facts about THIS deployment, e.g. env for this workspace). The
 * master-level file wins.
 *
 * This module is imported by the server (runtime, in the container), by the
 * build step (`npm run build`, in the container) and by scripts/deploy.mjs (on a
 * laptop), so all three agree about what a child is.
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, relative, basename } from 'node:path';
import { createHash } from 'node:crypto';
import yaml from '../vendor/js-yaml/js-yaml.mjs';

/** Directories never searched for an app and never shipped. */
export const SKIP_DIRS = new Set([
  'node_modules', '.git', '.venv', 'venv', 'env', '__pycache__', '.databricks', '.catalog',
  '.catalog-deploy', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.idea', '.vscode', '.tanstack',
  '.reference',
]);

/** A child folder name is also its URL segment: /apps/<name>/. */
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** Client-side routers that read window.location.pathname and therefore cannot
 *  live under a path prefix unless the app passes a basename. Such apps are
 *  served in `root` mount mode (see shim.js). */
const SPA_ROUTERS = [
  '@tanstack/react-router', 'react-router', 'react-router-dom', 'vue-router', '@angular/router',
  'wouter', '@solidjs/router', 'svelte-spa-router', 'preact-router', '@reach/router', '@remix-run/react',
];

function readText(p) {
  try { return readFileSync(p, 'utf8'); } catch { return null; }
}
function readYaml(p, problems) {
  const t = readText(p);
  if (t == null) return null;
  try { return yaml.load(t) ?? {}; } catch (e) {
    problems?.push(`${basename(p)} is not valid YAML: ${String(e.message).split('\n')[0]}`);
    return null;
  }
}
function readJson(p, problems) {
  const t = readText(p);
  if (t == null) return null;
  try { return JSON.parse(t); } catch (e) {
    problems?.push(`${basename(p)} is not valid JSON: ${e.message}`);
    return null;
  }
}
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };

export function sha1(s) { return createHash('sha1').update(s).digest('hex'); }

/** Resolve `${var.x}` against a bundle's variable defaults (and its default
 *  target's overrides). Unknown variables are left in place, visibly. */
function bundleVars(bundle) {
  const vars = {};
  for (const [k, v] of Object.entries(bundle?.variables ?? {})) {
    if (v && typeof v === 'object' && 'default' in v) vars[k] = v.default;
    else if (typeof v !== 'object') vars[k] = v;
  }
  const targets = bundle?.targets ?? {};
  const def = Object.entries(targets).find(([, t]) => t && t.default) ?? Object.entries(targets)[0];
  for (const [k, v] of Object.entries(def?.[1]?.variables ?? {})) vars[k] = v;
  return vars;
}
function subst(value, vars) {
  if (typeof value === 'string') {
    return value.replace(/\$\{var\.([A-Za-z0-9_]+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  }
  if (Array.isArray(value)) return value.map((v) => subst(v, vars));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, subst(v, vars)]));
  }
  return value;
}

/** Breadth-first search for app.yaml/app.yml below `root`, shallowest first. */
function findAppYamls(root, maxDepth = 3) {
  const found = [];
  let frontier = [root];
  for (let depth = 0; depth <= maxDepth && frontier.length; depth += 1) {
    const next = [];
    for (const dir of frontier) {
      let entries = [];
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (e.isFile() && (e.name === 'app.yaml' || e.name === 'app.yml')) found.push({ dir, file: join(dir, e.name), depth });
        else if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) next.push(join(dir, e.name));
      }
    }
    if (found.length) break; // shallowest level only
    frontier = next;
  }
  return found;
}

function firstPy(dir) {
  let names = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith('.py') && isFile(join(dir, n))); } catch { return null; }
  if (!names.length) return null;
  for (const pref of ['app.py', 'main.py', 'server.py']) if (names.includes(pref)) return pref;
  return names.sort()[0];
}

/**
 * Frontend sub-projects of a Python app: `frontend/package.json` (or client/, ui/, web/ …)
 * with a `build` script, beside an app root that has NO package.json of its own. The
 * platform never builds these (it only runs npm at the app root), so a standalone deploy
 * needs the output committed. The catalog builds one in the container when its output is
 * MISSING, so a copied repo whose dist/ is git-ignored still works from a plain redeploy.
 * Output dir: vite `build.outDir` when it is a literal (or path.resolve(__dirname, '<lit>')),
 * `build` for create-react-app, else `dist`. "Built" = that dir holds an index.html.
 */
function findFrontends(appRoot) {
  const out = [];
  let entries = [];
  try { entries = readdirSync(appRoot, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
    const dir = join(appRoot, e.name);
    const p = readJson(join(dir, 'package.json'));
    if (!p?.scripts?.build) continue;
    const cfg = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.mts'].map((f) => readText(join(dir, f))).find((t) => t != null) ?? '';
    const lit = /outDir\s*:\s*['"`]([^'"`]+)['"`]/.exec(cfg)?.[1]
      ?? /outDir\s*:\s*(?:path\.)?resolve\(\s*__dirname\s*,\s*['"`]([^'"`]+)['"`]\s*\)/.exec(cfg)?.[1];
    const deps = { ...(p.dependencies ?? {}), ...(p.devDependencies ?? {}) };
    const outRel = lit ?? ('react-scripts' in deps ? 'build' : 'dist');
    const outAbs = resolve(dir, outRel);
    if (!outAbs.startsWith(appRoot)) continue; // builds outside the app root are not ours to run
    out.push({ dir: e.name, out: relative(appRoot, outAbs), built: isFile(join(outAbs, 'index.html')) });
  }
  return out;
}

/** Very small README reader: first H1 as the title, first prose paragraph as
 *  the description. Skips badges, images, HTML, admonitions and code. */
export function readmeSummary(text) {
  if (!text) return { title: null, description: null };
  const lines = text.replace(/\r/g, '').split('\n');
  let title = null;
  let description = null;
  let inCode = false;
  let para = [];
  const clean = (s) => s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')            // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')          // links -> text
    .replace(/<[^>]+>/g, '')                           // html
    .replace(/[*_`]{1,3}([^*_`]+)[*_`]{1,3}/g, '$1')   // emphasis / code
    .replace(/\s+/g, ' ')
    .trim();
  let items = null; // list items that complete a paragraph ending in ':'
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^\s*```/.test(line)) { inCode = !inCode; if (para.length) break; continue; }
    if (inCode) continue;
    if (!title) {
      const m = /^#\s+(.+?)\s*#*\s*$/.exec(line);
      if (m) { title = clean(m[1]); continue; }
    }
    if (items) {
      // "…does two things:" followed by a list — the list IS the description.
      const li = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
      if (li) { items.push(li[1].trim()); continue; }
      if (line.trim() && /^\s{2,}\S/.test(raw) && items.length) { items[items.length - 1] += ` ${line.trim()}`; continue; }
      if (!line.trim()) { if (items.length) break; continue; }
      break;
    }
    if (/^\s*(#{1,6}\s|>|\||<|!\[|---|\*\*\*|={3,}|-{3,})/.test(line) || /^\s*[-*+]\s|^\s*\d+\.\s/.test(line)) {
      if (para.length) break;
      continue;
    }
    if (!line.trim()) {
      if (para.length && /:$/.test(para[para.length - 1])) { items = []; continue; }
      if (para.length) break;
      continue;
    }
    // A "**Live:** https://…" style label line is metadata, not a description.
    if (!para.length && /^\s*\*\*[^*]{1,24}:\*\*/.test(line)) continue;
    para.push(line.trim());
  }
  if (para.length) {
    const lead = para.join(' ');
    description = clean(items?.length ? `${lead} ${items.map((t) => t.replace(/[;.,]\s*$/, '')).join('; ')}.` : lead);
  }
  if (description && description.length > 320) description = `${description.slice(0, 317).replace(/\s+\S*$/, '')}…`;
  // Emoji-only or decorative titles read badly on a card.
  if (title) title = title.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2728}]/gu, '').trim() || null;
  return { title, description };
}

function prettify(name) {
  return name.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Requirements -> package names (lowercased, extras and pins stripped). */
function reqNames(text) {
  if (!text) return [];
  return text.split('\n')
    .map((l) => l.replace(/#.*/, '').trim())
    .filter((l) => l && !l.startsWith('-'))
    .map((l) => l.split(/[<>=!~;\s[]/)[0].toLowerCase())
    .filter(Boolean);
}

function pyprojectDeps(text) {
  if (!text) return [];
  const m = /\bdependencies\s*=\s*\[([\s\S]*?)\]/.exec(text);
  if (!m) return [];
  return [...m[1].matchAll(/["']([A-Za-z0-9_.-]+)/g)].map((x) => x[1].toLowerCase());
}

/** What framework is this? Used for the badge AND for the base-path env vars. */
function detectFramework({ argv, pyDeps, nodeDeps, mainPySource, isApx }) {
  const words = argv.join(' ').toLowerCase();
  const has = (n) => pyDeps.includes(n);
  const imp = (re) => (mainPySource ? re.test(mainPySource) : false);
  if (/\bstreamlit\b/.test(words) || (imp(/^\s*import streamlit|^\s*from streamlit/m))) return 'streamlit';
  if (/\bgradio\b/.test(words) || imp(/^\s*import gradio|^\s*from gradio/m)) return 'gradio';
  if (/\bshiny\b/.test(words) || imp(/^\s*from shiny|^\s*import shiny/m)) return 'shiny';
  if (imp(/^\s*(from dash|import dash)\b/m) || (has('dash') && !/\buvicorn|gunicorn|flask\b/.test(words))) return 'dash';
  if (isApx) return 'apx';
  if (/\bflask\b/.test(words) || imp(/^\s*from flask\s+import\b/m)) return 'flask';
  if (/\buvicorn|fastapi\b/.test(words) || has('fastapi') || imp(/^\s*from fastapi\s+import\b/m)) return 'fastapi';
  if (/\bgunicorn\b/.test(words)) return has('flask') ? 'flask' : 'python';
  if (/^(node|npm|npx|pnpm|bun|yarn)\b/.test(argv[0] ?? '')) {
    if (nodeDeps.includes('next')) return 'nextjs';
    if (nodeDeps.includes('express')) return 'express';
    return 'node';
  }
  if (/^python3?$/.test(argv[0] ?? '')) return 'python';
  return 'unknown';
}

export const FRAMEWORK_LABELS = {
  streamlit: 'Streamlit', gradio: 'Gradio', shiny: 'Shiny', dash: 'Dash', flask: 'Flask', fastapi: 'FastAPI',
  apx: 'apx · FastAPI + React', python: 'Python', node: 'Node.js', express: 'Express', nextjs: 'Next.js', unknown: 'Unknown',
};

function normaliseEnv(list, where, problems) {
  // app.yaml `env` is a list of {name, value | valueFrom}; overrides may also use a map.
  const out = [];
  if (!list) return out;
  if (!Array.isArray(list) && typeof list === 'object') {
    for (const [name, value] of Object.entries(list)) out.push({ name, value: value == null ? '' : String(value), from: where });
    return out;
  }
  if (!Array.isArray(list)) { problems.push(`${where}: env must be a list`); return out; }
  for (const e of list) {
    if (!e || typeof e !== 'object' || !e.name) { problems.push(`${where}: an env entry has no name`); continue; }
    if ('valueFrom' in e) out.push({ name: String(e.name), valueFrom: String(e.valueFrom), from: where });
    else out.push({ name: String(e.name), value: e.value == null ? '' : String(e.value), from: where });
  }
  return out;
}

function normaliseResources(list, where) {
  if (!Array.isArray(list)) return [];
  return list.filter((r) => r && typeof r === 'object').map((r) => ({ ...r, _from: where }));
}

/** One child directory -> manifest. Never throws: problems are data. */
export function discoverChild(dir, masterOverrides = {}) {
  const name = basename(dir);
  const problems = [];
  const warnings = [];
  const childOverrides = readYaml(join(dir, 'catalog.yaml'), problems) ?? readYaml(join(dir, 'catalog.yml'), problems) ?? {};
  const ov = { ...childOverrides, ...(masterOverrides?.[name] ?? {}) };
  if (ov.env && childOverrides.env && masterOverrides?.[name]?.env) {
    // both levels set env: merge, master-level wins per variable
    ov.env = [...normaliseEnv(childOverrides.env, 'catalog.yaml', problems), ...normaliseEnv(masterOverrides[name].env, 'catalog.overrides.yaml', problems)];
  }

  if (!NAME_RE.test(name)) problems.push(`folder name "${name}" is not URL-safe (use lowercase letters, digits, _ or -)`);

  // ── databricks.yml (a DAB) ────────────────────────────────────────────────
  const bundleFile = ['databricks.yml', 'databricks.yaml'].map((f) => join(dir, f)).find(isFile) ?? null;
  const bundleRaw = bundleFile ? readYaml(bundleFile, problems) : null;
  const vars = bundleVars(bundleRaw);
  const bundle = bundleRaw ? subst(bundleRaw, vars) : null;
  const bundleApps = Object.entries(bundle?.resources?.apps ?? {});
  let bundleApp = null;
  if (bundleApps.length) {
    const pick = ov.bundle_app ? bundleApps.find(([k]) => k === ov.bundle_app) : bundleApps[0];
    if (!pick) problems.push(`catalog bundle_app "${ov.bundle_app}" is not in databricks.yml`);
    else {
      bundleApp = { key: pick[0], ...pick[1] };
      if (bundleApps.length > 1 && !ov.bundle_app) warnings.push(`databricks.yml defines ${bundleApps.length} apps; using "${pick[0]}" (set bundle_app in catalog.yaml to choose)`);
    }
  }
  const artifacts = Object.entries(bundle?.artifacts ?? {})
    .map(([k, a]) => ({ key: k, build: a?.build ?? null, path: a?.path ?? null }))
    .filter((a) => a.build);

  // ── app root ─────────────────────────────────────────────────────────────
  let appRoot = null;
  let appRootReason = null;
  let needsBuild = null;
  let artifactRoot = false; // the app root is produced by the bundle's own artifact build
  if (ov.app_dir) {
    appRoot = resolve(dir, ov.app_dir);
    appRootReason = 'catalog app_dir';
    if (!isDir(appRoot)) problems.push(`app_dir "${ov.app_dir}" does not exist`);
  } else if (bundleApp?.source_code_path) {
    const p = resolve(dir, bundleApp.source_code_path);
    artifactRoot = artifacts.length > 0 && p !== dir;
    if (isDir(p)) { appRoot = p; appRootReason = `databricks.yml source_code_path${artifactRoot ? ' (built by its artifact step)' : ''}`; }
    else if (artifacts.length) {
      needsBuild = { source_code_path: bundleApp.source_code_path, artifacts };
      appRoot = p;
      appRootReason = 'databricks.yml source_code_path (produced by its artifact build)';
    } else {
      warnings.push(`databricks.yml source_code_path "${bundleApp.source_code_path}" does not exist; falling back to app.yaml search`);
    }
  }
  if (!appRoot) {
    const hits = findAppYamls(dir);
    if (hits.length) {
      const sorted = hits.sort((a, b) => (basename(a.dir) === 'app' ? -1 : 0) - (basename(b.dir) === 'app' ? -1 : 0) || a.dir.localeCompare(b.dir));
      appRoot = sorted[0].dir;
      appRootReason = appRoot === dir ? 'app.yaml at repo root' : `app.yaml in ${relative(dir, appRoot)}/`;
      if (hits.length > 1) warnings.push(`several app.yaml files at the same depth; using ${relative(dir, sorted[0].file)} (set app_dir in catalog.yaml to choose)`);
    } else if (isFile(join(dir, 'package.json')) || firstPy(dir)) {
      appRoot = dir;
      appRootReason = 'repo root (no app.yaml; platform default command)';
    }
  }
  if (!appRoot) {
    problems.push('no app found: add an app.yaml (or a databricks.yml app, or an app.py / package.json) to this folder');
    appRoot = dir;
  }

  // ── app.yaml ─────────────────────────────────────────────────────────────
  const appYamlFile = needsBuild ? null : ['app.yaml', 'app.yml'].map((f) => join(appRoot, f)).find(isFile) ?? null;
  const appYaml = appYamlFile ? readYaml(appYamlFile, problems) ?? {} : {};

  // ── dependencies ─────────────────────────────────────────────────────────
  const pkgPath = join(appRoot, 'package.json');
  const pkg = isFile(pkgPath) ? readJson(pkgPath, problems) : null;
  const rootPkg = appRoot !== dir && isFile(join(dir, 'package.json')) ? readJson(join(dir, 'package.json'), problems) : null;
  const reqPath = join(appRoot, 'requirements.txt');
  const reqText = isFile(reqPath) ? readText(reqPath) : null;
  const pyprojPath = join(appRoot, 'pyproject.toml');
  const pyprojText = isFile(pyprojPath) ? readText(pyprojPath) : null;
  const rootPyproj = isFile(join(dir, 'pyproject.toml')) ? readText(join(dir, 'pyproject.toml')) : null;
  const uvLock = isFile(join(appRoot, 'uv.lock'));
  const python = reqText != null ? 'requirements' : (pyprojText && uvLock ? 'uv' : null);
  // A prebuilt SPA's router is declared where its source lives (frontend/, client/ …), which is
  // often OUTSIDE the app root (Lakemeter: app root backend/, router in frontend/package.json).
  const frontendPkgs = ['frontend', 'client', 'ui', 'web'].flatMap((d) => [join(dir, d, 'package.json'), join(appRoot, d, 'package.json')])
    .filter((p, i, a) => a.indexOf(p) === i && isFile(p)).map((p) => readJson(p));
  const nodeDeps = [pkg, rootPkg, ...frontendPkgs].flatMap((p) => Object.keys({ ...(p?.dependencies ?? {}), ...(p?.devDependencies ?? {}) }));
  const pyDeps = [...reqNames(reqText), ...pyprojectDeps(pyprojText), ...pyprojectDeps(rootPyproj)];
  const isApx = /\[tool\.apx/.test(rootPyproj ?? '') || /\[tool\.apx/.test(pyprojText ?? '');
  const frontends = needsBuild || pkg ? [] : findFrontends(appRoot);

  // ── command ──────────────────────────────────────────────────────────────
  let argv = null;
  let commandReason = null;
  if (Array.isArray(ov.command) && ov.command.length) { argv = ov.command.map(String); commandReason = 'catalog command'; }
  else if (Array.isArray(appYaml.command) && appYaml.command.length) { argv = appYaml.command.map(String); commandReason = `${basename(appYamlFile)} command`; }
  else if (typeof appYaml.command === 'string' && appYaml.command.trim()) {
    argv = appYaml.command.trim().split(/\s+/); commandReason = `${basename(appYamlFile)} command (string)`;
    warnings.push('app.yaml command is a string; the platform expects a list — split on spaces');
  } else if (pkg) {
    if (pkg.scripts?.start) { argv = ['npm', 'run', 'start']; commandReason = 'platform default for package.json'; }
    else if (!needsBuild) problems.push('package.json has no "start" script and app.yaml has no command');
  } else if (!needsBuild) {
    const py = firstPy(appRoot);
    if (py) { argv = ['python', py]; commandReason = 'platform default (python <first .py>)'; }
    else problems.push('no command: app.yaml has none and there is no .py file or package.json');
  }
  if (needsBuild && !argv) argv = [];

  // ── env, scopes, resources ───────────────────────────────────────────────
  // Later wins per variable: an override replaces the app.yaml entry of the same name.
  const envMap = new Map();
  for (const e of [...normaliseEnv(appYaml.env, basename(appYamlFile ?? 'app.yaml'), problems), ...normaliseEnv(ov.env, 'override', problems)]) envMap.set(e.name, e);
  const env = [...envMap.values()];
  const scopes = new Set();
  for (const s of appYaml?.user_authorization?.scopes ?? []) scopes.add(String(s));
  for (const s of bundleApp?.user_api_scopes ?? []) scopes.add(String(s));
  for (const s of ov.user_api_scopes ?? []) scopes.add(String(s));
  // An override list REPLACES what the child declares: the usual reason for one is that
  // the child's own config names another workspace's warehouse / endpoint / space.
  const resources = Array.isArray(ov.resources)
    ? normaliseResources(ov.resources, 'override')
    : [
      ...normaliseResources(bundleApp?.resources, 'databricks.yml'),
      ...normaliseResources(appYaml.resources, basename(appYamlFile ?? 'app.yaml')),
    ];

  // ── presentation ─────────────────────────────────────────────────────────
  const readmeFile = ['README.md', 'readme.md', 'README.MD', 'Readme.md'].map((f) => join(dir, f)).find(isFile)
    ?? ['README.md', 'readme.md'].map((f) => join(appRoot, f)).find(isFile) ?? null;
  const readme = readmeSummary(readmeFile ? readText(readmeFile) : null);
  const pyName = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(rootPyproj ?? pyprojText ?? '')?.[1] ?? null;
  const title = ov.title ?? readme.title ?? (pkg?.name && !/client|ui$/.test(pkg.name) ? pkg.name : null) ?? pyName ?? prettify(name);
  const description = ov.description ?? bundleApp?.description ?? readme.description ?? pkg?.description ?? null;
  const mainPy = argv?.[0] && /^python3?$/.test(argv[0]) && argv[1]?.endsWith('.py') ? readText(join(appRoot, argv[1])) : null;
  const framework = ov.framework ?? detectFramework({ argv: argv ?? [], pyDeps, nodeDeps, mainPySource: mainPy, isApx });
  const routers = nodeDeps.filter((d) => SPA_ROUTERS.includes(d));
  const mount = ov.mount === 'root' || ov.mount === 'prefix' ? ov.mount : (routers.length ? 'root' : 'prefix');
  const mountReason = ov.mount ? 'catalog mount' : (routers.length ? `client-side router (${routers.join(', ')}) reads the real URL` : 'default');
  const licenses = (() => {
    try { return readdirSync(dir).filter((n) => /^(licen[cs]e|notice|copying)(\.|$)/i.test(n)); } catch { return []; }
  })();

  // Fingerprint of everything that decides how the child is INSTALLED. A change
  // here means the prepared environment is stale.
  const installKey = sha1(JSON.stringify({
    req: reqText, pyproj: python === 'uv' ? pyprojText : null,
    lock: python === 'uv' ? readText(join(appRoot, 'uv.lock')) : null,
    pkg: pkg ? JSON.stringify({ d: pkg.dependencies, dd: pkg.devDependencies, b: pkg.scripts?.build }) : null,
    plock: readText(join(appRoot, 'package-lock.json')) ? sha1(readText(join(appRoot, 'package-lock.json'))) : null,
    fe: frontends.filter((f) => !f.built).map((f) => [f.dir, readText(join(appRoot, f.dir, 'package.json'))]),
  }));

  return {
    name, dir, appRoot, appRootReason, artifactRoot, relAppRoot: relative(dir, appRoot) || '.',
    artifacts: artifactRoot ? { source_code_path: bundleApp.source_code_path, artifacts } : null,
    ok: problems.length === 0 && !needsBuild,
    problems, warnings, needsBuild,
    command: argv ?? [], commandReason,
    env, scopes: [...scopes].sort(), resources,
    deps: {
      python, requirements: reqText != null, pyproject: !!pyprojText, uvLock,
      node: !!pkg, nodeBuild: !!pkg?.scripts?.build, pnpm: isFile(join(appRoot, 'pnpm-lock.yaml')),
      frontends,
      pyDeps: [...new Set(pyDeps)].sort(),
    },
    framework, frameworkLabel: FRAMEWORK_LABELS[framework] ?? framework,
    mount, mountReason,
    title, description,
    icon: ov.icon ?? null,
    accent: ov.accent ?? null,
    category: ov.category ?? 'demo',
    order: Number.isFinite(ov.order) ? ov.order : null,
    hidden: ov.hidden === true,
    keepWarm: ov.keep_warm === true,
    vendorNodeModules: ov.vendor_node_modules === true,
    idleMinutes: Number.isFinite(ov.idle_minutes) ? ov.idle_minutes : null,
    source: ov.source ?? null,
    licenses,
    bundle: bundleApp ? { key: bundleApp.key, file: basename(bundleFile) } : null,
    installKey,
  };
}

/** All children, sorted for display. `root` is the master app root. */
export function discoverAll(root) {
  const childDir = join(root, 'child_apps');
  const overridesFile = join(root, 'catalog.overrides.yaml');
  const problems = [];
  const masterOverrides = isFile(overridesFile) ? (readYaml(overridesFile, problems) ?? {}) : {};
  let names = [];
  try {
    names = readdirSync(childDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'))
      .map((e) => e.name);
  } catch { /* no child_apps dir */ }
  const children = names.map((n) => discoverChild(join(childDir, n), masterOverrides));
  children.sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || a.title.localeCompare(b.title));
  return { children, problems, overridesFile: isFile(overridesFile) ? overridesFile : null };
}

/** Self-test from the command line: node catalog/lib/discover.mjs [root] */
if (import.meta.url === `file://${process.argv[1]}`) {
  const root = resolve(process.argv[2] ?? '.');
  const { children, problems } = discoverAll(root);
  if (problems.length) console.log('overrides problems:', problems);
  for (const c of children) {
    console.log(`\n■ ${c.name}  [${c.frameworkLabel}]  mount=${c.mount}  ok=${c.ok}`);
    console.log(`  title: ${c.title}`);
    console.log(`  blurb: ${c.description}`);
    console.log(`  root:  ${c.relAppRoot}  (${c.appRootReason})`);
    console.log(`  cmd:   ${JSON.stringify(c.command)}  (${c.commandReason})`);
    console.log(`  deps:  python=${c.deps.python} node=${c.deps.node} build=${c.deps.nodeBuild}`);
    console.log(`  env:   ${c.env.map((e) => e.name + (e.valueFrom ? `<-${e.valueFrom}` : '')).join(', ')}`);
    console.log(`  scopes:${JSON.stringify(c.scopes)}  resources: ${c.resources.map((r) => r.name).join(', ')}`);
    if (c.deps.frontends.length) console.log(`  frontends: ${JSON.stringify(c.deps.frontends)}`);
    if (c.needsBuild) console.log(`  NEEDS BUILD: ${JSON.stringify(c.needsBuild)}`);
    if (c.problems.length) console.log(`  PROBLEMS: ${c.problems.join(' | ')}`);
    if (c.warnings.length) console.log(`  warnings: ${c.warnings.join(' | ')}`);
    console.log(`  licenses: ${c.licenses.join(', ') || '(none)'}  mountReason: ${c.mountReason}`);
  }
}

/**
 * Prepare a child's dependencies the way Databricks Apps would for a standalone
 * deploy, but into an ISOLATED environment per child so two children can pin
 * conflicting versions.
 *
 * Platform order (docs: "Deployment logic"), mirrored per child, inside the
 * child's app root:
 *   1. package.json      -> npm install   (pnpm install --frozen-lockfile if pnpm-lock.yaml)
 *   2. requirements.txt  -> pip install -r requirements.txt
 *      else pyproject.toml + uv.lock -> uv sync
 *   3. package.json build script -> npm run build
 *
 * Python isolation, measured on the platform (2026-10-14):
 * the pre-installed libraries (streamlit 1.38, gradio 4.44, dash 2.18, flask,
 * fastapi, databricks-sdk 0.33, pandas …) live in the PLATFORM venv at
 * <source_code>/.venv. A child with a requirements.txt gets its own venv whose
 * site-packages comes FIRST, and a .pth file appends the platform's
 * site-packages AFTER it — so "versions in your file override the defaults"
 * (the documented rule) holds per child, and a child that relies on a
 * pre-installed package without listing it still finds it. Console scripts the
 * child did not install (e.g. `streamlit` when streamlit is pre-installed) are
 * re-pointed at the child's interpreter, or they would run under the platform
 * venv and miss the child's own packages.
 *
 * A child with no Python manifest uses the platform venv directly — exactly what
 * it would get standalone.
 *
 * Never throws for a child's failure: the result is data, written to
 * .catalog/state/<name>.json, and the master keeps serving the others.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync, createWriteStream } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { isOffline, offlineEnv, findLinks, syncWheelhouse, filterRequirements, requirementsSelfContained } from './offline.mjs';

export function catalogDirs(root) {
  const base = process.env.CATALOG_STATE_DIR ? resolve(process.env.CATALOG_STATE_DIR) : join(root, '.catalog');
  const d = { base, state: join(base, 'state'), venvs: join(base, 'venvs'), logs: join(base, 'logs') };
  for (const p of Object.values(d)) mkdirSync(p, { recursive: true });
  return d;
}

/** The interpreter whose site-packages holds the pre-installed libraries.
 *  On the platform that is <root>/.venv; locally CATALOG_PLATFORM_PYTHON can
 *  point at an emulation venv (scripts/dev-platform-venv.sh). */
export function platformPython(root) {
  const candidates = [
    process.env.CATALOG_PLATFORM_PYTHON,
    join(root, '.venv', 'bin', 'python'),
    join(root, '.catalog', 'platform-venv', 'bin', 'python'),
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return resolve(c);
  return null;
}

function which(bin, pathEnv) {
  for (const d of (pathEnv ?? process.env.PATH ?? '').split(':')) {
    if (!d) continue;
    const p = resolve(d, bin);
    try { if (statSync(p).isFile()) return p; } catch { /* next */ }
  }
  return null;
}

/** PATH with every relative entry made absolute against `base`. The platform's
 *  runtime PATH contains `.venv/bin` and `node_modules/.bin` RELATIVELY, which
 *  would silently resolve against the CHILD's working directory. */
export function absolutePath(pathEnv, base) {
  return (pathEnv ?? '').split(':').filter(Boolean).map((p) => (p.startsWith('/') ? p : resolve(base, p)));
}

/** Run a command, streaming to a log file, with a hard timeout. */
export function run(cmd, args, { cwd, env, log, timeoutMs = 10 * 60 * 1000, label } = {}) {
  return new Promise((resolvePromise) => {
    const t0 = Date.now();
    log?.write(`\n$ ${[cmd, ...args].join(' ')}   (cwd ${cwd})\n`);
    let child;
    try {
      child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (e) {
      log?.write(`spawn failed: ${e}\n`);
      return resolvePromise({ ok: false, code: null, error: String(e), ms: 0, label });
    }
    let tail = '';
    const onData = (b) => { log?.write(b); tail = (tail + b.toString()).slice(-4000); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => {
      log?.write(`\n[catalog] timed out after ${Math.round(timeoutMs / 1000)}s — killing\n`);
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
    }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolvePromise({ ok: false, code: null, error: String(e), ms: Date.now() - t0, tail, label }); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ ok: code === 0, code, signal, ms: Date.now() - t0, tail, label });
    });
  });
}

function sitePackages(venv) {
  const lib = join(venv, 'lib');
  try {
    const py = readdirSync(lib).find((n) => /^python3\.\d+$/.test(n));
    return py ? join(lib, py, 'site-packages') : null;
  } catch { return null; }
}

/** Re-point console scripts from the platform venv at the child's venv. */
function linkPlatformScripts(platformVenv, childVenv) {
  const from = join(platformVenv, 'bin');
  const to = join(childVenv, 'bin');
  const childPy = join(to, 'python');
  let made = 0;
  let names = [];
  try { names = readdirSync(from); } catch { return 0; }
  for (const n of names) {
    // whole names only: a prefix match on `uv` silently skipped `uvicorn`
    if (/^(python[0-9.]*|pip[0-9.]*|activate.*|deactivate.*|uv|uvx|pydoc.*)$/.test(n)) continue;
    const dst = join(to, n);
    if (existsSync(dst)) continue;
    let text;
    try {
      const st = statSync(join(from, n));
      if (!st.isFile() || st.size > 64 * 1024) continue;
      text = readFileSync(join(from, n), 'utf8');
    } catch { continue; }
    const first = text.split('\n', 1)[0];
    if (!first.startsWith('#!') || !/python/.test(first)) continue;
    writeFileSync(dst, `#!${childPy}\n${text.slice(first.length + 1)}`, { mode: 0o755 });
    made += 1;
  }
  return made;
}

/** npm ci when there is a lockfile (installs exactly it), else npm install. */
function npmInstallArgs(cwd) {
  return existsSync(join(cwd, 'package-lock.json'))
    ? ['npm ci', ['ci', '--include=dev', '--no-audit', '--no-fund', '--loglevel=error']]
    : ['npm install', ['install', '--include=dev', '--no-package-lock', '--no-audit', '--no-fund', '--loglevel=error']];
}

/**
 * Prepare one child. `manifest` comes from discover.mjs.
 * Returns the state object (also written to .catalog/state/<name>.json).
 */
export async function prepareChild(manifest, { root, force = false, onStep } = {}) {
  const dirs = catalogDirs(root);
  const stateFile = join(dirs.state, `${manifest.name}.json`);
  const prev = (() => { try { return JSON.parse(readFileSync(stateFile, 'utf8')); } catch { return null; } })();
  if (!force && prev?.status === 'ready' && prev.installKey === manifest.installKey && !!prev.offline === isOffline() && (!prev.venv || existsSync(prev.venv))) {
    return { ...prev, cached: true };
  }
  const logPath = join(dirs.logs, `${manifest.name}.install.log`);
  const log = createWriteStream(logPath, { flags: 'w' });
  const t0 = Date.now();
  const steps = [];
  const state = {
    name: manifest.name, installKey: manifest.installKey, status: 'preparing', startedAt: new Date(t0).toISOString(),
    venv: null, python: null, steps, log: logPath,
  };
  const save = () => { try { writeFileSync(stateFile, JSON.stringify(state, null, 2)); } catch { /* ignore */ } };
  const step = async (label, cmd, args, opts) => {
    onStep?.(label);
    state.current = label; save();
    const r = await run(cmd, args, { log, label, ...opts });
    steps.push({ label, ok: r.ok, code: r.code, signal: r.signal ?? null, ms: r.ms, tail: r.ok ? undefined : r.tail?.slice(-1500) });
    return r;
  };
  const finish = (status, error) => {
    state.status = status;
    state.error = error ?? null;
    state.finishedAt = new Date().toISOString();
    state.ms = Date.now() - t0;
    delete state.current;
    save();
    log.end();
    return state;
  };

  log.write(`[catalog] preparing ${manifest.name} (${manifest.relAppRoot}) at ${state.startedAt}\n`);
  if (manifest.needsBuild) {
    return finish('needs_build', `its databricks.yml builds ${manifest.needsBuild.source_code_path} with "${manifest.needsBuild.artifacts.map((a) => a.build).join(' && ')}" — run scripts/deploy.mjs (it runs that build) or commit the built output`);
  }
  if (!existsSync(manifest.appRoot)) return finish('failed', `app root ${manifest.relAppRoot} does not exist`);

  const cwd = manifest.appRoot;
  const basePath = absolutePath(process.env.PATH, root);
  const env = {
    ...process.env,
    PATH: [join(cwd, 'node_modules', '.bin'), ...basePath].join(':'),
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    PYTHONUNBUFFERED: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    ...offlineEnv(),
  };
  for (const k of Object.keys(env)) if (k.startsWith('npm_lifecycle') || k === 'npm_package_json' || k === 'INIT_CWD') delete env[k];
  const offline = isOffline();
  state.offline = offline;
  if (offline) log.write('[catalog] CATALOG_OFFLINE=1: no package index or registry will be contacted\n');

  // 1. Node dependencies
  if (manifest.deps.node) {
    const pkgJson = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    const wants = Object.keys({ ...(pkgJson.dependencies ?? {}), ...(pkgJson.devDependencies ?? {}) });
    if (offline && existsSync(join(cwd, 'node_modules'))) {
      log.write(`[catalog] offline: using the node_modules/ shipped with the app (${readdirSync(join(cwd, 'node_modules')).length} entries)\n`);
    } else if (offline && wants.length) {
      return finish('failed', `offline: package.json needs ${wants.length} package(s) (${wants.slice(0, 5).join(', ')}${wants.length > 5 ? ', …' : ''}) and there is no npm registry here — ship node_modules/ (installed on linux x64) with the app, or bundle the server into one file`);
    } else if (wants.length || !offline) {
      // A lockfile: install exactly it, and never rewrite it (the child's copy stays byte-identical).
      const [label, npmArgs] = npmInstallArgs(cwd);
      const r = manifest.deps.pnpm
        ? await step('npm: pnpm install --frozen-lockfile', 'corepack', ['pnpm', 'install', '--frozen-lockfile'], { cwd, env })
        : await step(label, 'npm', npmArgs, { cwd, env });
      if (!r.ok) return finish('failed', `npm install failed (exit ${r.code})`);
    }
  }

  // 2. Python dependencies
  const platPy = platformPython(root);
  const platVenv = platPy ? dirname(dirname(platPy)) : null;
  state.platformVenv = platVenv;
  if (manifest.deps.python) {
    const venv = join(dirs.venvs, manifest.name);
    if (existsSync(venv)) rmSync(venv, { recursive: true, force: true });
    const uv = which('uv', env.PATH);
    const basePy = platPy ?? which('python3', env.PATH) ?? 'python3';
    let r = uv
      ? await step('create venv (uv)', uv, ['venv', '--quiet', '--python', basePy, venv], { cwd, env })
      : await step('create venv', basePy, ['-m', 'venv', venv], { cwd, env });
    if (!r.ok) return finish('failed', 'could not create a virtualenv');
    const sp = sitePackages(venv);
    const platSp = platVenv ? sitePackages(platVenv) : null;
    if (sp && platSp) writeFileSync(join(sp, 'zz_catalog_platform.pth'), `${platSp}\n`);
    state.venv = venv;
    state.python = join(venv, 'bin', 'python');
    const venvEnv = { ...env, VIRTUAL_ENV: venv, PATH: [join(venv, 'bin'), env.PATH].join(':') };
    // Vendored wheels: the child's own wheels/ and the shared volume wheelhouse (offline.mjs).
    const wh = await syncWheelhouse(root, log);
    if (offline && !wh.ok) log.write(`[catalog] WARNING: ${wh.summary}\n`);
    const links = findLinks(cwd, root);
    const linkArgs = links.flatMap((d) => ['--find-links', d]);
    state.findLinks = links;
    if (manifest.deps.python === 'requirements') {
      let reqFile = 'requirements.txt';
      if (offline && platPy) {
        // Under --no-index a line the platform already satisfies could never install: drop it.
        const filtered = join(dirs.state, `${manifest.name}.offline-requirements.txt`);
        const f = filterRequirements(platPy, join(cwd, 'requirements.txt'), filtered);
        if (f.ok) {
          reqFile = filtered;
          state.satisfiedByPlatform = f.satisfied;
          log.write(`[catalog] offline: ${f.satisfied.length} requirement(s) satisfied by the pre-installed libraries (${f.satisfied.join(', ') || 'none'}); ${f.kept.length} to install from vendored wheels (${f.kept.join(', ') || 'none'})\n`);
        } else log.write(`[catalog] offline: could not filter requirements against the platform (${f.error}); installing all of them\n`);
      }
      const noIndex = offline ? ['--no-index'] : [];
      const pending = readFileSync(resolve(cwd, reqFile), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith('-'));
      if (offline && pending.length && !links.length && !requirementsSelfContained(join(cwd, 'requirements.txt'))) {
        return finish('failed', `offline: needs ${pending.slice(0, 6).join(', ')}${pending.length > 6 ? ', …' : ''}, which the platform does not pre-install, and there are no wheels to install them from — put linux x86_64 / CPython 3.11 wheels in the app's wheels/ folder or in the shared wheelhouse volume (CATALOG_WHEELHOUSE)`);
      }
      const nothingLeft = !pending.length && !requirementsSelfContained(join(cwd, 'requirements.txt'));
      if (nothingLeft) log.write('[catalog] nothing left to install: every requirement is pre-installed\n');
      r = nothingLeft ? { ok: true } : uv
        ? await step(`pip install -r requirements.txt (uv${offline ? ', offline' : ''})`, uv, ['pip', 'install', '--python', state.python, ...noIndex, ...linkArgs, '-r', reqFile], { cwd, env: venvEnv })
        : await step('pip install -r requirements.txt', state.python, ['-m', 'pip', 'install', ...noIndex, ...linkArgs, '-r', reqFile], { cwd, env: venvEnv });
      if (!r.ok && uv) {
        // uv is stricter than pip about some legacy requirement files; fall back the way the platform would install.
        log.write('\n[catalog] uv failed — retrying with pip, which is what the platform itself runs\n');
        await step('ensure pip', state.python, ['-m', 'ensurepip', '--upgrade'], { cwd, env: venvEnv });
        r = await step('pip install -r requirements.txt (pip)', state.python, ['-m', 'pip', 'install', ...noIndex, ...linkArgs, '-r', reqFile], { cwd, env: venvEnv });
      }
      if (!r.ok) return finish('failed', offline ? 'offline pip install failed — a wheel is missing or built for the wrong platform/Python (the Apps runtime is linux x86_64, CPython 3.11); the install log names it' : 'pip install -r requirements.txt failed');
    } else if (manifest.deps.python === 'uv') {
      r = await step('uv sync', uv ?? 'uv', ['sync', '--frozen', '--no-dev', ...(offline ? ['--offline'] : []), ...linkArgs], { cwd, env: { ...venvEnv, UV_PROJECT_ENVIRONMENT: venv } });
      if (!r.ok) return finish('failed', offline ? 'offline uv sync failed — every locked package needs a wheel in wheels/ or the wheelhouse volume' : 'uv sync failed');
    }
    if (platVenv) state.linkedScripts = linkPlatformScripts(platVenv, venv);
  } else if (platPy) {
    state.python = platPy;
  }

  // 3. Node build script
  if (manifest.deps.node && manifest.deps.nodeBuild) {
    const r = await step('npm run build', 'npm', ['run', 'build'], { cwd, env: state.venv ? { ...env, PATH: [join(state.venv, 'bin'), env.PATH].join(':') } : env });
    if (!r.ok) return finish('failed', `npm run build failed (exit ${r.code})`);
  }

  // 4. A Python app's frontend sub-project whose build output is missing (discover.mjs
  //    findFrontends) — built here so a copied repo with a git-ignored dist/ still works.
  for (const fe of manifest.deps.frontends ?? []) {
    if (fe.built) continue;
    if (offline) return finish('failed', `offline: ${fe.dir}/ has no built output (${fe.out}/index.html) and there is no npm registry to build it — build it on a connected machine and ship ${fe.out}/ with the app`);
    const feDir = join(cwd, fe.dir);
    const feEnv = { ...env, PATH: [join(feDir, 'node_modules', '.bin'), env.PATH].join(':') };
    const [label, npmArgs] = npmInstallArgs(feDir);
    let r = await step(`${fe.dir}: ${label}`, 'npm', npmArgs, { cwd: feDir, env: feEnv });
    // Usual cause in the container: a lockfile written on a laptop resolves to a registry the
    // container cannot reach (a private registry or a local mirror). Build on the laptop.
    if (!r.ok) return finish('failed', `${fe.dir}/ has no built output (${fe.out}/) and its ${label} failed (exit ${r.code}) — build it locally and copy ${fe.out}/ in too (a laptop lockfile often points at a registry the container cannot reach)`);
    r = await step(`${fe.dir}: npm run build`, 'npm', ['run', 'build'], { cwd: feDir, env: feEnv });
    if (!r.ok) return finish('failed', `${fe.dir}/ has no built output (${fe.out}/) and its npm run build failed (exit ${r.code}) — commit ${fe.out}/ or fix the build`);
    if (!existsSync(join(cwd, fe.out, 'index.html'))) return finish('failed', `${fe.dir}: npm run build finished but ${fe.out}/index.html was not produced`);
    // node_modules of a build-only frontend is dead weight at runtime
    rmSync(join(feDir, 'node_modules'), { recursive: true, force: true });
  }
  return finish('ready');
}

export function readState(root, name) {
  try { return JSON.parse(readFileSync(join(catalogDirs(root).state, `${name}.json`), 'utf8')); } catch { return null; }
}

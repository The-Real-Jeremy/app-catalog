/**
 * Supervisor — runs each child as a subprocess on its own localhost port.
 *
 *   lazy start     a child starts on its first request (or a Start click)
 *   idle stop      a child with no traffic and no open sockets for
 *                  APPCEPTION_IDLE_MINUTES (default 30) is stopped to free memory
 *   memory guard   above APPCEPTION_MEMORY_HIGH_PCT of the container's limit the
 *                  least-recently-used idle child is stopped
 *   keep warm      catalog.yaml `keep_warm: true` children start at boot and are
 *                  never idle-stopped
 *
 * The child is given the environment Databricks Apps would give it standalone —
 * the same DATABRICKS_* identity (the MASTER's service principal), the platform's
 * framework port/host variables pointed at ITS port, its own app.yaml env — plus
 * the base-path hints frameworks need to work under /apps/<name>/.
 */
import { spawn } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { readFileSync, readdirSync, existsSync, createWriteStream, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { prepareChild, readState, catalogDirs, absolutePath, platformPython } from './prepare.mjs';
import { env } from './env.mjs';

const PLATFORM_PORT = '8000';
const PORT_FLAGS = new Set(['--port', '-p', '--server.port', '--server-port', '--http-port', '--listen-port']);
const BIND_FLAGS = new Set(['--bind', '-b', '--host-port']);

/** Rewrite a child's command so it listens on `port` instead of the platform's.
 *  The platform substitutes DATABRICKS_APP_PORT in the command; a literal 8000
 *  only works standalone because the platform port IS 8000, and under the master
 *  8000 is taken by the master itself. */
export function rewriteCommand(argv, port) {
  const p = String(port);
  // $VAR, ${VAR} and the shell default form ${VAR:-8000} (Lakemeter's app.yaml) — a pattern
  // without the default form left ":-8000}" behind and the port became "49339:-8000}".
  const out = argv.map((a) => String(a).replace(/\$\{DATABRICKS_APP_PORT(?::?[-=][^}]*)?\}|\$DATABRICKS_APP_PORT\b/g, p));
  const notes = [];
  for (let i = 0; i < out.length; i += 1) {
    const a = out[i];
    if (PORT_FLAGS.has(a) && out[i + 1] === PLATFORM_PORT) { out[i + 1] = p; notes.push(`${a} ${PLATFORM_PORT} -> ${p}`); continue; }
    if (BIND_FLAGS.has(a) && /(^|:)8000$/.test(out[i + 1] ?? '')) { out[i + 1] = out[i + 1].replace(/8000$/, p); notes.push(`${a} -> ${out[i + 1]}`); continue; }
    const eq = /^(--port|--server\.port|--bind|-b)=(.*)$/.exec(a);
    if (eq && /(^|:)8000$/.test(eq[2])) { out[i] = `${eq[1]}=${eq[2].replace(/8000$/, p)}`; notes.push(`${a} -> ${out[i]}`); }
  }
  return { argv: out, notes };
}

/** Ask the OS for a free localhost port. */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function tryConnect(host, port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const sock = createConnection({ host, port });
    const done = (ok) => { sock.removeAllListeners(); sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

/** Container memory, cgroup v1 or v2. Returns bytes or null. */
export function containerMemory() {
  const read = (p) => { try { return readFileSync(p, 'utf8').trim(); } catch { return null; } };
  const num = (s) => (s && /^\d+$/.test(s) ? Number(s) : null);
  let limit = num(read('/sys/fs/cgroup/memory.max')) ?? num(read('/sys/fs/cgroup/memory/memory.limit_in_bytes'));
  let usage = num(read('/sys/fs/cgroup/memory.current')) ?? num(read('/sys/fs/cgroup/memory/memory.usage_in_bytes'));
  // page cache counts toward usage but is reclaimable; prefer working set when available
  const stat = read('/sys/fs/cgroup/memory/memory.stat') ?? read('/sys/fs/cgroup/memory.stat');
  if (usage != null && stat) {
    const m = /(?:^|\n)(?:total_inactive_file|inactive_file) (\d+)/.exec(stat);
    if (m) usage = Math.max(0, usage - Number(m[1]));
  }
  if (limit && limit > 1e15) limit = null; // "unlimited"
  const cpuQuota = num(read('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'));
  const cpuPeriod = num(read('/sys/fs/cgroup/cpu/cpu.cfs_period_us'));
  const cpuMax = read('/sys/fs/cgroup/cpu.max');
  let cpus = null;
  if (cpuQuota && cpuPeriod && cpuQuota > 0) cpus = cpuQuota / cpuPeriod;
  else if (cpuMax && /^\d+ \d+$/.test(cpuMax)) { const [q, per] = cpuMax.split(' ').map(Number); cpus = q / per; }
  return { limit, usage, cpus };
}

/** RSS of a process tree in bytes (Linux /proc). Null where /proc is absent. */
export function treeRss(rootPid) {
  if (!existsSync('/proc')) return null;
  const parents = new Map();
  const rss = new Map();
  let pids = [];
  try { pids = readdirSync('/proc').filter((n) => /^\d+$/.test(n)); } catch { return null; }
  for (const pid of pids) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      parents.set(Number(pid), Number(after[1]));
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      const m = /VmRSS:\s+(\d+) kB/.exec(status);
      rss.set(Number(pid), m ? Number(m[1]) * 1024 : 0);
    } catch { /* process exited */ }
  }
  let total = 0;
  let count = 0;
  const want = new Set([rootPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, ppid] of parents) if (!want.has(pid) && want.has(ppid)) { want.add(pid); grew = true; }
  }
  for (const pid of want) if (rss.has(pid)) { total += rss.get(pid); count += 1; }
  return { bytes: total, processes: count };
}

class RingLog {
  constructor(file, max = 1500) { this.lines = []; this.max = max; this.file = file; this.stream = file ? createWriteStream(file, { flags: 'a' }) : null; this.partial = ''; }
  write(chunk, tag = '') {
    const text = this.partial + chunk.toString();
    const parts = text.split('\n');
    this.partial = parts.pop();
    for (const p of parts) this.push(tag + p);
    if (this.partial.length > 4000) { this.push(tag + this.partial); this.partial = ''; }
  }
  push(line) {
    const stamped = `${new Date().toISOString().slice(11, 19)} ${line}`;
    this.lines.push(stamped);
    if (this.lines.length > this.max) this.lines.splice(0, this.lines.length - this.max);
    this.stream?.write(`${stamped}\n`);
  }
  tail(n = 300) { return this.lines.slice(-n).join('\n'); }
}

/** Redact anything that looks like a credential before it reaches a browser. */
export function redact(text) {
  return String(text)
    .replace(/\b(dapi|dkea|dose|doa)[0-9a-f]{20,}\b/gi, '$1…[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, '[redacted-jwt]')
    .replace(/((?:secret|token|password|passwd|authorization)["'\s:=]+)([^\s"',;]{8,})/gi, '$1[redacted]');
}

export class Child {
  constructor(manifest, sup) {
    this.m = manifest;
    this.sup = sup;
    this.state = 'stopped';
    this.port = null;
    this.host = '127.0.0.1';
    this.proc = null;
    this.startedAt = null;
    this.readyAt = null;
    this.lastActivity = 0;
    this.active = 0;      // in-flight HTTP requests
    this.sockets = 0;     // open websockets / long-lived streams
    this.restarts = 0;
    this.lastExit = null;
    this.lastError = null;
    this.startMs = null;
    this.prepare = readState(sup.root, manifest.name);
    // Say what is wrong BEFORE anyone clicks: a child that cannot run must not
    // look like one that is merely asleep.
    if (manifest.needsBuild) { this.state = 'needs_build'; this.lastError = 'its databricks.yml builds the app first; scripts/deploy.mjs runs that build'; }
    else if (!manifest.ok) { this.state = 'failed'; this.lastError = manifest.problems.join('; '); }
    else if (this.prepare && this.prepare.installKey === manifest.installKey && ['failed', 'needs_build'].includes(this.prepare.status)) {
      this.state = this.prepare.status; this.lastError = this.prepare.error;
    }
    this.log = new RingLog(join(catalogDirs(sup.root).logs, `${manifest.name}.log`));
    this.starting = null;
    this.preparing = null;
    this.phase = null;
    this.rewriteNotes = [];
    this.resolvedEnv = [];
    this.unresolved = [];
  }

  get name() { return this.m.name; }
  get prefix() { return `/apps/${this.m.name}`; }
  touch() { this.lastActivity = Date.now(); }

  async ensurePrepared() {
    const st = this.prepare;
    if (st?.status === 'ready' && st.installKey === this.m.installKey) return st;
    if (!this.preparing) {
      this.state = 'preparing';
      this.phase = 'installing dependencies';
      this.log.push('[catalog] preparing dependencies…');
      this.preparing = prepareChild(this.m, { root: this.sup.root, onStep: (s) => { this.phase = s; this.log.push(`[catalog] ${s}`); } })
        .then((r) => { this.prepare = r; return r; })
        .finally(() => { this.preparing = null; });
    }
    return this.preparing;
  }

  async buildEnv() {
    const base = { ...process.env };
    for (const k of Object.keys(base)) {
      if (k.startsWith('npm_') || k.startsWith('CATALOG_') || ['INIT_CWD', 'PWD', 'OLDPWD', 'NODE'].includes(k)) delete base[k];
    }
    const p = String(this.port);
    const host = '127.0.0.1';
    const root = this.sup.root;
    const pathParts = absolutePath(process.env.PATH, root);
    const venvBin = this.prepare?.venv ? join(this.prepare.venv, 'bin') : null;
    const platPy = platformPython(root);
    const platBin = platPy ? dirname(platPy) : null;
    const front = [venvBin, platBin, join(this.m.appRoot, 'node_modules', '.bin')].filter(Boolean);
    const env = {
      ...base,
      PATH: [...front, ...pathParts.filter((x) => !front.includes(x))].join(':'),
      DATABRICKS_APP_PORT: p, PORT: p,
      UVICORN_PORT: p, UVICORN_HOST: host,
      STREAMLIT_SERVER_PORT: p, STREAMLIT_SERVER_ADDRESS: host,
      STREAMLIT_SERVER_HEADLESS: 'true', STREAMLIT_BROWSER_GATHER_USAGE_STATS: 'false',
      STREAMLIT_SERVER_ENABLE_CORS: 'false', STREAMLIT_SERVER_ENABLE_XSRF_PROTECTION: 'false',
      GRADIO_SERVER_PORT: p, GRADIO_SERVER_NAME: host, GRADIO_ANALYTICS_ENABLED: 'false',
      FLASK_RUN_PORT: p, FLASK_RUN_HOST: host,
      PYTHONUNBUFFERED: '1',
      // keep the child's folder byte-identical to its repo (no __pycache__ written into it)
      PYTHONDONTWRITEBYTECODE: '1',
      APPCEPTION_CHILD: this.m.name,
      APPCEPTION_BASE_PATH: this.prefix,
      APPCEPTION_MOUNT: this.m.mount,
      // the pre-rename names, for child code written against them
      CATALOG_CHILD: this.m.name,
      CATALOG_BASE_PATH: this.prefix,
      CATALOG_MOUNT: this.m.mount,
    };
    if (venvBin) env.VIRTUAL_ENV = this.prepare.venv;
    else if (platBin) env.VIRTUAL_ENV = dirname(platBin);
    // Base-path hints, only where the framework needs one to build its own URLs.
    if (this.m.framework === 'gradio') env.GRADIO_ROOT_PATH = this.prefix;
    if (this.m.framework === 'dash' && !this.m.env.some((e) => /^DASH_(URL_BASE_PATHNAME|REQUESTS_PATHNAME_PREFIX|ROUTES_PATHNAME_PREFIX)$/.test(e.name))) {
      env.DASH_REQUESTS_PATHNAME_PREFIX = `${this.prefix}/`;
    }
    // The child's own app.yaml env, then overrides (later wins).
    this.resolvedEnv = [];
    this.unresolved = [];
    for (const e of this.m.env) {
      if ('value' in e) { env[e.name] = e.value; this.resolvedEnv.push({ name: e.name, from: e.from }); continue; }
      const v = await this.sup.resolveValueFrom(this.m, e.valueFrom);
      if (v.ok) { env[e.name] = v.value; this.resolvedEnv.push({ name: e.name, from: `${e.from} valueFrom ${e.valueFrom} (${v.how})` }); }
      else { delete env[e.name]; this.unresolved.push({ name: e.name, valueFrom: e.valueFrom, why: v.why }); }
    }
    return env;
  }

  async start(reason = 'request') {
    if (this.state === 'running') return this;
    if (this.starting) return this.starting;
    this.starting = this._start(reason).finally(() => { this.starting = null; });
    return this.starting;
  }

  async _start(reason) {
    const t0 = Date.now();
    this.lastError = null;
    if (!this.m.ok && !this.m.needsBuild) {
      this.state = 'failed';
      this.lastError = this.m.problems.join('; ');
      throw new Error(this.lastError);
    }
    const st = await this.ensurePrepared();
    if (st.status !== 'ready') {
      this.state = st.status === 'needs_build' ? 'needs_build' : 'failed';
      this.lastError = st.error ?? `dependencies: ${st.status}`;
      this.phase = null;
      throw new Error(this.lastError);
    }
    this.state = 'starting';
    this.phase = 'starting server';
    this.port = await freePort();
    const { argv, notes } = rewriteCommand(this.m.command, this.port);
    this.rewriteNotes = notes;
    const env = await this.buildEnv();
    let cmd = argv[0];
    // Resolve bare `python`/`python3` to the child's interpreter explicitly.
    if (/^python3?$/.test(cmd) && this.prepare?.python) cmd = this.prepare.python;
    this.log.push(`[catalog] start (${reason}) :: ${[cmd, ...argv.slice(1)].join(' ')}  port=${this.port}${notes.length ? `  rewrote: ${notes.join('; ')}` : ''}`);
    for (const u of this.unresolved) this.log.push(`[catalog] WARNING env ${u.name} not set: valueFrom "${u.valueFrom}" — ${u.why}`);
    const proc = spawn(cmd, argv.slice(1), { cwd: this.m.appRoot, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    this.proc = proc;
    this.startedAt = Date.now();
    proc.stdout.on('data', (b) => this.log.write(b));
    proc.stderr.on('data', (b) => this.log.write(b));
    let exited = null;
    proc.on('error', (e) => { exited = { code: null, signal: null, error: String(e) }; this.log.push(`[catalog] spawn error: ${e}`); });
    proc.on('exit', (code, signal) => {
      exited = { code, signal };
      this.lastExit = { code, signal, at: Date.now() };
      this.log.push(`[catalog] process exited code=${code} signal=${signal}`);
      if (this.proc === proc) {
        this.proc = null;
        if (this.state === 'running') { this.state = 'crashed'; this.lastError = `exited unexpectedly (code ${code}${signal ? `, ${signal}` : ''})`; }
        else if (this.state !== 'stopping') { this.state = 'failed'; }
        else this.state = 'stopped';
      }
    });
    const deadline = Date.now() + (this.sup.startTimeoutMs ?? 180000);
    while (Date.now() < deadline) {
      if (exited) {
        this.state = 'failed';
        const hint = /address already in use|errno 98|eaddrinuse/i.test(this.log.tail(60)) ? ' — it tried to bind a port that is taken; make it listen on DATABRICKS_APP_PORT' : '';
        this.lastError = `exited during startup (code ${exited.code}${exited.signal ? `, ${exited.signal}` : ''})${hint}`;
        this.phase = null;
        throw new Error(this.lastError);
      }
      if (await tryConnect('127.0.0.1', this.port)) { this.host = '127.0.0.1'; break; }
      if (await tryConnect('::1', this.port)) { this.host = '::1'; break; }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (Date.now() >= deadline) {
      this.lastError = `did not open port ${this.port} within ${Math.round((this.sup.startTimeoutMs ?? 180000) / 1000)}s`;
      this.stop('start timeout');
      this.state = 'failed';
      this.phase = null;
      throw new Error(this.lastError);
    }
    this.state = 'running';
    this.phase = null;
    this.readyAt = Date.now();
    this.startMs = this.readyAt - t0;
    this.touch();
    this.log.push(`[catalog] ready on ${this.host}:${this.port} after ${this.startMs}ms`);
    return this;
  }

  stop(reason = 'requested') {
    const proc = this.proc;
    if (!proc) { if (['crashed', 'failed'].includes(this.state)) return; this.state = 'stopped'; return; }
    this.state = 'stopping';
    this.log.push(`[catalog] stopping (${reason})`);
    try { process.kill(-proc.pid, 'SIGTERM'); } catch { try { proc.kill('SIGTERM'); } catch { /* gone */ } }
    const t = setTimeout(() => { try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* gone */ } }, 8000);
    proc.once('exit', () => { clearTimeout(t); this.state = 'stopped'; this.port = null; });
  }

  status() {
    const rss = this.proc ? treeRss(this.proc.pid) : null;
    const st = this.prepare;
    return {
      name: this.m.name, state: this.state, phase: this.phase, port: this.port,
      pid: this.proc?.pid ?? null, uptimeMs: this.readyAt && this.state === 'running' ? Date.now() - this.readyAt : null,
      lastActivity: this.lastActivity || null, active: this.active, sockets: this.sockets,
      startMs: this.startMs, restarts: this.restarts, lastExit: this.lastExit, lastError: this.lastError,
      rssBytes: rss?.bytes ?? null, processes: rss?.processes ?? null,
      prepare: st ? { status: st.status, ms: st.ms ?? null, error: st.error ?? null, cached: !!st.cached, steps: (st.steps ?? []).map((s) => ({ label: s.label, ok: s.ok, ms: s.ms })) } : null,
      unresolvedEnv: this.unresolved, rewriteNotes: this.rewriteNotes,
    };
  }
}

export class Supervisor {
  constructor(root, manifests, opts = {}) {
    this.root = root;
    this.children = new Map(manifests.map((m) => [m.name, new Child(m, this)]));
    this.idleMs = (Number(env('IDLE_MINUTES')) || 30) * 60000;
    this.memHigh = (Number(env('MEMORY_HIGH_PCT')) || 85) / 100;
    this.startTimeoutMs = (Number(env('START_TIMEOUT_S')) || 180) * 1000;
    this.resolveValueFrom = opts.resolveValueFrom ?? (async () => ({ ok: false, why: 'no resolver' }));
    this.events = [];
  }
  get(name) { return this.children.get(name) ?? null; }
  list() { return [...this.children.values()]; }
  note(msg) { this.events.push({ at: Date.now(), msg }); if (this.events.length > 200) this.events.shift(); }

  startTimers() {
    this.timer = setInterval(() => this.sweep(), 15000);
    this.timer.unref();
    for (const c of this.list()) {
      if (c.m.keepWarm && c.m.ok) c.start('keep_warm').catch((e) => c.log.push(`[catalog] keep_warm start failed: ${e.message}`));
    }
  }

  sweep() {
    const now = Date.now();
    for (const c of this.list()) {
      if (c.state !== 'running' || c.m.keepWarm) continue;
      const idle = c.m.idleMinutes != null ? c.m.idleMinutes * 60000 : this.idleMs;
      if (c.active === 0 && c.sockets === 0 && now - c.lastActivity > idle) {
        this.note(`${c.name}: stopped after ${Math.round(idle / 60000)} min idle`);
        c.stop('idle');
      }
    }
    const mem = containerMemory();
    if (mem.limit && mem.usage && mem.usage / mem.limit > this.memHigh) {
      const victim = this.list()
        .filter((c) => c.state === 'running' && !c.m.keepWarm && c.active === 0 && c.sockets === 0)
        .sort((a, b) => a.lastActivity - b.lastActivity)[0];
      if (victim) {
        this.note(`${victim.name}: stopped to free memory (container at ${Math.round((100 * mem.usage) / mem.limit)}%)`);
        victim.stop('memory pressure');
      }
    }
  }

  stopAll() { for (const c of this.list()) c.stop('master shutting down'); }
}

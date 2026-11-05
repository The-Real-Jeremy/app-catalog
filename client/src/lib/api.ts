/** Shapes returned by catalog/server.mjs (/_catalog/api/catalog). Checked against a
 *  real response, not invented: see docs/DESIGN.md "API". */
export type ChildState = 'stopped' | 'preparing' | 'starting' | 'running' | 'stopping' | 'failed' | 'crashed' | 'needs_build';

export interface ChildStatus {
  name: string;
  state: ChildState;
  phase: string | null;
  port: number | null;
  pid: number | null;
  uptimeMs: number | null;
  lastActivity: number | null;
  active: number;
  sockets: number;
  startMs: number | null;
  restarts: number;
  lastExit: { code: number | null; signal: string | null; at: number } | null;
  lastError: string | null;
  rssBytes: number | null;
  processes: number | null;
  prepare: { status: string; ms: number | null; error: string | null; cached: boolean; steps: { label: string; ok: boolean; ms: number }[] } | null;
  unresolvedEnv: { name: string; valueFrom: string; why: string }[];
  rewriteNotes: string[];
}

export interface ChildResource { name: string; kind: string; target: string | null; bound: boolean | null }

export interface Child {
  name: string;
  title: string;
  description: string | null;
  framework: string;
  frameworkLabel: string;
  mount: 'prefix' | 'root';
  mountReason: string;
  category: string;
  hidden: boolean;
  icon: string | null;
  accent: string | null;
  order: number | null;
  keepWarm: boolean;
  source: string | null;
  licenses: string[];
  appRoot: string;
  appRootReason: string | null;
  command: string[];
  commandReason: string | null;
  env: { name: string; valueFrom: string | null; from: string }[];
  scopes: string[];
  missingScopes: string[];
  resources: ChildResource[];
  deps: { python: string | null; node: boolean; nodeBuild: boolean };
  problems: string[];
  warnings: string[];
  needsBuild: boolean;
  status: ChildStatus;
}

export interface CatalogModel {
  master: {
    name: string;
    url: string | null;
    buildId: string;
    fingerprint: string;
    startedAt: string;
    computeSize: string | null;
    dbuPerHour: number | null;
    memory: { limit: number | null; usage: number | null };
    cpus: number | null;
    scopes: string[];
    resources: { name: string; kind: string; target: string | null }[];
    appRecord: string;
    viewer: { name: string | null; email: string | null };
    idleMinutes: number;
  };
  cost: { apps: number; separateDbuPerHour: number; catalogDbuPerHour: number | null; assumption: string };
  events: { at: number; msg: string }[];
  children: Child[];
}

async function asJson<T>(r: Response): Promise<T> {
  const text = await r.text();
  // A non-2xx body is not data: an expired session answers with a login page or `{}`.
  if (!r.ok) throw new Error(`HTTP ${r.status}${text.startsWith('<') ? ' (not the catalog — session expired?)' : `: ${text.slice(0, 160)}`}`);
  if (text.startsWith('<')) throw new Error('the catalog answered with an HTML page instead of JSON (session expired?)');
  return JSON.parse(text) as T;
}

export async function getCatalog(): Promise<CatalogModel> {
  return asJson<CatalogModel>(await fetch('/_catalog/api/catalog', { cache: 'no-store' }));
}
export async function getChild(name: string): Promise<{ name: string; title: string; status: ChildStatus }> {
  return asJson(await fetch(`/_catalog/api/children/${encodeURIComponent(name)}`, { cache: 'no-store' }));
}
export async function childAction(name: string, action: 'start' | 'stop' | 'restart' | 'prepare'): Promise<{ ok: boolean; status: ChildStatus }> {
  return asJson(await fetch(`/_catalog/api/children/${encodeURIComponent(name)}/${action}`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }));
}
export async function getLogs(name: string, tail = 400): Promise<{ runtime: string; install: string }> {
  return asJson(await fetch(`/_catalog/api/children/${encodeURIComponent(name)}/logs?tail=${tail}`, { cache: 'no-store' }));
}

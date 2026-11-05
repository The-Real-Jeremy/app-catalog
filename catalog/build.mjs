/**
 * `npm run build` — runs INSIDE the Databricks Apps container at deploy time
 * (the platform runs a package.json `build` script after `npm install`).
 *
 * Installs every child's dependencies into its own environment so the children
 * are ready the moment the master starts. A child that fails to install never
 * fails the master's deploy: its card shows the error and its log instead.
 * Locally the same command prepares the children for `npm start`.
 */
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { discoverAll } from './lib/discover.mjs';
import { prepareChild, catalogDirs } from './lib/prepare.mjs';
import { env } from './lib/env.mjs';

const ROOT = resolve(env('ROOT') ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
if (env('PREPARE_AT_BUILD') === '0') {
  console.log('[catalog-build] APPCEPTION_PREPARE_AT_BUILD=0 — children will be prepared on first start');
  process.exit(0);
}
const t0 = Date.now();
const { children } = discoverAll(ROOT);
const concurrency = Math.max(1, Number(env('BUILD_CONCURRENCY')) || 3);
console.log(`[catalog-build] preparing ${children.length} children (concurrency ${concurrency}) in ${ROOT}`);
const queue = [...children];
const results = [];
async function worker() {
  while (queue.length) {
    const c = queue.shift();
    const r = await prepareChild(c, { root: ROOT });
    results.push({ name: c.name, status: r.status, ms: r.ms ?? 0, error: r.error ?? null, cached: !!r.cached });
    console.log(`[catalog-build] ${c.name}: ${r.status}${r.cached ? ' (cached)' : ''} in ${((r.ms ?? 0) / 1000).toFixed(1)}s${r.error ? ` — ${r.error}` : ''}`);
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));
const summary = { at: new Date().toISOString(), ms: Date.now() - t0, results };
writeFileSync(join(catalogDirs(ROOT).base, 'build-summary.json'), JSON.stringify(summary, null, 2));
console.log(`[catalog-build] done in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${results.filter((r) => r.status === 'ready').length}/${results.length} ready`);
process.exit(0);

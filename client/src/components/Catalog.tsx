import { useMemo, useState } from 'react';
import type { CatalogModel, Child } from '../lib/api';
import { childAction } from '../lib/api';
import { ago, bytes, duration, hash, monogram } from '../lib/format';
import { BrandMenu, CountUp, FrameworkBadge, StatusPill } from './bits';

/* Decorative card art — on-brand gradients picked by a stable hash of the name.
 * Pure decoration: it encodes nothing, so it never competes with status colour. */
const ART = [
  'linear-gradient(135deg, var(--brand) 0%, color-mix(in oklab, var(--brand) 40%, var(--accent)) 55%, var(--accent) 100%)',
  'linear-gradient(140deg, var(--accent) 0%, color-mix(in oklab, var(--accent) 55%, #0b1220) 100%)',
  'linear-gradient(125deg, #111827 0%, color-mix(in oklab, var(--accent) 70%, #111827) 100%)',
  'linear-gradient(150deg, color-mix(in oklab, var(--brand) 85%, #ff9f1c) 0%, var(--brand) 45%, color-mix(in oklab, var(--brand) 30%, #111827) 100%)',
  'linear-gradient(120deg, color-mix(in oklab, var(--accent) 80%, #ffffff) 0%, var(--accent) 50%, #111827 100%)',
];

function Art({ child }: { child: Child }) {
  const h = hash(child.name);
  const bg = child.accent ? `linear-gradient(135deg, ${child.accent}, #111827)` : ART[h % ART.length];
  const light = (h % ART.length) === 0 || (h % ART.length) === 3;
  return (
    <div className="relative h-[108px] overflow-hidden" style={{ background: bg }}>
      <div className="absolute inset-0 opacity-[.22]" style={{ backgroundImage: 'radial-gradient(rgba(255,255,255,.9) 1px, transparent 1.2px)', backgroundSize: '14px 14px', maskImage: 'linear-gradient(110deg, transparent 20%, #000 75%)' }} />
      <div className={`absolute bottom-1 right-4 select-none text-[64px] font-black leading-none tracking-tighter ${light ? 'text-[#111827]/20' : 'text-white/20'}`} aria-hidden>
        {child.icon ?? monogram(child.title)}
      </div>
      <div className="absolute left-3 top-3"><FrameworkBadge framework={child.framework} label={child.frameworkLabel} /></div>
    </div>
  );
}

function Needs({ child }: { child: Child }) {
  const items: { label: string; ok: boolean | null; title: string }[] = [];
  for (const r of child.resources) {
    const label = { sql_warehouse: 'Warehouse', serving_endpoint: 'Model serving', genie_space: 'Genie', job: 'Job', secret: 'Secret', uc_securable: 'UC object', database: 'Lakebase', experiment: 'Experiment', app: 'App' }[r.kind] ?? r.kind;
    items.push({ label, ok: r.bound, title: `${r.kind} ${r.target ?? ''}${r.bound === false ? ' — not bound to the catalog app' : ''}` });
  }
  for (const s of child.scopes) items.push({ label: `OBO: ${s}`, ok: !child.missingScopes.includes(s), title: `user API scope "${s}"${child.missingScopes.includes(s) ? ' — the catalog app does not have it' : ''}` });
  if (!items.length) return <span className="text-[11px] text-muted">No workspace resources</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.slice(0, 5).map((it) => (
        <span key={it.label} title={it.title} className="inline-flex items-center gap-1 rounded-md border border-line bg-sunken px-1.5 py-0.5 text-[10.5px] text-dim">
          {it.ok === false ? <span style={{ color: 'var(--serious)' }} aria-label="missing">✕</span> : <span className="text-muted" aria-hidden>·</span>}
          {it.label}
        </span>
      ))}
      {items.length > 5 && <span className="text-[10.5px] text-muted">+{items.length - 5}</span>}
    </div>
  );
}

function AppCard({ child, index, onOpen }: { child: Child; index: number; onOpen: (c: Child) => void }) {
  const st = child.status;
  const trouble = child.problems.length > 0 || ['failed', 'crashed', 'needs_build'].includes(st.state);
  const reason = child.problems[0] ?? st.lastError ?? st.prepare?.error ?? null;
  const [busy, setBusy] = useState(false);
  const wake = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setBusy(true);
    try { await childAction(child.name, st.state === 'running' ? 'stop' : 'start'); } finally { setTimeout(() => setBusy(false), 600); }
  };
  return (
    <article
      className="rise card-sheen group flex cursor-pointer flex-col overflow-hidden rounded-[var(--radius)] border border-line bg-card shadow-[var(--shadow)] transition duration-200 hover:-translate-y-1 hover:border-brand/60 hover:shadow-[0_22px_60px_var(--glow)] focus-within:border-brand/60"
      style={{ ['--i' as string]: index }}
      onClick={() => onOpen(child)} data-testid={`card-${child.name}`} data-state={st.state}>
      <Art child={child} />
      <div className="flex flex-1 flex-col gap-2.5 p-4">
        <div className="flex items-start justify-between gap-3">
          <h3 className="line-clamp-2 text-[16px] font-bold leading-snug tracking-tight text-ink">{child.title}</h3>
          <StatusPill state={st.state} compact title={st.state === 'stopped' ? 'Starts on first open, then sleeps when idle' : undefined} />
        </div>
        <p className="line-clamp-3 min-h-[3.9em] text-[13px] leading-relaxed text-dim">{child.description ?? 'No description in the app’s README.'}</p>
        {trouble && reason && (
          <p className="line-clamp-2 rounded-lg border px-2.5 py-1.5 text-[11.5px] text-ink" style={{ borderColor: 'color-mix(in oklab, var(--serious) 55%, transparent)', background: 'color-mix(in oklab, var(--serious) 10%, transparent)' }}>
            <span style={{ color: 'var(--serious)' }} aria-hidden>▲ </span>{reason}
          </p>
        )}
        <div className="mt-auto flex flex-col gap-3 pt-1">
          <Needs child={child} />
          <div className="flex items-center justify-between gap-2 border-t border-line pt-3">
            <span className="min-w-0 truncate font-mono text-[11px] text-muted" title={`/apps/${child.name}/`}>
              {st.state === 'running'
                ? `${st.rssBytes != null ? bytes(st.rssBytes) : 'awake'}${st.startMs != null ? ` · woke in ${duration(st.startMs)}` : ''}`
                : st.lastActivity ? `used ${ago(st.lastActivity)}` : 'not opened yet'}
            </span>
            <div className="flex shrink-0 items-center gap-1.5">
              <button type="button" onClick={wake} disabled={busy || trouble} title={st.state === 'running' ? 'Stop (frees memory)' : 'Start without opening'}
                className="rounded-full border border-line px-2.5 py-1 text-[11px] text-dim transition hover:border-line-strong hover:text-ink disabled:opacity-40" data-testid={`wake-${child.name}`}>
                {st.state === 'running' ? 'Stop' : 'Start'}
              </button>
              <span className="inline-flex items-center gap-1 rounded-full bg-brand px-3 py-1 text-[12px] font-bold text-brand-ink transition group-hover:gap-2">Open <span aria-hidden>→</span></span>
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}

function Meter({ used, limit }: { used: number | null; limit: number | null }) {
  if (!used || !limit) return <div className="mt-2 text-xs text-muted">not measured here (local run)</div>;
  const pct = Math.min(100, (100 * used) / limit);
  const color = pct >= 85 ? 'var(--crit)' : pct >= 60 ? 'var(--warn)' : 'var(--accent)';
  return (
    <div className="mt-3" title={`${bytes(used)} of ${bytes(limit)} (${pct.toFixed(0)}%)`}>
      <div className="h-2.5 overflow-hidden rounded-full" style={{ background: `color-mix(in oklab, ${color} 20%, transparent)` }} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label="container memory used">
        <div className="h-full rounded-full transition-[width] duration-700" style={{ width: `${Math.max(2, pct)}%`, background: color }} />
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] text-muted"><span>{pct.toFixed(0)}% used</span><span>limit {bytes(limit)}</span></div>
    </div>
  );
}

function Stats({ model }: { model: CatalogModel }) {
  const visible = model.children.filter((c) => !c.hidden);
  const demos = visible.filter((c) => c.category !== 'starter');
  const running = visible.filter((c) => c.status.state === 'running').length;
  const childRss = visible.reduce((a, c) => a + (c.status.rssBytes ?? 0), 0);
  const cat = model.cost.catalogDbuPerHour ?? 0.5;
  const sep = model.cost.separateDbuPerHour;
  const saved = sep - cat;
  const maxBar = Math.max(sep, cat, 0.0001);
  return (
    <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4" data-testid="stats">
      <div className="rounded-[var(--radius)] border border-line bg-card/90 p-5">
        <div className="text-[11px] font-semibold uppercase tracking-[.12em] text-muted">Demo apps in this catalog</div>
        <div className="mt-1 text-[52px] font-bold leading-none tracking-tight text-ink"><CountUp value={demos.length} /></div>
        <div className="mt-2 text-[12.5px] text-dim">+ {visible.length - demos.length} framework starters, all served by <b className="text-ink">one</b> Databricks App</div>
      </div>
      <div className="rounded-[var(--radius)] border border-line bg-card/90 p-5">
        <div className="text-[11px] font-semibold uppercase tracking-[.12em] text-muted">Awake right now</div>
        <div className="mt-1 flex items-baseline gap-2"><span className="text-[34px] font-bold leading-none text-ink"><CountUp value={running} /></span><span className="text-sm text-dim">of {visible.length}</span></div>
        <div className="mt-3 flex flex-wrap gap-1.5" aria-label="per-app state">
          {visible.map((c) => (
            <span key={c.name} title={`${c.title}: ${c.status.state}`} className="h-2.5 w-6 rounded-full"
              style={{ background: c.status.state === 'running' ? 'var(--ok)' : ['starting', 'preparing'].includes(c.status.state) ? 'var(--warn)' : 'color-mix(in oklab, var(--idle) 35%, transparent)' }} />
          ))}
        </div>
        <div className="mt-2 text-[11.5px] text-muted">apps wake on first open, sleep after {model.master.idleMinutes} min idle</div>
      </div>
      <div className="rounded-[var(--radius)] border border-line bg-card/90 p-5">
        <div className="text-[11px] font-semibold uppercase tracking-[.12em] text-muted">Instance memory</div>
        <div className="mt-1 flex items-baseline gap-2"><span className="text-[34px] font-bold leading-none text-ink">{bytes(model.master.memory.usage)}</span></div>
        <Meter used={model.master.memory.usage} limit={model.master.memory.limit} />
        <div className="mt-1 text-[11.5px] text-muted">{childRss ? `apps awake use ${bytes(childRss)}` : 'no apps awake — the catalog itself'}</div>
      </div>
      <div className="rounded-[var(--radius)] border border-line bg-card/90 p-5">
        <div className="text-[11px] font-semibold uppercase tracking-[.12em] text-muted">Compute, DBU per hour</div>
        <div className="mt-1 flex items-baseline gap-2"><span className="text-[34px] font-bold leading-none text-ink"><CountUp value={cat} decimals={1} /></span><span className="text-sm text-dim">vs {sep.toFixed(1)} as separate apps</span></div>
        <div className="mt-3 space-y-1.5" title={model.cost.assumption}>
          <div className="flex items-center gap-2 text-[11px]"><span className="w-[92px] shrink-0 text-dim">This catalog</span><span className="h-2.5 rounded-full" style={{ width: `${Math.max(3, (100 * cat) / maxBar)}%`, background: 'var(--accent)' }} /></div>
          <div className="flex items-center gap-2 text-[11px]"><span className="w-[92px] shrink-0 text-dim">{model.cost.apps} separate</span><span className="h-2.5 rounded-full" style={{ width: `${Math.max(3, (100 * sep) / maxBar)}%`, background: 'color-mix(in oklab, var(--idle) 55%, transparent)' }} /></div>
        </div>
        <div className="mt-2 text-[11.5px] text-muted">{saved > 0 ? `saves ${saved.toFixed(1)} DBU/h (${Math.round((100 * saved) / sep)}%), 24×7` : 'one app either way'} · {model.master.computeSize ?? 'MEDIUM'}</div>
      </div>
    </section>
  );
}

function HowTo() {
  const [open, setOpen] = useState(false);
  return (
    <section className="rounded-[var(--radius)] border border-dashed border-line-strong bg-card/60 p-5">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between text-left" aria-expanded={open}>
        <span><span className="text-[15px] font-bold text-ink">Add an app to this catalog</span> <span className="text-sm text-dim">— copy its repo in, redeploy, done.</span></span>
        <span className="text-dim">{open ? '−' : '+'}</span>
      </button>
      {open && (
        <ol className="fade-in mt-4 grid gap-3 text-[13px] text-dim md:grid-cols-3">
          <li className="rounded-xl border border-line bg-sunken p-3.5"><b className="text-ink">1 · Copy the repo</b><pre className="mt-2 overflow-x-auto rounded-lg bg-bg p-2 font-mono text-[11.5px] text-ink">cp -R ~/my-app child_apps/my_app</pre>Any Databricks App: Streamlit, Dash, Gradio, Flask, FastAPI, Shiny, Node. Its own <code className="font-mono">app.yaml</code> is all the catalog reads.</li>
          <li className="rounded-xl border border-line bg-sunken p-3.5"><b className="text-ink">2 · Redeploy the catalog</b><pre className="mt-2 overflow-x-auto rounded-lg bg-bg p-2 font-mono text-[11.5px] text-ink">npm run deploy</pre>Installs its requirements / npm packages into its own environment; binds the scopes and resources it declares.</li>
          <li className="rounded-xl border border-line bg-sunken p-3.5"><b className="text-ink">3 · Open it here</b><div className="mt-2">It appears as a card, at <code className="font-mono">/apps/my_app/</code>. Make sure the catalog app can reach what it needs (tables, Genie, endpoints).</div></li>
        </ol>
      )}
    </section>
  );
}

export function Catalog({ model, error, onOpen }: { model: CatalogModel | null; error: string | null; onOpen: (c: Child) => void }) {
  const [q, setQ] = useState('');
  const [fw, setFw] = useState<string>('all');
  const all = useMemo(() => (model?.children ?? []).filter((c) => !c.hidden), [model]);
  const children = all.filter((c) => c.category !== 'starter');
  const starters = all.filter((c) => c.category === 'starter');
  const frameworks = useMemo(() => {
    const m = new Map<string, { label: string; n: number }>();
    for (const c of all) m.set(c.framework, { label: c.frameworkLabel, n: (m.get(c.framework)?.n ?? 0) + 1 });
    return [...m.entries()].sort((a, b) => b[1].n - a[1].n);
  }, [all]);
  const match = (c: Child) => (fw === 'all' || c.framework === fw)
    && (!q || `${c.title} ${c.description ?? ''} ${c.frameworkLabel} ${c.name}`.toLowerCase().includes(q.toLowerCase()));
  const shown = children.filter(match);
  const shownStarters = starters.filter(match);
  const viewer = model?.master.viewer.name;
  return (
    <div className="min-h-full hero-wash">
      <header className="glass sticky top-0 z-40 border-b border-line">
        <div className="mx-auto flex max-w-[1400px] items-center justify-between gap-4 px-6 py-3">
          <BrandMenu />
          <div className="flex items-center gap-3 text-sm text-dim">
            {viewer && <span className="hidden items-center gap-2 rounded-full border border-line bg-raised px-3 py-1.5 md:inline-flex" data-testid="viewer"><span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-accent text-[10px] font-bold text-white">{monogram(viewer)}</span>{viewer}</span>}
          </div>
        </div>
      </header>
      <main className="mx-auto flex max-w-[1400px] flex-col gap-7 px-6 pb-16 pt-9">
        <section className="fade-in">
          <h1 className="text-[40px] font-bold leading-[1.05] tracking-[-.02em] text-ink">Every demo, <span className="text-brand-text">always on</span>, on one app.</h1>
          <p className="mt-3 max-w-[760px] text-[15.5px] leading-relaxed text-dim">Each card is a full Databricks App, dropped into <code className="font-mono text-ink">child_apps/</code> as-is. Open one and it wakes in seconds; idle ones sleep to leave room for the rest.</p>
        </section>
        {error && <div className="rounded-xl border p-3 text-sm text-ink" style={{ borderColor: 'var(--crit)' }}>Could not load the catalog: {error}</div>}
        {model && <Stats model={model} />}
        <section className="flex items-center gap-2" data-testid="toolbar">
          <div className="relative min-w-[170px] flex-1 basis-[200px]">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search apps…" aria-label="Search apps"
              className="h-9 w-full rounded-xl border border-line bg-raised pl-9 pr-3 text-sm text-ink placeholder:text-muted focus:border-brand/60 focus:outline-none" data-testid="search" />
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden>⌕</span>
          </div>
          <div className="scroll-thin flex shrink items-center gap-1.5 overflow-x-auto" role="group" aria-label="Filter by framework">
            <button type="button" onClick={() => setFw('all')} className={`h-9 shrink-0 rounded-xl border px-3 text-[13px] transition ${fw === 'all' ? 'border-brand/60 bg-brand/15 text-ink' : 'border-line bg-raised text-dim hover:text-ink'}`}>All <span className="text-muted">{all.length}</span></button>
            {frameworks.map(([k, v]) => (
              <button key={k} type="button" onClick={() => setFw(k)} className={`h-9 shrink-0 rounded-xl border px-3 text-[13px] transition ${fw === k ? 'border-brand/60 bg-brand/15 text-ink' : 'border-line bg-raised text-dim hover:text-ink'}`} data-testid={`filter-${k}`} title={v.label}>
                {k === 'apx' ? 'apx' : v.label} <span className="text-muted">{v.n}</span>
              </button>
            ))}
          </div>
        </section>
        {!model && !error && (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-5">
            {[0, 1, 2, 3].map((i) => <div key={i} className="h-[330px] animate-pulse rounded-[var(--radius)] border border-line bg-card/60" />)}
          </div>
        )}
        {model && (
          <section className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-5" data-testid="grid">
            {shown.map((c, i) => <AppCard key={c.name} child={c} index={i} onOpen={onOpen} />)}
            {!shown.length && <div className="col-span-full rounded-xl border border-dashed border-line p-10 text-center text-dim">{children.length ? 'No demo app matches that filter.' : 'No apps yet — add a folder to child_apps/ and redeploy.'}</div>}
          </section>
        )}
        {model && shownStarters.length > 0 && (
          <section className="flex flex-col gap-4" data-testid="starters">
            <div className="flex items-end justify-between gap-4 border-t border-line pt-6">
              <div>
                <h2 className="text-[20px] font-bold tracking-tight text-ink">Framework starters</h2>
                <p className="mt-1 text-[13.5px] text-dim">One per framework Databricks Apps supports, each running here from nothing but its own <code className="font-mono text-ink">app.yaml</code> — copy one to begin a new app.</p>
              </div>
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-5">
              {shownStarters.map((c, i) => <AppCard key={c.name} child={c} index={i} onOpen={onOpen} />)}
            </div>
          </section>
        )}
        <HowTo />
        {model && (
          <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-4 text-[11.5px] text-muted">
            <span>{model.master.name} · build <span className="font-mono">{model.master.buildId}</span> · code <span className="font-mono">{model.master.fingerprint.slice(0, 8)}</span></span>
            <span>{children.length} demo apps + {starters.length} starters · 1 Databricks App · {model.master.computeSize ?? 'local'}</span>
          </footer>
        )}
      </main>
    </div>
  );
}

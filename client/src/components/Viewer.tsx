import { useCallback, useEffect, useRef, useState } from 'react';
import type { CatalogModel, Child, ChildStatus } from '../lib/api';
import { childAction, getChild, getLogs } from '../lib/api';
import { bytes, duration, monogram } from '../lib/format';
import { FrameworkBadge, IconButton, StatusPill } from './bits';

const BAD = ['failed', 'crashed', 'needs_build'];

function Boot({ child, status, elapsed, onRetry, onLogs }: { child: Child; status: ChildStatus | null; elapsed: number; onRetry: () => void; onLogs: () => void }) {
  const failed = status && BAD.includes(status.state);
  const phase = status?.state === 'running' ? 'opening…' : status?.phase ?? (status?.state === 'stopped' ? 'waking up…' : status?.state ?? 'connecting…');
  const steps = status?.prepare?.steps ?? [];
  return (
    <div className="fade-in absolute inset-0 z-10 grid place-items-center bg-bg hero-wash" data-testid="boot">
      <div className="w-[min(560px,92vw)] rounded-[20px] border border-line bg-card/90 p-8 shadow-[var(--shadow)]">
        <div className="flex items-center gap-4">
          <div className={`grid h-16 w-16 place-items-center rounded-2xl text-xl font-black text-brand-ink ${failed ? '' : 'breathe'}`} style={{ background: 'linear-gradient(135deg, var(--brand), var(--accent))' }}>{child.icon ?? monogram(child.title)}</div>
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-[.14em] text-muted">{failed ? 'Could not start' : 'Starting'}</div>
            <div className="truncate text-[20px] font-bold tracking-tight text-ink">{child.title}</div>
            <div className="mt-1"><FrameworkBadge framework={child.framework} label={child.frameworkLabel} /></div>
          </div>
        </div>
        {!failed && (
          <>
            <div className="mt-6 flex items-center justify-between font-mono text-[12.5px]"><span className="text-ink">{phase}</span><span className="text-muted">{(elapsed / 1000).toFixed(0)}s</span></div>
            <div className="relative mt-2 h-1.5 overflow-hidden rounded-full" style={{ background: 'var(--track)' }}><div className="shimmer absolute inset-y-0 w-1/3 rounded-full" style={{ background: 'linear-gradient(90deg, var(--brand), var(--accent))' }} /></div>
            {steps.length > 0 && (
              <ul className="mt-4 space-y-1 text-[12px] text-dim">{steps.map((s) => <li key={s.label} className="flex justify-between"><span>{s.ok ? '✓' : '✕'} {s.label}</span><span className="font-mono text-muted">{duration(s.ms)}</span></li>)}</ul>
            )}
            <p className="mt-4 text-[12px] text-muted">Apps sleep when nobody uses them, so the first open after a while takes a few seconds.</p>
          </>
        )}
        {failed && (
          <>
            <pre className="mt-5 max-h-[220px] overflow-auto whitespace-pre-wrap rounded-xl border border-line bg-sunken p-3 font-mono text-[11.5px] text-ink">{status?.lastError ?? status?.prepare?.error ?? child.problems.join('\n') ?? 'unknown error'}</pre>
            <div className="mt-4 flex gap-2">
              <button type="button" onClick={onRetry} className="rounded-full bg-brand px-4 py-2 text-sm font-bold text-brand-ink">Retry</button>
              <button type="button" onClick={onLogs} className="rounded-full border border-line px-4 py-2 text-sm text-ink">View logs</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function LogsDrawer({ child, onClose }: { child: Child; onClose: () => void }) {
  const [tab, setTab] = useState<'runtime' | 'install'>('runtime');
  const [logs, setLogs] = useState<{ runtime: string; install: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const pre = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    let live = true;
    const load = () => getLogs(child.name, 600).then((l) => { if (live) { setLogs(l); setErr(null); } }).catch((e) => live && setErr(String(e.message ?? e)));
    load();
    const t = setInterval(load, 2000);
    return () => { live = false; clearInterval(t); };
  }, [child.name]);
  useEffect(() => { if (pre.current && stick.current) pre.current.scrollTop = pre.current.scrollHeight; }, [logs, tab]);
  return (
    <aside className="slide-in absolute inset-y-0 right-0 z-30 flex w-[min(720px,96vw)] flex-col border-l border-line bg-raised shadow-2xl" data-testid="logs">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <div className="flex gap-1">
          {(['runtime', 'install'] as const).map((t) => (
            <button key={t} type="button" onClick={() => setTab(t)} className={`rounded-lg px-3 py-1.5 text-sm ${tab === t ? 'bg-hover text-ink' : 'text-dim hover:text-ink'}`}>{t === 'runtime' ? 'App output' : 'Install log'}</button>
          ))}
        </div>
        <button type="button" onClick={onClose} className="rounded-lg px-2 py-1 text-dim hover:text-ink" aria-label="Close logs">✕</button>
      </div>
      {err && <div className="px-4 py-2 text-xs" style={{ color: 'var(--crit)' }}>{err}</div>}
      <pre ref={pre} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}
        className="scroll-thin flex-1 overflow-auto whitespace-pre-wrap break-words bg-sunken p-4 font-mono text-[11.5px] leading-relaxed text-ink">{logs ? (logs[tab] || '(empty)') : 'loading…'}</pre>
    </aside>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return <div className="grid grid-cols-[150px_1fr] gap-3 border-b border-line/70 py-2 text-[12.5px]"><div className="text-muted">{k}</div><div className="min-w-0 break-words text-ink">{children}</div></div>;
}

function DetailsDrawer({ child, status, model, onClose }: { child: Child; status: ChildStatus | null; model: CatalogModel | null; onClose: () => void }) {
  return (
    <aside className="slide-in scroll-thin absolute inset-y-0 right-0 z-30 w-[min(640px,96vw)] overflow-auto border-l border-line bg-raised p-5 shadow-2xl" data-testid="details">
      <div className="flex items-start justify-between">
        <div><div className="text-[11px] font-semibold uppercase tracking-[.14em] text-muted">How this app runs here</div><h2 className="mt-1 text-[19px] font-bold text-ink">{child.title}</h2></div>
        <button type="button" onClick={onClose} className="rounded-lg px-2 py-1 text-dim hover:text-ink" aria-label="Close details">✕</button>
      </div>
      <div className="mt-4">
        <Row k="Folder">child_apps/{child.name}/</Row>
        <Row k="Served at"><span className="font-mono">/apps/{child.name}/</span> · mount <b>{child.mount}</b> <span className="text-muted">({child.mountReason})</span></Row>
        <Row k="App root"><span className="font-mono">{child.appRoot}</span> <span className="text-muted">({child.appRootReason})</span></Row>
        <Row k="Command"><span className="font-mono">{child.command.join(' ') || '—'}</span> <span className="text-muted">({child.commandReason ?? 'n/a'})</span>{status?.rewriteNotes?.length ? <div className="mt-1 text-muted">port rewritten: {status.rewriteNotes.join('; ')}</div> : null}</Row>
        <Row k="Dependencies">{[child.deps.node && 'npm install', child.deps.python === 'requirements' && 'pip install -r requirements.txt', child.deps.python === 'uv' && 'uv sync', child.deps.nodeBuild && 'npm run build'].filter(Boolean).join(' → ') || 'none (uses the platform’s pre-installed libraries)'}{status?.prepare?.ms != null && <span className="text-muted"> · took {duration(status.prepare.ms)}</span>}</Row>
        <Row k="Process">{status?.pid ? `pid ${status.pid} · port ${status.port} · ${bytes(status.rssBytes)} in ${status.processes ?? '?'} process(es)` : status?.state ?? '—'}{status?.startMs != null && ` · started in ${duration(status.startMs)}`}</Row>
        <Row k="Environment">{child.env.length ? child.env.map((e) => <div key={e.name} className="font-mono text-[11.5px]">{e.name}{e.valueFrom ? <span className="text-muted"> ← valueFrom {e.valueFrom}</span> : <span className="text-muted"> · {e.from}</span>}</div>) : <span className="text-muted">none declared</span>}{status?.unresolvedEnv?.map((u) => <div key={u.name} className="mt-1 text-[11.5px]" style={{ color: 'var(--serious)' }}>▲ {u.name} not set: {u.why}</div>)}</Row>
        <Row k="OBO scopes">{child.scopes.length ? child.scopes.map((s) => <span key={s} className="mr-2 font-mono">{child.missingScopes.includes(s) ? <span style={{ color: 'var(--serious)' }}>✕ </span> : '✓ '}{s}</span>) : <span className="text-muted">none</span>}{child.missingScopes.length > 0 && <div className="mt-1 text-[11.5px] text-dim">The catalog app is missing these; redeploy with scripts/deploy.mjs (it adds the union of every child’s scopes) and re-consent.</div>}</Row>
        <Row k="Resources">{child.resources.length ? child.resources.map((r) => <div key={r.name} className="font-mono text-[11.5px]">{r.bound === false ? <span style={{ color: 'var(--serious)' }}>✕ </span> : r.bound ? '✓ ' : '· '}{r.kind} {r.target}</div>) : <span className="text-muted">none declared</span>}</Row>
        {(child.problems.length > 0 || child.warnings.length > 0) && <Row k="Notes">{[...child.problems.map((p) => `▲ ${p}`), ...child.warnings].map((w) => <div key={w} className="text-[12px]">{w}</div>)}</Row>}
        <Row k="Source">{child.source ? <a className="underline" href={child.source} target="_blank" rel="noreferrer">{child.source}</a> : <span className="text-muted">copied repo</span>}{child.licenses.length ? <span className="text-muted"> · licence: {child.licenses.join(', ')}</span> : <span className="text-muted"> · no licence file</span>}</Row>
        {model && <Row k="Catalog app">{model.master.name} · {model.master.computeSize ?? 'local'} · build <span className="font-mono">{model.master.buildId}</span></Row>}
      </div>
    </aside>
  );
}

export function Viewer({ child, model, initialPath, onBack }: { child: Child; model: CatalogModel | null; initialPath: string | null; onBack: () => void }) {
  const [status, setStatus] = useState<ChildStatus | null>(child.status);
  const [src, setSrc] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [drawer, setDrawer] = useState<'logs' | 'details' | null>(null);
  const [full, setFull] = useState(new URLSearchParams(location.search).get('fs') === '1');
  const [path, setPath] = useState(initialPath ?? '/');
  const [title, setTitle] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const t0 = useRef(Date.now());
  const frame = useRef<HTMLIFrameElement>(null);

  const target = useCallback((p: string) => `/apps/${child.name}${p.startsWith('/') ? p : `/${p}`}`, [child.name]);

  // Wake the child, then point the frame at it.
  useEffect(() => {
    let live = true;
    t0.current = Date.now();
    setLoaded(false);
    setSrc(null);
    const tick = setInterval(() => setElapsed(Date.now() - t0.current), 250);
    (async () => {
      let st = (await getChild(child.name).catch(() => null))?.status ?? null;
      if (!live) return;
      setStatus(st);
      if (st?.state !== 'running') {
        st = (await childAction(child.name, 'start').catch(() => null))?.status ?? st;
        while (live) {
          await new Promise((r) => setTimeout(r, 600));
          st = (await getChild(child.name).catch(() => null))?.status ?? st;
          if (!live) return;
          setStatus(st);
          if (!st || st.state === 'running' || BAD.includes(st.state)) break;
        }
      }
      if (live && st?.state === 'running') setSrc(target(initialPath ?? '/'));
    })();
    return () => { live = false; clearInterval(tick); };
  }, [child.name, nonce, target, initialPath]);

  // Keep the status fresh while the app is open (memory, crashes).
  useEffect(() => {
    if (!src) return;
    const t = setInterval(() => getChild(child.name).then((r) => setStatus(r.status)).catch(() => {}), 4000);
    return () => clearInterval(t);
  }, [src, child.name]);

  // The shim inside the child reports navigations; mirror them into our URL.
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== location.origin || !e.data || e.data.appception !== 'nav' || e.data.name !== child.name) return;
      let p: string = e.data.path ?? '/';
      const prefix = `/apps/${child.name}`;
      if (p.startsWith(prefix)) p = p.slice(prefix.length) || '/';
      setPath(p);
      if (e.data.title) setTitle(e.data.title);
      const u = new URL(location.href);
      u.searchParams.set('app', child.name);
      if (p && p !== '/') u.searchParams.set('path', p); else u.searchParams.delete('path');
      history.replaceState(history.state, '', u);
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [child.name]);

  useEffect(() => {
    const u = new URL(location.href);
    if (full) u.searchParams.set('fs', '1'); else u.searchParams.delete('fs');
    history.replaceState(history.state, '', u);
  }, [full]);

  useEffect(() => { document.title = `${title ? `${title} · ` : ''}${child.title} — App-ception`; }, [title, child.title]);

  const reload = () => { setLoaded(false); if (frame.current) frame.current.src = target(path); };
  const restart = async () => { await childAction(child.name, 'restart').catch(() => {}); setNonce((n) => n + 1); };
  const newTab = child.mount === 'root' ? `/?app=${encodeURIComponent(child.name)}&fs=1${path !== '/' ? `&path=${encodeURIComponent(path)}` : ''}` : target(path);
  const showBoot = !src || !loaded;

  return (
    <div className="flex h-full flex-col bg-bg" data-testid="viewer">
      {!full && (
        <header className="glass z-20 flex h-[52px] shrink-0 items-center gap-3 border-b border-line px-3">
          <button type="button" onClick={onBack} className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm font-semibold text-dim transition hover:bg-hover hover:text-ink" data-testid="back">← Catalog</button>
          <span className="h-5 w-px bg-line" />
          <div className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-[11px] font-black text-brand-ink" style={{ background: 'linear-gradient(135deg, var(--brand), var(--accent))' }}>{child.icon ?? monogram(child.title)}</div>
          <div className="min-w-0 leading-tight">
            <div className="truncate text-[14px] font-bold text-ink" data-testid="viewer-title">{child.title}</div>
            <div className="truncate font-mono text-[10.5px] text-muted">/apps/{child.name}{path === '/' ? '/' : path}</div>
          </div>
          <FrameworkBadge framework={child.framework} label={child.frameworkLabel} />
          {status && <StatusPill state={status.state} compact />}
          {status?.rssBytes != null && <span className="hidden font-mono text-[11px] text-muted lg:inline">{bytes(status.rssBytes)}</span>}
          <div className="ml-auto flex items-center gap-1.5">
            <IconButton title="Reload the app page" onClick={reload} testid="reload">↻ Reload</IconButton>
            <IconButton title="Restart the app process" onClick={restart} testid="restart">⟲ Restart</IconButton>
            <IconButton title="App output and install log" onClick={() => setDrawer(drawer === 'logs' ? null : 'logs')} active={drawer === 'logs'} testid="logs-btn">≣ Logs</IconButton>
            <IconButton title="How this app runs in the catalog" onClick={() => setDrawer(drawer === 'details' ? null : 'details')} active={drawer === 'details'} testid="details-btn">ⓘ Details</IconButton>
            <IconButton title="Open in a new tab" href={newTab} target="_blank" testid="newtab">↗</IconButton>
            <IconButton title="Full screen (Esc or the corner button to exit)" onClick={() => setFull(true)} testid="fullscreen">⤢</IconButton>
          </div>
        </header>
      )}
      <div className="relative min-h-0 flex-1">
        {src && (
          <iframe key={`${child.name}-${nonce}`} ref={frame} src={src} title={child.title} onLoad={() => setLoaded(true)}
            className={`absolute inset-0 h-full w-full border-0 bg-white transition-opacity duration-300 ${loaded ? 'opacity-100' : 'opacity-0'}`}
            allow="clipboard-read; clipboard-write; fullscreen; microphone; camera; geolocation" data-testid="frame" />
        )}
        {showBoot && <Boot child={child} status={status} elapsed={elapsed} onRetry={restart} onLogs={() => setDrawer('logs')} />}
        {full && (
          <button type="button" onClick={() => setFull(false)} title="Exit full screen" data-testid="exit-fullscreen"
            className="absolute right-3 top-3 z-40 rounded-full border border-line bg-raised/80 px-3 py-1.5 text-xs font-semibold text-ink opacity-40 shadow-lg transition hover:opacity-100">⤡ Catalog bar</button>
        )}
        {drawer === 'logs' && <LogsDrawer child={child} onClose={() => setDrawer(null)} />}
        {drawer === 'details' && <DetailsDrawer child={child} status={status} model={model} onClose={() => setDrawer(null)} />}
      </div>
    </div>
  );
}

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ChildState } from '../lib/api';
import { THEMES, applyTheme, currentTheme, type ThemeKey } from '../lib/theme';

/* ── Status: fixed status colours, ALWAYS with an icon and a text label ──── */
const STATUS: Record<ChildState, { label: string; tone: 'ok' | 'warn' | 'idle' | 'crit' | 'serious'; icon: 'live' | 'spin' | 'ring' | 'alert' }> = {
  running: { label: 'Running', tone: 'ok', icon: 'live' },
  starting: { label: 'Starting', tone: 'warn', icon: 'spin' },
  preparing: { label: 'Installing', tone: 'warn', icon: 'spin' },
  stopping: { label: 'Stopping', tone: 'idle', icon: 'spin' },
  stopped: { label: 'Asleep', tone: 'idle', icon: 'ring' },
  failed: { label: 'Failed', tone: 'crit', icon: 'alert' },
  crashed: { label: 'Crashed', tone: 'crit', icon: 'alert' },
  needs_build: { label: 'Needs build', tone: 'serious', icon: 'alert' },
};
const TONE_VAR = { ok: 'var(--ok)', warn: 'var(--warn)', idle: 'var(--idle)', crit: 'var(--crit)', serious: 'var(--serious)' } as const;

export function StatusPill({ state, compact = false, title }: { state: ChildState; compact?: boolean; title?: string }) {
  const s = STATUS[state] ?? STATUS.stopped;
  const color = TONE_VAR[s.tone];
  return (
    <span title={title} className={`inline-flex items-center gap-1.5 rounded-full border border-line bg-raised/80 ${compact ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-xs'} font-medium text-ink`} data-state={state}>
      {s.icon === 'live' && <span className="dot-live inline-block h-2 w-2 rounded-full" style={{ background: color }} aria-hidden />}
      {s.icon === 'ring' && <span className="inline-block h-2 w-2 rounded-full border-[1.5px]" style={{ borderColor: color }} aria-hidden />}
      {s.icon === 'spin' && <span className="spin inline-block h-2.5 w-2.5 rounded-full border-[1.5px] border-t-transparent" style={{ borderColor: color, borderTopColor: 'transparent' }} aria-hidden />}
      {s.icon === 'alert' && (
        <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden><path d="M6 1.2 11 10.4H1z" fill={color} /><rect x="5.35" y="4.3" width="1.3" height="3.4" rx=".6" fill="#fff" /><circle cx="6" cy="8.8" r=".75" fill="#fff" /></svg>
      )}
      {s.label}
    </span>
  );
}

/* ── Framework badge: neutral pill, the glyph carries identity ─────────────── */
const FW_GLYPH: Record<string, { color: string; glyph: string }> = {
  streamlit: { color: '#ff4b4b', glyph: '▲' }, gradio: { color: '#f97316', glyph: '◆' }, dash: { color: '#119dff', glyph: '◼' },
  shiny: { color: '#4f9fd8', glyph: '✦' }, flask: { color: '#9ca3af', glyph: '⚗' }, fastapi: { color: '#05998b', glyph: 'ϟ' },
  apx: { color: '#a78bfa', glyph: '⬢' }, python: { color: '#3776ab', glyph: '◒' }, node: { color: '#5fa04e', glyph: '⬡' },
  express: { color: '#5fa04e', glyph: '⬡' }, nextjs: { color: '#e5e7eb', glyph: 'N' }, unknown: { color: '#9ca3af', glyph: '?' },
};
export function FrameworkBadge({ framework, label }: { framework: string; label: string }) {
  const g = FW_GLYPH[framework] ?? FW_GLYPH.unknown;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-raised/85 px-2.5 py-1 text-[11px] font-semibold tracking-wide text-ink" data-framework={framework}>
      <span style={{ color: g.color }} aria-hidden>{g.glyph}</span>
      {label}
    </span>
  );
}

/* ── Brand + theme switcher: click the logo ──────────────────────────────── */
export function BrandMenu({ onTheme }: { onTheme?: (t: ThemeKey) => void }) {
  const [theme, setTheme] = useState<ThemeKey>(currentTheme);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', esc); };
  }, [open]);
  const t = THEMES[theme];
  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} title="Switch theme"
        className="flex items-center gap-3 rounded-xl p-1 pr-2 transition hover:bg-hover" data-testid="brand">
        <img src={t.logo} alt={t.label} className="h-9 w-9 rounded-[10px] object-cover shadow-sm" />
        <span className="text-left leading-tight">
          <span className="block text-[15px] font-bold tracking-tight text-ink">{t.brand} App Catalog</span>
          <span className="block text-[11px] text-muted">demos · showcases · prototypes</span>
        </span>
      </button>
      {open && (
        <div role="menu" className="fade-in absolute left-0 top-[52px] z-50 w-56 overflow-hidden rounded-xl border border-line bg-raised p-1.5 shadow-xl">
          <div className="px-2.5 pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-[.12em] text-muted">Theme</div>
          {(Object.keys(THEMES) as ThemeKey[]).map((k) => (
            <button key={k} role="menuitemradio" aria-checked={k === theme} type="button"
              onClick={() => { applyTheme(k); setTheme(k); onTheme?.(k); setOpen(false); }}
              className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-ink transition hover:bg-hover ${k === theme ? 'bg-hover' : ''}`}>
              <img src={THEMES[k].logo} alt="" className="h-6 w-6 rounded-md object-cover" />
              <span className="flex-1">{THEMES[k].label}</span>
              {k === theme && <span className="text-brand" aria-hidden>●</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function IconButton({ title, onClick, children, href, target, active, testid }: { title: string; onClick?: () => void; children: ReactNode; href?: string; target?: string; active?: boolean; testid?: string }) {
  const cls = `inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition ${active ? 'border-brand/60 bg-brand/15 text-ink' : 'border-line bg-raised text-dim hover:border-line-strong hover:text-ink'}`;
  if (href) return <a className={cls} href={href} target={target} rel={target ? 'noreferrer' : undefined} title={title} data-testid={testid}>{children}</a>;
  return <button type="button" className={cls} onClick={onClick} title={title} data-testid={testid}>{children}</button>;
}

/** Animated count-up for stat tiles; jumps straight to the value under reduced motion. */
export function CountUp({ value, decimals = 0 }: { value: number; decimals?: number }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { setShown(value); from.current = value; return; }
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / 700);
      const e = 1 - (1 - t) ** 3;
      setShown(a + (value - a) * e);
      if (t < 1) raf = requestAnimationFrame(tick); else from.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{shown.toFixed(decimals)}</>;
}

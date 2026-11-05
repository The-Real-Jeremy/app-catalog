import { useCallback, useEffect, useState } from 'react';
import type { CatalogModel, Child } from './lib/api';
import { getCatalog } from './lib/api';
import { Catalog, viewerHref } from './components/Catalog';
import { Viewer } from './components/Viewer';

function readRoute(): { app: string | null; path: string | null } {
  const q = new URLSearchParams(location.search);
  return { app: q.get('app'), path: q.get('path') };
}

export function App() {
  const [model, setModel] = useState<CatalogModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [route, setRoute] = useState(readRoute);

  const load = useCallback(() => getCatalog().then((m) => { setModel(m); setError(null); }).catch((e) => setError(String(e?.message ?? e))), []);

  useEffect(() => {
    load();
    // Poll while the tab is visible; the catalog is cheap to compute.
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(); }, route.app ? 10000 : 3000);
    return () => clearInterval(t);
  }, [load, route.app]);

  useEffect(() => {
    const onPop = () => setRoute(readRoute());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => { if (!route.app) document.title = 'App Catalog'; }, [route.app]);

  // Open a child in a NEW TAB (the catalog stays where it was); noopener so the child page
  // gets no handle on this window.
  const open = (c: Child) => {
    window.open(viewerHref(c), '_blank', 'noopener');
  };
  const back = () => {
    history.pushState({}, '', '/');
    setRoute({ app: null, path: null });
    load();
  };

  const child = route.app ? model?.children.find((c) => c.name === route.app) ?? null : null;
  if (route.app && child) return <Viewer key={child.name} child={child} model={model} initialPath={route.path} onBack={back} />;
  if (route.app && model && !child) {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div><div className="text-lg font-bold">No app called “{route.app}” in this catalog.</div><button type="button" onClick={back} className="mt-4 rounded-full bg-brand px-4 py-2 font-bold text-brand-ink">Open the catalog</button></div>
      </div>
    );
  }
  if (route.app && !model) return <div className="grid h-full place-items-center text-dim">{error ? `Could not load the catalog: ${error}` : 'Loading…'}</div>;
  return <Catalog model={model} error={error} onOpen={open} />;
}

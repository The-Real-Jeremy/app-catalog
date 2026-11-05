# Design — one Databricks App hosting many

## The problem
A team keeps many demo/showcase apps available 24×7. Each Databricks App bills for its compute
while running (a MEDIUM app meters **0.5 DBU/h** — measured from `system.billing.usage`:
26.996 DBU over 54 h for one app), so N always-on apps cost N × that.
Requirement: one app instance hosts them all; adding one = copy its repo into `child_apps/` and
redeploy, with no catalog config.

## Options considered

| option | verdict | why |
|---|---|---|
| Keep one app per demo | rejected | the cost being removed |
| Separate apps behind a catalog page / iframe | rejected | still N instances; the catalog adds cost |
| **In-process mounting**: one Python ASGI/WSGI server mounting every child app object at a sub-path | rejected | works only for apps that ARE an ASGI/WSGI object (not Streamlit, Gradio, Shiny, Node); one shared venv means version conflicts; two children with an `app.py` / `server` package collide on module names; one crash takes every demo down; each app needs code changes to expose its object |
| **Reverse proxy + one subprocess per child on localhost** | **chosen** | any framework the platform runs, each with its own command and environment; isolation by process and venv; lazy start / idle stop bounds memory; the child is unmodified |
| App Spaces / container-level orchestration | not available | App Spaces is a gated preview (Governed Vibe Coding PrPr); Apps gives one container, one port |

## How it works

```
browser ──► Databricks Apps proxy ──► catalog (node, :8000) ──► child processes (127.0.0.1:<port>)
                 OAuth, identity            routes, rewrites,        each with ITS OWN command,
                 headers, OBO token         lifecycle                env and venv
```

- **Discover** (`catalog/lib/discover.mjs`): reads each child's own files in the platform's order
  of authority — `databricks.yml` `source_code_path` → shallowest `app.yaml`/`app.yml` → folder;
  `command` → `npm run start` / `python <first .py>`; `env` (`value`, `valueFrom`); scopes and
  resources from `databricks.yml` + `app.yaml`; card text from the README. One module, used by the
  server, the container build step and the laptop deploy, so all three agree.
- **Prepare** (`prepare.mjs`, run by the platform's `npm run build` in the container): mirrors the
  platform per child — `npm install` → `pip install -r requirements.txt` (or `uv sync`) →
  `npm run build`, then, for a Python app with a `frontend/` (client/, ui/…) sub-project whose build
  output is missing, `npm ci` + `npm run build` there. Python children get their own venv whose `site-packages` comes first and a
  `.pth` that appends the **platform venv** (where the pre-installed Streamlit/Dash/Gradio/…
  live — measured at `<src>/.venv`), so "your pins override the defaults" holds per child and an
  app relying on a pre-installed package still finds it. Console scripts the child did not install
  (`uvicorn`, `streamlit` …) are re-pointed at the child's interpreter.
- **Supervise** (`supervisor.mjs`): a child starts on its first request (or Start), on a free
  localhost port. It gets the env the platform would give it standalone — the same
  `DATABRICKS_HOST/CLIENT_ID/SECRET` (the catalog's service principal), `DATABRICKS_APP_PORT`,
  `PORT`, `UVICORN_*`, `STREAMLIT_*`, `GRADIO_*`, `FLASK_RUN_*` pointed at its port, its own
  `app.yaml` env — plus absolute PATH (the platform's runtime PATH holds RELATIVE `.venv/bin`
  entries). A literal `--port 8000` / `--bind …:8000` in the command is rewritten (8000 is the
  catalog's). Idle children (no traffic, no open sockets for 30 min) stop; above 85% of the
  container's memory the least-recently-used idle child stops.
- **Proxy** (`proxy.mjs`): the request is streamed through with every header, including
  `x-forwarded-email/-user/-preferred-username` and the viewer's `x-forwarded-access-token`, so
  OBO code works unchanged; WebSockets are piped as raw sockets; SSE is unbuffered.

## Living under `/apps/<name>/` when the app thinks it owns `/`

| what breaks | handled by |
|---|---|
| root-relative links/assets in HTML (`/static/x.css`, `href="/report"`) | HTML rewriting (`rewrite.mjs`), also `srcset`, inline `style`, `<meta refresh>`, CSS `url()` |
| `fetch('/api')`, XHR, WebSocket, EventSource, `sendBeacon`, `window.open`, element `src/href` set from JS, `history.pushState` | the shim (`public/shim.js`), injected as the first `<script>` of every child page |
| `Location: /login` redirects | rewritten into the prefix |
| two children's `session` cookies colliding | `Set-Cookie` `Path=/` → `Path=/apps/<name>/` |
| anything that still escapes (e.g. a JS-built `location.href='/save'`) | routed back by the `Referer` (child page or the viewer `/?app=<name>`), then by a last-child cookie; a top-level navigation is redirected under the prefix |
| Streamlit | none needed: its frontend derives its base path from the URL |
| Dash / Gradio | `DASH_REQUESTS_PATHNAME_PREFIX` / `GRADIO_ROOT_PATH` set to the prefix |
| `X-Frame-Options` / `frame-ancestors` blanking the viewer frame | removed (same origin) |
| **client-side routers without a basename** (TanStack/React Router, Vue Router…) | **root mode** (auto when `package.json` has one): the shim removes the prefix from the address bar before the app boots, so the router sees `/…`, while network calls stay prefixed; such apps always open inside the catalog's viewer frame |

The catalog itself owns only `/`, `/_catalog/**` and `/apps/**`, so a child's `/assets/...` can
never collide with the catalog's own assets.

## Identity and permissions
A child runs as the **catalog's service principal** and, for OBO calls, with **the viewer's token**
(the platform mints it with the catalog's `user_api_scopes`). `scripts/deploy.mjs` binds the union
of every child's declared scopes and resources (warehouses, serving endpoints, Genie spaces …) to
the catalog, merged with what is already bound; anything a repo does not declare (UC grants,
Genie access for the people who demo) is granted to the catalog's SP by hand, as it would be for
a standalone app's.

## Deploy
`npm run deploy` (scripts/deploy.mjs): runs a child's own `databricks.yml` artifact build when its
app is a build output (e.g. apx), in a scratch copy; stages only each child's app root + metadata
(a repo's docs/decks never ship; files > 10 MB are refused); uploads changed files and prunes stale
ones; binds scopes/resources; deploys; then fails unless the RUNNING app reports this build id and
this code fingerprint. A deploy from the Apps UI also works (README "Teammate flow"): discovery and installs happen
in the container, including a Python app's `frontend/` build when its output is missing, but it skips
artifact builds (apx) and resource binding. A laptop deploy never prunes a child that exists only in the
workspace folder.

## Limits (known, not hidden)
- **One instance.** All children share 2 vCPU and 8 GB (MEDIUM, measured). One child pinning the
  CPU slows the others. Switch the catalog to LARGE (1 DBU/h, 4 vCPU/12 GB) if that bites.
- **Shared identity and state keys.** Every child has the same service principal and the same
  `DATABRICKS_APP_NAME` (the catalog's), so anything keyed on either is shared (e.g. state a child keeps in
  `/Users/<catalog SP>/...`). Children are processes of one user:
  not a security boundary between them.
- **Cold start.** A sleeping child wakes on first open: 4–7 s measured for four apps (FastAPI
  7.4 s, apx 6.6 s, stdlib Python 4.5 s, Node 4.2 s, all including the viewer's polling).
- **Root mode** (SPA routers): two root-mode apps open in two tabs can cross-talk on lazily loaded
  files; the address bar inside the frame shows `/…`.
- **A port hard-coded inside app code** (not in `app.yaml`) cannot be rewritten; the card reports
  the bind failure. `valueFrom` for Lakebase resources is not resolved (use an override).
- **Builds that need tooling** (apx needs `bun`) run on the deploying laptop, not in the container.
- **Per-user OAuth consent**: adding a scope to the catalog means each viewer re-consents once.

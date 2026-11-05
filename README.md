# App Catalog

## Install (browser only: no terminal, no CLI, works air-gapped)

1. On this GitHub page: **Code → Download ZIP** (`app-catalog-main.zip`). No need to unzip it.
2. In Databricks: **Workspace** → open your home folder → **⋮ → Import** → drop the `.zip` → **Import**.
   Databricks unzips it into a folder `app-catalog-main/`. Importing the .zip is the documented way to
   bring in a folder of mixed files.
3. Open **`app-catalog-main/DEPLOY`**, attach **Serverless**, and click **Run all**. Set the `app_name`
   widget first if you want a name other than `app-catalog`.
4. The last cell prints the **app URL**. Open it. `<url>/_catalog/api/health` shows `"offline": true`
   and each child's install state.

**If the notebook stops with "Unable to use fallback policies"** (your workspace requires a budget policy on new
apps): paste the policy id into the `budget_policy_id` widget and Run all again. The notebook prints the ids it can
see in use, and uses the only one automatically. Or create the app in the UI first (**Compute → Apps → Create app →
Custom**, the same name, pick the policy, add the user-authorization scope **`sql`**), then Run all: the notebook
finds the app and only deploys.

The notebook creates the app if it does not exist, adds the scopes its children declare, deploys from
the folder it sits in, and waits. Offline mode is on by default: children install only from files in
the repo (vendored wheels, a shipped `node_modules/`, prebuilt frontends). Re-run it after adding or
removing a child. To add a child app from its own repo, import that repo's ZIP next to this folder and
run that repo's `DEPLOY` notebook.

---

**One Databricks App that hosts many apps.** Each app is a folder in [`child_apps/`](child_apps/),
a straight copy of that app's own repo. The catalog finds it at start-up, shows it as a card, and
runs it on demand inside the same app instance, so twenty demos cost what one does.

- How it works and why: [docs/DESIGN.md](docs/DESIGN.md)
- Air-gapped workspaces (no PyPI, npm or internet): [docs/AIRGAP.md](docs/AIRGAP.md)

---

## Add an app (the whole procedure)

```bash
# 1. copy the app's repo in (without its .git) — the folder name becomes its URL: /apps/<folder>/
rsync -a --exclude .git ~/code/my-demo/ child_apps/my_demo/    # lowercase letters, digits, _ or -

# 2. deploy the catalog
DATABRICKS_CONFIG_PROFILE=<profile> npm run deploy             # = node scripts/deploy.mjs

# 3. open the catalog — the new card is there; click it
```

That is all. **Nothing in the catalog needs editing.** The catalog reads your app the way Databricks
Apps itself would:

| it needs | it reads, in this order |
|---|---|
| where the app is | `databricks.yml` `source_code_path` → the shallowest `app.yaml`/`app.yml` → the folder itself |
| how to start it | `app.yaml` `command` → `npm run start` (if `package.json`) → `python <first .py>` |
| its settings | `app.yaml` `env` (`value` and `valueFrom`) |
| its packages | `requirements.txt` (or `pyproject.toml` + `uv.lock`), `package.json`, installed into **its own** environment at deploy time |
| OBO scopes / resources | `databricks.yml` `user_api_scopes` + `resources`, `app.yaml` `user_authorization` + `resources` |
| the card | `README.md` first heading + paragraph (or `databricks.yml` description) |

### What your app must already do (the same as any Databricks App)
- **Listen on the port it is given**: `DATABRICKS_APP_PORT` / `PORT`, or the framework's own variable
  (`STREAMLIT_SERVER_PORT`, `GRADIO_SERVER_PORT`, `UVICORN_PORT`, `FLASK_RUN_PORT`). A literal
  `--port 8000` (or `${DATABRICKS_APP_PORT:-8000}`) in the `app.yaml` command is rewritten for
  you. A port hard-coded *inside your code* is not (8000 belongs to the catalog), and the card says so.
- **Declare its packages** in `requirements.txt` / `package.json`. The platform's pre-installed
  libraries (Streamlit, Dash, Gradio, Flask, FastAPI, Shiny, databricks-sdk, pandas…) are there
  too, exactly as standalone, and your pins win over them.
- **Keep files under 10 MB** in the app's folder (a Databricks Apps limit; the deploy names any offender).

### Identity
A child runs as the **catalog app's service principal** (`DATABRICKS_CLIENT_ID/SECRET` are the
catalog's) and, for on-behalf-of calls, with **the viewer's own token**. Those are the two identities
it had standalone, with a different service principal. `npm run deploy` binds the scopes and
resources your repo **declares** to the catalog app (the union of every child's; nothing is ever
unbound). Anything else (UC grants, Genie access, a secret scope) you grant to the catalog app's
service principal, as you would for a standalone app.

### Per-deployment settings
To keep a child's copy byte-identical to its repo, put this deployment's values in
[`catalog.overrides.yaml`](catalog.overrides.yaml):

```yaml
my_demo:                 # the folder name
  env:
    DB_WAREHOUSE_ID: <warehouse id>
  resources:             # replaces what the app declares
    - name: sql_warehouse
      sql_warehouse: { id: <warehouse id>, permission: CAN_USE }
```

Optional card/behaviour settings (in the child's own `catalog.yaml`, or under its name in
`catalog.overrides.yaml`): `title`, `description`, `icon`, `accent`, `order`, `category`
(`starter` puts it under *Framework starters*), `hidden`, `keep_warm`, `idle_minutes`,
`mount` (`prefix` | `root`), `app_dir`, `command`, `source`, `user_api_scopes`, `vendor_node_modules`.

## UI-only flow (no laptop tooling)
1. Put the app's folder in `<app source folder>/child_apps/<name>/` (Workspace import, a Git folder,
   or `databricks workspace import-dir`). Leave out `node_modules/`, `.venv/` and files over 10 MB.
2. Compute → Apps → the catalog → **Deploy**. Discovery and installs run in the container.
3. To remove an app, delete its folder and Deploy. Its card and URL go away, and nothing is left running.

| the child… | UI deploy is enough? |
|---|---|
| Python or Node app, packages in `requirements.txt` / `package.json` at its app root | **yes** |
| has its frontend build output committed (e.g. `frontend/dist/`) | **yes** |
| has a `frontend/` with a `build` script and no built output | **yes**: built in the container, **if** its lockfile resolves to a registry the container can reach |
| an apx / `databricks.yml` artifact build | **no**: needs bun locally. Use `npm run deploy`, or ship the built `.build/` |
| needs a resource the catalog does not have yet | **one admin step**: add it to the app (Edit → App resources), or `npm run deploy` once |

`npm run deploy` keeps children that exist only in the workspace folder. It never prunes them
unless you pass `--prune-remote-children`.

## Frameworks
Every framework Databricks Apps supports runs here; the `starter_*` folders are live, copyable examples.

| framework | example | what the catalog does for it |
|---|---|---|
| Streamlit | `starter_streamlit` | websocket proxied; its frontend finds its base path itself |
| Dash | `starter_dash` | sets `DASH_REQUESTS_PATHNAME_PREFIX` so callbacks stay under the prefix |
| Gradio | `starter_gradio` | sets `GRADIO_ROOT_PATH` so its API URLs stay under the prefix |
| Flask | `starter_flask` | rewrites `Location` headers, cookie paths and root-relative links |
| FastAPI / uvicorn | `starter_fastapi` | rewrites the hard-coded `--port 8000`; WebSocket + SSE proxied |
| Shiny for Python | `starter_shiny` | websocket proxied; hard-coded port rewritten |
| Node.js / Express | `starter_express` | ships `node_modules/` (offline); online it runs `npm install`, then the command |
| React SPA with a client-side router | (any) | **root mode**: the app sees `/` in its address bar (see DESIGN) |
| apx (FastAPI + React) | (any) | `npm run deploy` runs its `databricks.yml` build (`uv run apx build`, needs bun) |

## Run it
```bash
npm run deploy                      # build children that need it, upload, bind, deploy, verify
node scripts/deploy.mjs --dry-run   # show what would change
npm run build:ui                    # rebuild the catalog UI (client/ -> catalog/ui, committed)
scripts/build_airgap_packages.sh <child> …    # air-gapped install packages (docs/AIRGAP.md)

# local: a laptop copy of the platform's Python + pre-installed libraries, then the server
bash scripts/dev-platform-venv.sh
CATALOG_PORT=8790 CATALOG_PLATFORM_PYTHON=$PWD/.catalog/platform-venv/bin/python npm start
```

Tunable in `app.yaml` env:
- `CATALOG_IDLE_MINUTES` (default 30): an app with no traffic and no open sockets for that long is stopped.
- `CATALOG_MEMORY_HIGH_PCT` (85): above this share of the container's memory, the least-recently-used idle app is stopped.
- `CATALOG_START_TIMEOUT_S` (180) and `CATALOG_BUILD_CONCURRENCY` (3).
- `CATALOG_OFFLINE` / `CATALOG_WHEELHOUSE`: air-gapped installs.

## Layout
```
app.yaml, package.json      the master app (zero npm dependencies)
catalog/server.mjs          routing, catalog API, proxy wiring
catalog/lib/                discover · prepare · offline · supervisor · proxy · rewrite · workspace
catalog/public/shim.js      URL shim injected into every child page
catalog/ui/                 built catalog UI (source in client/)
child_apps/                 one folder per app (copied repos, untouched)
catalog.overrides.yaml      optional, per-deployment settings
scripts/deploy.mjs          the one deploy command
setup/airgap/               installer notebook + UI steps for air-gapped workspaces
```

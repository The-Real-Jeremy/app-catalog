# App-ception

## Install (browser only: no terminal, no CLI, works air-gapped)

1. On this GitHub page: **Code → Download ZIP** (`app-ception-main.zip`). No need to unzip it.
2. In Databricks: **Workspace** → open your home folder → **⋮ → Import** → drop the `.zip` → **Import**.
   Databricks unzips it into a folder `app-ception-main/`. Importing the .zip is the documented way to
   bring in a folder of mixed files.
3. Open **`app-ception-main/DEPLOY`**, attach **Serverless**, and click **Run all**. Set the `app_name`
   widget first if you want a name other than `app-ception`.
4. The last cell prints the **app URL**. Open it. `<url>/_catalog/api/health` shows `"offline": true`
   and each child's install state.

**If the notebook stops with "Unable to use fallback policies"** (your workspace requires a budget policy on new
apps): paste the policy id into the `budget_policy_id` widget and Run all again. The notebook prints the ids it can
see in use, and uses the only one automatically (the app then bills against that policy; set
`budget_policy_id` to choose explicitly). Or create the app in the UI first (**Compute → Apps → Create app →
Custom**, the same name, pick the policy, add the user-authorization scope **`sql`**), then Run all: the notebook
finds the app and only deploys.

The notebook creates the app if it does not exist, adds the scopes its children declare, deploys from
the folder it sits in, and waits. Offline mode is on by default: children install only from files in
the repo (vendored wheels, a shipped `node_modules/`, prebuilt frontends). Re-run it after adding or
removing a child.

**To update the catalog** to a newer ZIP: first **rename or delete the existing `app-ception-main/` folder**.
Importing a ZIP onto a folder that already exists is refused ("already exists"). Then import the new ZIP, run
`DEPLOY`, and re-run each child's `DEPLOY` (mode `child`), because the children copied into the old folder are
not in the new one. To add a child app from its own repo, import that repo's ZIP next to this folder and
run that repo's `DEPLOY` notebook.

**Renamed from "App Catalog".** The old GitHub URLs redirect here. An existing install keeps
working:
- `DEPLOY` finds an existing app named `app-catalog` and deploys to it, keeping the same URL and grants.
- The child `DEPLOY`s find an `app-catalog-main/` folder.
- The old `CATALOG_*` settings still apply, as aliases of `APPCEPTION_*`.

To update an existing install to this code: rename the old `app-catalog-main/` folder aside, import this ZIP
(it becomes `app-ception-main/`), run `DEPLOY`, then re-run each child's `DEPLOY`. To move to the new app name
as well: set `app_name = app-ception`. That creates a new app with a new URL and a new service principal, so
re-grant its access, then stop the old app.

---

**One Databricks App that hosts many apps.** Each app is a folder in [`child_apps/`](child_apps/),
a straight copy of that app's own repo. The catalog finds it at start-up, shows it as a card, and
runs it on demand inside the same app instance, so twenty demos cost what one does.

- How it works and why: [docs/DESIGN.md](docs/DESIGN.md)
- Air-gapped workspaces (no PyPI, npm or internet): [docs/AIRGAP.md](docs/AIRGAP.md)

---

## Add any app as a child (browser only)

Each child is a folder in `app-ception-main/child_apps/`. **The folder name is its URL**,
`/apps/<folder>/`: use lowercase letters, digits, `_` or `-`.

### A) Its repo has a `DEPLOY` notebook (e.g. dbsql-monitor, hello-isaac, spin-wheel)
1. GitHub: **Code → Download ZIP**.
2. Workspace: open **the folder that holds `app-ception-main/`** → **⋮ → Import** → drop the `.zip`.
3. Open `<repo>-main/DEPLOY`, leave **mode = `child`**, attach Serverless, and click **Run all**. It
   copies the app into `child_apps/`, adds the scopes it needs to the catalog app, and redeploys the
   catalog.

### B) Any other app, by hand (no notebook)
1. **Get its files.**
   - An app with a repo: GitHub **Download ZIP**.
   - An app that was deployed by a script (a bundle or the CLI): Compute → Apps → that app shows
     its **source code path**. That folder holds what the app runs, including anything the script
     built. Get those files as a `.zip`: from wherever the script deployed them from, or by downloading
     the folder (Workspace → the folder → ⋮ → Download), checking that the download contains the
     app's files and not only notebooks.
2. **Put them in `child_apps/`.** Workspace → `app-ception-main/child_apps/` → **⋮ → Import** →
   drop the `.zip`. It unzips into `child_apps/<zip name>/` (a GitHub ZIP gives `<repo>-main/`);
   rename the folder for a nicer URL. Single files can also be dragged into that dialog.
3. **Deploy:** Compute → Apps → the catalog app → **Deploy**. The new card appears; open it.
4. **To remove it**, delete its folder and Deploy. Its card and URL go away, and nothing is left running.

### Checklist before you add an app
1. **Its packages must install here.** With offline mode on (the default from `DEPLOY`), every line
   of its `requirements.txt` must either be pre-installed by the Apps runtime or have a wheel (linux
   x86_64, CPython 3.11). Put wheels in a `wheels/` folder inside the app, or in the catalog's
   `APPCEPTION_WHEELHOUSE` volume; `scripts/vendor_wheels.sh` downloads them on any connected machine.
   - Node packages ship in `node_modules/` (pure-JS, or built for linux x64).
   - A frontend ships its built output (`dist/`). Nothing is built in an offline workspace.
   - A script-deployed app's own build output is in its source folder. The packages the platform
     installed for it are **not**, so check this item even for an app that already runs standalone.
2. **Scopes and resources go on the catalog app**, before you deploy: Compute → Apps → the catalog →
   Edit → User authorization / App resources. A scope added later can take minutes to reach viewers.
   - A copied source folder has no `databricks.yml`, so scopes and resources declared only there
     are not seen.
   - An `env` entry with `valueFrom: <resource>` needs a resource of that name on the catalog app,
     or set its value in `catalog.overrides.yaml`.
3. **It runs under `/apps/<folder>/`.** The catalog rewrites links, redirects, cookie paths and
   `fetch`/XHR/WebSocket URLs. Apps with a client-side router run in "root mode" when the router is
   visible in a `package.json`; for a folder of built files only, add a `catalog.yaml` with
   `mount: root`. The app must listen on `DATABRICKS_APP_PORT`: a port hard-coded in its code fails,
   while one written in its `app.yaml` command is rewritten for you.
4. **It runs as the catalog's identity.** The service principal is the catalog app's (and the
   viewer's own token for on-behalf-of calls), so grant UC tables, warehouses, Genie spaces and
   secrets to the **catalog app's service principal**. State the app kept under its old service
   principal's home folder does not come with it, and `DATABRICKS_APP_NAME` is the catalog's.
5. **No file over 10 MB** (a Databricks Apps limit, and the Workspace Import limit too).

### How the catalog reads an app
It reads an app the way Databricks Apps itself would. Nothing in the catalog needs editing.

| it needs | it reads, in this order |
|---|---|
| where the app is | `databricks.yml` `source_code_path` → the shallowest `app.yaml`/`app.yml` → the folder itself |
| how to start it | `app.yaml` `command` → `npm run start` (if `package.json`) → `python <first .py>` |
| its settings | `app.yaml` `env` (`value` and `valueFrom`) |
| its packages | `requirements.txt` (or `pyproject.toml` + `uv.lock`), `package.json`, installed into **its own** environment at deploy time |
| OBO scopes / resources | `databricks.yml` `user_api_scopes` + `resources`, `app.yaml` `user_authorization` + `resources` |
| the card | `README.md` first heading + paragraph (or `databricks.yml` description) |

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

### CLI path (optional, for developers with a terminal and the Databricks CLI)
```bash
rsync -a --exclude .git ~/code/my-demo/ child_apps/my_demo/    # on your machine, in a clone of this repo
DATABRICKS_CONFIG_PROFILE=<profile> npm run deploy             # = node scripts/deploy.mjs
```
`npm run deploy` also does these:
- runs an apx / `databricks.yml` artifact build (needs bun);
- binds the scopes and resources each child **declares** to the catalog app;
- uploads, deploys, and checks the running app.

It keeps children that exist only in the workspace folder, and never prunes them unless you pass
`--prune-remote-children`.

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
CATALOG_PORT=8790 APPCEPTION_PLATFORM_PYTHON=$PWD/.catalog/platform-venv/bin/python npm start
```

Tunable in `app.yaml` env:
- `APPCEPTION_IDLE_MINUTES` (default 30): an app with no traffic and no open sockets for that long is stopped.
- `APPCEPTION_MEMORY_HIGH_PCT` (85): above this share of the container's memory, the least-recently-used idle app is stopped.
- `APPCEPTION_START_TIMEOUT_S` (180) and `APPCEPTION_BUILD_CONCURRENCY` (3).
- `APPCEPTION_OFFLINE` / `APPCEPTION_WHEELHOUSE`: air-gapped installs.

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

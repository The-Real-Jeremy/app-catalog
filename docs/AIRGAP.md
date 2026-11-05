# Air-gapped install

**The catalog runs in a workspace with no internet egress.** The master app makes no external call
at build or runtime. Children install offline from wheels shipped with them or kept on a UC volume.
Measured 2026-11-05 on a workspace whose index and registry were switched off by flags
(`--no-index`, `UV_OFFLINE`, `npm --offline`). That workspace still had egress, so a truly
egress-less workspace is the final test.

Settings are `APPCEPTION_*` environment variables in `app.yaml`. The pre-rename `CATALOG_*` names are still read as
aliases, and `APPCEPTION_*` wins.

## Audit: every external fetch

| where | what | verdict | fix |
|---|---|---|---|
| master build | platform `npm install` (zero dependencies) | OK. Completes against an unreachable registry | none |
| master build | `npm run build` → `catalog/build.mjs` (node only) | OK | none |
| master runtime | catalog UI, shim, fonts | OK. 0 external hosts in the served HTML/JS/CSS; fonts self-hosted | none |
| master runtime | workspace API (`/oidc/v1/token`, `/api/2.0/apps/<self>`, Files API) | OK. In-workspace, not internet | none |
| child build | `pip install -r requirements.txt` | needs egress unless offline mode | `APPCEPTION_OFFLINE=1` + wheels (below) |
| child build | `npm install` / frontend `npm run build` | needs a registry | ship `node_modules/` (`vendor_node_modules: true`) or built `dist/` |
| child build | apx / `databricks.yml` artifact build | needs bun + PyPI | build on a connected machine (`build_airgap_packages.sh` runs it) |
| child runtime | CDN scripts/fonts/map tiles in a child's own UI | child-specific | vendor them into the child |
| child runtime | model serving / Foundation Model APIs | child-specific | only if the workspace has them |

The starters in `child_apps/` need nothing beyond what the runtime pre-installs (Gradio may try a
font CDN and falls back).

## What the Apps runtime pre-installs (measured, CPython 3.11.18)
fastapi 0.115.0, uvicorn 0.30.6, pydantic 2.13.4, orjson 3.11.9, httpx 0.28.1, cachetools 5.5.2,
python-multipart 0.0.30, python-dotenv 1.2.2, plus streamlit / dash / gradio / flask / shiny.
databricks-sdk is older than 0.74, and pydantic-settings is absent. In offline mode, a requirement
line the pre-installed set satisfies is skipped; every other line needs a wheel.

## Install with no CLI, PyPI or npm
On a connected machine: `scripts/build_airgap_packages.sh <child> …` → `dist/airgap/`: the catalog
zip, one zip per child, the installer notebook, `README.txt` (the UI steps) and SHA256SUMS. In the
air-gapped workspace:
1. Upload the zips to a UC volume you can write to. Import `install_appception.py` as a notebook.
2. Run the notebook once per zip, the catalog first. It checks every sha256, keeps old copies as
   `.bak-<time>`, writes the app into a `/Workspace/...` folder, copies wheels to a volume folder
   and sets `APPCEPTION_WHEELHOUSE`. It took 26–42 s per zip on serverless.
3. Apps → Create app → Edit → App resources → **UC volume** (the wheelhouse), *Can read*. Add the
   user-authorization scopes your children declare **before** the first deploy. Then Deploy from
   the folder.

A workspace import of a `.zip` (folder ⋮ → Import) **does** extract it into a folder, which is how the
whole repo arrives in one step; see the README's Install section and `DEPLOY`. (An earlier note said it did
not: that test imported to a path without the `.zip` suffix.)

## Where a child's packages come from
- the pre-installed libraries, which need nothing;
- `wheels/` inside the child (`scripts/vendor_wheels.sh <child>/wheels -r requirements.txt`);
- the shared volume wheelhouse. An Apps container cannot mount `/Volumes`, so the catalog copies the
  wheels in over the Files API at build time as its service principal. The volume must be an app
  resource with *Can read*.

Wheels must be linux x86_64, CPython 3.11 (`vendor_wheels.sh` asks for exactly that). A missing
wheel fails fast, naming the package; it never hangs on a network timeout.

## Evidence (2026-11-05)
- **Fresh folder + empty wheelhouse:** the notebook ran once per zip, then a plain Deploy. Health
  showed `offline: true` and 3/3 children ready, answering their APIs.
- **A FastAPI child with its own `wheels/`:** humanize came from the child venv, orjson from the platform.
- **An apx app (FastAPI + React) whose four pins are all newer than the pre-installed copies:**
  29 packages installed from 28 wheels on the volume.
- **Vendored `node_modules/`:** served. Without it, the child fails fast and says what to ship.
- **Negative control:** an unvendored package fails with "tabulate was not found in the provided
  package locations".

# Databricks notebook source
# MAGIC %md
# MAGIC # Deploy the App Catalog (browser only)
# MAGIC
# MAGIC 1. On GitHub: **Code → Download ZIP** (`app-catalog-main.zip`).
# MAGIC 2. In the workspace: open a folder (e.g. your home) → **⋮ → Import** → drop the .zip. Databricks unzips it into `app-catalog-main/`.
# MAGIC 3. Open `app-catalog-main/DEPLOY` (this notebook), attach **Serverless**, **Run all**.
# MAGIC
# MAGIC It deploys the app from the folder this notebook is in: it creates the app if needed, sets the scopes its children
# MAGIC declare, deploys, waits, and prints the URL. It needs no CLI, pip or npm; only the Databricks SDK that the
# MAGIC notebook already has. Re-run it after adding or removing a child app.

# COMMAND ----------

dbutils.widgets.text("app_name", "app-catalog", "1. App name")
dbutils.widgets.dropdown("offline", "true", ["true", "false"], "2. Offline installs (no PyPI/npm)")
dbutils.widgets.text("wheelhouse_volume_dir", "", "3. Optional wheelhouse /Volumes/... folder")
dbutils.widgets.text("extra_scopes", "sql", "4. Scopes to set up front (comma-separated)")
APP = dbutils.widgets.get("app_name").strip()
OFFLINE = dbutils.widgets.get("offline") == "true"
WHEELHOUSE = dbutils.widgets.get("wheelhouse_volume_dir").strip().rstrip("/")
# Scopes for children you will add LATER (e.g. sql for DBSQL Monitor): a scope added to an existing app can
# take a while to reach viewers' tokens, so give the app the ones you expect from the start.
EXTRA_SCOPES = {s.strip() for s in dbutils.widgets.get("extra_scopes").split(",") if s.strip()}
assert APP and APP.replace("-", "").isalnum() and APP == APP.lower(), "app name: lowercase letters, digits and '-'"
assert not WHEELHOUSE or WHEELHOUSE.startswith("/Volumes/"), "the wheelhouse must be a /Volumes/<catalog>/<schema>/<volume>/... folder"

import os, re, time, json
ctx = dbutils.notebook.entry_point.getDbutils().notebook().getContext()
SRC = "/Workspace" + os.path.dirname(ctx.notebookPath().get())
assert os.path.isfile(f"{SRC}/app.yaml") and os.path.isfile(f"{SRC}/catalog/server.mjs"), \
    f"{SRC} does not look like the app-catalog folder (no app.yaml / catalog/server.mjs next to this notebook)"
print("source folder:", SRC)

# COMMAND ----------

# Offline mode and the optional wheelhouse are app.yaml env (an app has no other way to get env).
y = open(f"{SRC}/app.yaml").read()
def set_env(text, name, value):
    block = f'  - name: {name}\n    value: "{value}"\n'
    pat = re.compile(rf'  - name: {re.escape(name)}\n    value: "?[^\n]*"?\n')
    return pat.sub(block, text) if pat.search(text) else text.rstrip() + "\n" + block
y2 = set_env(y, "CATALOG_OFFLINE", "1" if OFFLINE else "0")
if WHEELHOUSE:
    y2 = set_env(y2, "CATALOG_WHEELHOUSE", WHEELHOUSE)
if y2 != y:
    open(f"{SRC}/app.yaml", "w").write(y2)
print("CATALOG_OFFLINE =", "1" if OFFLINE else "0", "| CATALOG_WHEELHOUSE =", WHEELHOUSE or "(none: wheels come from each child's own wheels/ folder)")

# The user-authorization scopes every child declares (databricks.yml user_api_scopes, app.yaml
# user_authorization.scopes, catalog.yaml user_api_scopes). Set BEFORE deploying: a scope added later
# can take a while to reach viewers' tokens.
def scopes_in(path):
    try:
        t = open(path).read()
    except OSError:
        return set()
    out = set()
    for m in re.finditer(r"(?:user_api_scopes|scopes)\s*:\s*\n((?:\s+-\s*[A-Za-z0-9._:-]+\s*\n?)+)", t):
        out |= set(re.findall(r"-\s*([A-Za-z0-9._:-]+)", m.group(1)))
    return out
SCOPES = set()
children = sorted(d for d in os.listdir(f"{SRC}/child_apps") if os.path.isdir(f"{SRC}/child_apps/{d}") and not d.startswith((".", "_")))
for c in children:
    for f in ("databricks.yml", "app.yaml", "app/app.yaml", "catalog.yaml"):
        SCOPES |= scopes_in(f"{SRC}/child_apps/{c}/{f}")
SCOPES |= EXTRA_SCOPES
print("children:", ", ".join(children))
print("scopes they declare:", sorted(SCOPES) or "none")

# COMMAND ----------

from databricks.sdk import WorkspaceClient
from databricks.sdk.errors import NotFound
w = WorkspaceClient()
api = w.api_client
DEFAULT_SCOPES = {"iam.access-control:read", "iam.current-user:read"}

def get_app():
    try:
        return api.do("GET", f"/api/2.0/apps/{APP}")
    except NotFound:
        return None

def wait_compute(states, minutes=15):
    for _ in range(minutes * 12):
        a = get_app()
        st = (a.get("compute_status") or {}).get("state")
        if st in states:
            return a
        time.sleep(5)
    raise TimeoutError(f"compute of {APP} did not reach {states}; last {st}")

app = get_app()
if app is None:
    print(f"creating app {APP} …")
    api.do("POST", "/api/2.0/apps", body={"name": APP, "description": "App Catalog: one Databricks App that hosts many apps.",
                                          "user_api_scopes": sorted(SCOPES)})
    app = wait_compute({"ACTIVE", "STOPPED", "ERROR"})
have = set(app.get("user_api_scopes") or []) - DEFAULT_SCOPES
resources = list(app.get("resources") or [])
vol_res = None
if WHEELHOUSE:
    full = ".".join(WHEELHOUSE.split("/")[2:5])
    if not any((r.get("uc_securable") or {}).get("securable_full_name") == full for r in resources):
        vol_res = {"name": "wheelhouse", "description": "shared wheelhouse for child installs",
                   "uc_securable": {"securable_type": "VOLUME", "securable_full_name": full, "permission": "READ_VOLUME"}}
        resources.append(vol_res)
if not SCOPES <= have or vol_res:
    app = wait_compute({"ACTIVE", "STOPPED", "ERROR"})
    body = {"name": APP, "description": app.get("description", ""), "user_api_scopes": sorted(have | SCOPES), "resources": resources}
    for k in ("budget_policy_id", "usage_policy_id"):
        if app.get(k):
            body[k] = app[k]
    api.do("PATCH", f"/api/2.0/apps/{APP}", body=body)   # a full replacement: everything already bound is kept
    print("app updated: scopes", sorted(have | SCOPES), "| resources", [r.get("name") for r in resources])
else:
    print("app already has the scopes", sorted(have) or "(none needed)")

# COMMAND ----------

app = get_app()
if (app.get("compute_status") or {}).get("state") != "ACTIVE":
    print("starting compute …")
    try:
        api.do("POST", f"/api/2.0/apps/{APP}/start", body={})
    except Exception as e:  # already starting
        print("  start:", str(e)[:120])
    app = wait_compute({"ACTIVE"})
print(f"deploying {SRC} → {APP} …")
dep = api.do("POST", f"/api/2.0/apps/{APP}/deployments", body={"source_code_path": SRC, "mode": "SNAPSHOT"})
t0 = time.time()
while True:
    d = api.do("GET", f"/api/2.0/apps/{APP}/deployments/{dep['deployment_id']}")
    st = (d.get("status") or {}).get("state")
    if st not in ("IN_PROGRESS", "PENDING", None):
        break
    if time.time() - t0 > 25 * 60:
        raise TimeoutError("deployment still running after 25 min: check Compute → Apps → this app → Logs")
    time.sleep(10)
msg = (d.get("status") or {}).get("message")
print(f"deployment {dep['deployment_id']}: {st} — {msg} ({time.time() - t0:.0f}s)")
assert st == "SUCCEEDED", "deployment failed: open Compute → Apps → this app → Logs"

# COMMAND ----------

app = get_app()
url = app.get("url")
print("app status :", (app.get("app_status") or {}).get("state"), "-", (app.get("app_status") or {}).get("message"))
print("APP URL    :", url)
print("HEALTH     :", f"{url}/_catalog/api/health   (open it in the browser: \"offline\": %s, every child \"prepare\": \"ready\")" % str(OFFLINE).lower())
# Ask the running app itself, with this notebook's token (the Apps proxy may refuse it; the browser link above always works).
try:
    import urllib.request
    req = urllib.request.Request(f"{url}/_catalog/api/health", headers={"Authorization": f"Bearer {ctx.apiToken().get()}"})
    with urllib.request.urlopen(req, timeout=60) as r:
        h = json.loads(r.read())
    print("\nhealth from the running app: offline =", h.get("offline"))
    for c in h.get("children", []):
        print(f"  {c['name']:<28} {c.get('prepare')}  {'; '.join(c.get('problems') or [])}")
except Exception as e:
    print("\n(the app could not be queried from this notebook:", str(e)[:120], "— open the HEALTH link in your browser)")

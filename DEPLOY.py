# Databricks notebook source
# MAGIC %md
# MAGIC # Deploy App-ception (browser only)
# MAGIC
# MAGIC 1. On GitHub: **Code → Download ZIP** (`app-ception-main.zip`).
# MAGIC 2. In the workspace: open a folder (e.g. your home) → **⋮ → Import** → drop the .zip. Databricks unzips it into `app-ception-main/`.
# MAGIC 3. Open `app-ception-main/DEPLOY` (this notebook), attach **Serverless**, **Run all**.
# MAGIC
# MAGIC It deploys the app from the folder this notebook is in: it creates the app if needed, sets the scopes its children
# MAGIC declare, deploys, waits, and prints the URL. It needs no CLI, pip or npm; only the Databricks SDK that the
# MAGIC notebook already has. Re-run it after adding or removing a child app.

# COMMAND ----------

dbutils.widgets.text("app_name", "app-ception", "1. App name")
dbutils.widgets.dropdown("offline", "true", ["true", "false"], "2. Offline installs (no PyPI/npm)")
dbutils.widgets.text("wheelhouse_volume_dir", "", "3. Optional wheelhouse /Volumes/... folder")
dbutils.widgets.text("extra_scopes", "sql", "4. Scopes to set up front (comma-separated)")
dbutils.widgets.text("budget_policy_id", "", "5. Budget policy id, if your workspace requires one")
dbutils.widgets.dropdown("use_existing_app_catalog", "yes", ["yes", "no"], "6. Reuse a pre-rename app-catalog app if present")
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
# A ZIP import can still be unzipping when Run all starts: wait until the file count here stops changing.
# Count through the Workspace API: the notebook's /Workspace file view can lag the import by minutes.
from databricks.sdk import WorkspaceClient as _WC
_wsapi = _WC().workspace
def _nfiles(p):
    return sum(_nfiles(o.path) if o.object_type.value == "DIRECTORY" else 1 for o in _wsapi.list(p))
_n, _t0, _since = _nfiles(SRC[len("/Workspace"):]), time.time(), time.time()
print(f"checking the import is complete: {_n} files", flush=True)
while time.time() - _since < 20 and time.time() - _t0 < 180:
    time.sleep(5)
    _m = _nfiles(SRC[len("/Workspace"):])
    if _m != _n:
        _n, _since = _m, time.time()
        print(f"  still importing: {_n} files …", flush=True)
print(f"import complete: {_n} files" if time.time() - _since >= 20 else f"still changing after 3 min ({_n} files); carrying on")
assert os.path.isfile(f"{SRC}/app.yaml") and os.path.isfile(f"{SRC}/catalog/server.mjs"), \
    f"{SRC} does not look like the App-ception folder (no app.yaml / catalog/server.mjs next to this notebook)"
print("source folder:", SRC)

# COMMAND ----------

# Offline mode and the optional wheelhouse are app.yaml env (an app has no other way to get env).
y = open(f"{SRC}/app.yaml").read()
def set_env(text, name, value):
    block = f'  - name: {name}\n    value: "{value}"\n'
    pat = re.compile(rf'  - name: {re.escape(name)}\n    value: "?[^\n]*"?\n')
    return pat.sub(block, text) if pat.search(text) else text.rstrip() + "\n" + block
y2 = set_env(y, "APPCEPTION_OFFLINE", "1" if OFFLINE else "0")
if WHEELHOUSE:
    y2 = set_env(y2, "APPCEPTION_WHEELHOUSE", WHEELHOUSE)
if y2 != y:
    open(f"{SRC}/app.yaml", "w").write(y2)
print("APPCEPTION_OFFLINE =", "1" if OFFLINE else "0", "| APPCEPTION_WHEELHOUSE =", WHEELHOUSE or "(none: wheels come from each child's own wheels/ folder)")

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

# ── Budget / usage policies ──────────────────────────────────────────────────────────────────────────
# A workspace can require every serverless resource (including an app) to name a budget policy; then a
# create without one fails with "Unable to use fallback policies, please manually select a policy".
# Policies are account objects with no workspace list API, so the candidates are the policy ids already
# in use on apps and jobs you can see.
POLICY_ERR = "fallback polic"

def policy_candidates():
    ids = {}
    try:
        tok = None
        while True:
            r = api.do("GET", "/api/2.0/apps", query={"page_size": 100, **({"page_token": tok} if tok else {})})
            for a in r.get("apps", []):
                for k in ("budget_policy_id", "effective_budget_policy_id"):
                    if a.get(k):
                        ids.setdefault(a[k], set()).add(f"app {a['name']}")
            tok = r.get("next_page_token")
            if not tok:
                break
    except Exception as e:
        print("  (could not list apps:", str(e)[:100], ")")
    try:
        r = api.do("GET", "/api/2.1/jobs/list", query={"limit": 100})
        for j in r.get("jobs", []):
            for k in ("budget_policy_id", "effective_budget_policy_id"):
                v = j.get(k) or (j.get("settings") or {}).get(k)
                if v:
                    ids.setdefault(v, set()).add(f"job {(j.get('settings') or {}).get('name', j.get('job_id'))}")
    except Exception as e:
        print("  (could not list jobs:", str(e)[:100], ")")
    return ids

def keep_policy(a, body):
    """A PATCH is a full replacement: carry the app's policy over, or the update falls back and fails."""
    for k, eff in (("budget_policy_id", "effective_budget_policy_id"), ("usage_policy_id", "effective_usage_policy_id")):
        v = a.get(k) or a.get(eff)
        if v:
            body[k] = v
    return body

def create_app(name, description, scopes, policy_id):
    body = {"name": name, "description": description, "user_api_scopes": sorted(scopes)}
    if policy_id:
        body["budget_policy_id"] = policy_id
    try:
        api.do("POST", "/api/2.0/apps", body=body)
        return
    except Exception as e:
        if POLICY_ERR not in str(e) or policy_id:
            raise
        print("This workspace requires a budget policy on new apps. Looking for the ones in use …")
    cands = policy_candidates()
    for pid, users in cands.items():
        print(f"  {pid}   used by: {', '.join(sorted(users))[:120]}")
    if len(cands) == 1:
        pid = next(iter(cands))
        print("Exactly one policy is in use; using it:", pid)
        body["budget_policy_id"] = pid
        api.do("POST", "/api/2.0/apps", body=body)
        return
    raise RuntimeError(
        "Pick a budget policy: paste one of the ids above into the budget_policy_id widget and Run all again, "
        "OR create the app in the UI (Compute → Apps → Create app → Custom, name '" + name + "', choose the policy, "
        "add the user-authorization scopes " + (", ".join(sorted(scopes)) or "(none)") + ") and Run all again.")

def add_scopes(name, a, scopes):
    """Best effort: add missing scopes to an existing app, keeping its policy and resources."""
    have = set(a.get("user_api_scopes") or []) - DEFAULT_SCOPES
    if scopes <= have:
        return True
    body = keep_policy(a, {"name": name, "description": a.get("description", ""),
                           "user_api_scopes": sorted(have | scopes), "resources": a.get("resources") or []})
    try:
        api.do("PATCH", f"/api/2.0/apps/{name}", body=body)
        print(f"{name}: scopes now {sorted(have | scopes)}")
        return True
    except Exception as e:
        print(f"Could not add the scopes {sorted(scopes - have)} to {name} ({str(e)[:140]}).\n"
              f"Add them in the UI: Compute → Apps → {name} → Edit → User authorization → + Add scope. "
              "Deploying anyway; the app works once the scope is there.")
        return False


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
if app is None and APP == "app-ception" and dbutils.widgets.get("use_existing_app_catalog") == "yes":
    # Renamed from "App Catalog": an install made before the rename has an app named app-catalog. Keep using it
    # (same URL, same service principal and its grants) rather than silently creating a second app.
    try:
        old = api.do("GET", "/api/2.0/apps/app-catalog")
    except NotFound:
        old = None
    if old:
        APP = "app-catalog"
        app = old
        print("Found the pre-rename app 'app-catalog': deploying to it (same URL and grants).\n"
              "  To move to the new name instead: set use_existing_app_catalog = no and Run all. That creates a NEW app\n"
              "  'app-ception' (new URL and service principal: re-grant its access); then stop app-catalog under Compute → Apps.")
if app is None:
    print(f"creating app {APP} …")
    create_app(APP, "App-ception: one Databricks App that hosts many apps.", SCOPES, dbutils.widgets.get("budget_policy_id").strip())
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
    body = keep_policy(app, {"name": APP, "description": app.get("description", ""), "user_api_scopes": sorted(have | SCOPES), "resources": resources})
    try:   # a full replacement: everything already bound, and the app's policy, are kept
        api.do("PATCH", f"/api/2.0/apps/{APP}", body=body)
        print("app updated: scopes", sorted(have | SCOPES), "| resources", [r.get("name") for r in resources])
    except Exception as e:
        print(f"Could not update {APP} ({str(e)[:140]}).\nAdd the scopes {sorted(SCOPES - have)} in the UI: Compute → Apps → {APP} → Edit → "
              "User authorization → + Add scope. Deploying anyway.")
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
# Starting a STOPPED app redeploys its last build, and a new deployment is refused while that runs.
for _try in range(60):
    try:
        dep = api.do("POST", f"/api/2.0/apps/{APP}/deployments", body={"source_code_path": SRC, "mode": "SNAPSHOT"})
        break
    except Exception as e:
        if "deployment in progress" not in str(e) or _try == 59:
            raise
        print(f"  the app is still finishing its previous deployment; retrying in 20 s ({_try + 1}/60) …", flush=True)
        time.sleep(20)
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
        raw = r.read().decode("utf-8", "replace")
    # the Apps proxy may answer the notebook's token with a sign-in page (status 200, HTML): not health data
    if not raw.lstrip().startswith("{"):
        raise ValueError("the app answered with a sign-in page, not health JSON")
    h = json.loads(raw)
    print("\nhealth from the running app: offline =", h.get("offline"))
    for c in h.get("children", []):
        print(f"  {c['name']:<28} {c.get('prepare')}  {'; '.join(c.get('problems') or [])}")
except Exception as e:
    print("\n(the app could not be queried from this notebook:", str(e)[:120], "— open the HEALTH link in your browser)")

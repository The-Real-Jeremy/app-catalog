# Databricks notebook source
# MAGIC %md
# MAGIC # Install the App-ception, or a child app into it (air-gapped)
# MAGIC
# MAGIC One notebook for every package: `app-ception.zip` (the catalog itself) and `child-<name>.zip`
# MAGIC (one child app). Run it on any compute that can read the volume and write your workspace folder. Nothing
# MAGIC here contacts the internet. It:
# MAGIC 1. checks the zip against its `MANIFEST.json` (sha256 of every file);
# MAGIC 2. **catalog**: moves an existing install aside (`<install_dir>.bak-<time>`), writes the new one and
# MAGIC    carries the existing `child_apps/` over; **child**: writes `<install_dir>/child_apps/<name>/`, moving
# MAGIC    an older copy of that child aside first. Nothing is deleted;
# MAGIC 3. copies the package's `wheelhouse/` into `wheelhouse_dir` (a UC volume) and, for the catalog, points
# MAGIC    the app's `APPCEPTION_WHEELHOUSE` at it.
# MAGIC
# MAGIC Then **Deploy** the app (Compute → Apps → app-ception → Deploy). See README.txt for first-time setup.

# COMMAND ----------

dbutils.widgets.text("package_zip", "/Volumes/<catalog>/<schema>/<volume>/app-ception.zip", "1. Package zip")
dbutils.widgets.text("install_dir", "/Workspace/Users/<you>/apps/app-ception", "2. Catalog folder (app source)")
dbutils.widgets.text("wheelhouse_dir", "/Volumes/<catalog>/<schema>/<volume>/catalog_wheelhouse", "3. Wheelhouse folder (volume)")
W = {k: dbutils.widgets.get(k).strip().rstrip("/") for k in ["package_zip", "install_dir", "wheelhouse_dir"]}
for k, v in W.items():
    assert "<" not in v, f"set the {k} widget (it still has a placeholder): {v}"
assert W["install_dir"].startswith("/Workspace/"), "install_dir must be a /Workspace/... folder"
assert W["wheelhouse_dir"].startswith("/Volumes/"), "wheelhouse_dir must be a /Volumes/... folder"
print(W)

# COMMAND ----------

import hashlib, json, os, shutil, tempfile, time, zipfile

work = tempfile.mkdtemp(prefix="app-ception-install-")
local_zip = os.path.join(work, "package.zip")
shutil.copyfile(W["package_zip"], local_zip)
with zipfile.ZipFile(local_zip) as z:
    z.extractall(os.path.join(work, "b"))
B = os.path.join(work, "b")
man = json.load(open(os.path.join(B, "MANIFEST.json")))
bad = [rel for rel, m in man["files"].items()
       if hashlib.sha256(open(os.path.join(B, rel), "rb").read()).hexdigest() != m["sha256"]]
assert not bad, f"{len(bad)} file(s) do not match the manifest, e.g. {bad[:3]} — re-copy the zip"
kind, name = man["kind"], man.get("name")
payload = "app" if kind == "catalog" else f"child/{name}"
n_payload = sum(r.startswith(payload + "/") for r in man["files"])
n_whl = sum(r.startswith("wheelhouse/") for r in man["files"])
print(f"{kind} package {name or ''} build {man['build']}: {len(man['files'])} files verified ({n_payload} app files, {n_whl} wheels)")

# A .py that starts with "# Databricks notebook source" becomes a NOTEBOOK when written to /Workspace.
nb = [r for r in man["files"] if r.startswith(payload + "/") and r.endswith(".py")
      and open(os.path.join(B, r), "rb").read(64).startswith(b"# Databricks notebook source")]
assert not nb, f"these files would turn into notebooks in /Workspace: {nb[:5]}"

def move_aside(path):
    if not os.path.exists(path):
        return None
    bak = f"{path}.bak-{time.strftime('%Y%m%d-%H%M%S')}"
    os.rename(path, bak)
    for _ in range(30):                      # /Workspace FUSE: the old path lingers for a few seconds
        if not os.path.exists(path):
            break
        time.sleep(1)
    print(f"previous copy kept at {bak}")
    return bak

def count(path):
    return sum(len(fs) for _, _, fs in os.walk(path))

# COMMAND ----------

if kind == "catalog":
    dest = W["install_dir"]
    old = move_aside(dest)
    shutil.copytree(os.path.join(B, "app"), dest)
    written = count(dest)
    assert written == n_payload, f"{written} files in {dest}, manifest has {n_payload}"
    # keep the children that were installed into the previous catalog
    kept = []
    if old and os.path.isdir(os.path.join(old, "child_apps")):
        os.makedirs(os.path.join(dest, "child_apps"), exist_ok=True)
        for c in sorted(os.listdir(os.path.join(old, "child_apps"))):
            src = os.path.join(old, "child_apps", c)
            if os.path.isdir(src) and not os.path.exists(os.path.join(dest, "child_apps", c)):
                shutil.copytree(src, os.path.join(dest, "child_apps", c)); kept.append(c)
    p = os.path.join(dest, "app.yaml")
    y = open(p).read()
    key = 'name: APPCEPTION_WHEELHOUSE\n    value: ""'
    assert key in y, "app.yaml has no empty APPCEPTION_WHEELHOUSE entry to fill"
    open(p, "w").write(y.replace(key, f'name: APPCEPTION_WHEELHOUSE\n    value: "{W["wheelhouse_dir"]}"'))
    print(f"catalog: wrote {written}/{n_payload} files to {dest}; children carried over: {kept or 'none'}")
else:
    assert os.path.isfile(os.path.join(W["install_dir"], "catalog", "server.mjs")), \
        f"{W['install_dir']} is not a catalog install — install app-ception.zip first"
    dest = os.path.join(W["install_dir"], "child_apps", name)
    old = move_aside(dest)
    if old:  # keep the backup OUT of child_apps, or the catalog would discover it as an app
        os.rename(old, os.path.join(W["install_dir"], f".bak-child-{os.path.basename(old)}"))
    shutil.copytree(os.path.join(B, "child", name), dest)
    written = count(dest)
    assert written == n_payload, f"{written} files in {dest}, manifest has {n_payload}"
    print(f"child {name}: wrote {written}/{n_payload} files to {dest}")

# COMMAND ----------

os.makedirs(W["wheelhouse_dir"], exist_ok=True)
copied = 0
whl_src = os.path.join(B, "wheelhouse")
for n in sorted(os.listdir(whl_src)) if os.path.isdir(whl_src) else []:
    s, d = os.path.join(whl_src, n), os.path.join(W["wheelhouse_dir"], n)
    if os.path.exists(d) and os.path.getsize(d) == os.path.getsize(s):
        continue
    shutil.copyfile(s, d); copied += 1
have = sorted(n for n in os.listdir(W["wheelhouse_dir"]) if n.endswith(".whl"))
print(f"wheelhouse {W['wheelhouse_dir']}: {len(have)} wheels ({copied} copied now)")
shutil.rmtree(work, ignore_errors=True)
print("Done. Now: Compute -> Apps -> app-ception -> Deploy (source code path: " + W["install_dir"] + ")")

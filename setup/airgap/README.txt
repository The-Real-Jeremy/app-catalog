APP-CEPTION - AIR-GAPPED INSTALL (no CLI, no PyPI, no npm, no internet)

Files (from scripts/build_airgap_packages.sh)
  app-ception.zip           the catalog app (offline mode already on)
  child-<name>.zip          one per child app, with the Python wheels it needs
  install_appception.py        installer notebook, used for every zip
  SHA256SUMS                checksums of the above

You need: a UC volume you can WRITE to, permission to create an app, and a cluster (DBR 15.4 is
fine) or serverless to run one notebook. Below, <V> = /Volumes/<catalog>/<schema>/<volume>.

1. UPLOAD
   Catalog Explorer -> <catalog> -> <schema> -> <volume> -> "Upload to this volume":
   upload all the .zip files.
   Workspace -> your home folder -> (kebab menu) Import -> File -> install_appception.py.

2. INSTALL THE CATALOG + CHILDREN (one notebook, run once per zip)
   Open install_catalog, attach compute, set the three widgets, then Run all:
     package_zip    = <V>/app-ception.zip
     install_dir    = /Workspace/Users/<you>/apps/app-ception
     wheelhouse_dir = <V>/catalog_wheelhouse
   Then run it again once per child zip (package_zip = <V>/child-<name>.zip). Keep install_dir and
   wheelhouse_dir the same. Each run prints "... N/N files" and the wheel count. Any error stops the run, and
   nothing is deleted (old copies are kept as .bak-<time>).

3. CREATE THE APP (first time only)
   Compute -> Apps -> Create app -> Create a custom app -> name: app-ception -> Create.
   Then Edit (or Configure):
     App resources     -> + Add resource -> Unity Catalog volume -> the volume <V> -> Can read
                          (the app copies the child apps' wheels from it at deploy time)
     User authorization -> + Add scope -> whatever your children declare (e.g. sql)
   Save. Add the scope BEFORE the first deploy: a scope added later can take a while to appear
   in viewers' tokens.
   No environment variables to set; app.yaml already has APPCEPTION_OFFLINE=1 and the wheelhouse path.

4. DEPLOY
   Apps -> app-ception -> Deploy -> source code path:
     /Workspace/Users/<you>/apps/app-ception
   Wait for "App started successfully" (2-5 min; children install offline during the build).

5. CHECK
   Open the app URL: one card per child.
   <app URL>/_catalog/api/health must show "offline": true, every child "prepare": "ready",
   and the wheelhouse wheels. First open of a child takes ~5 s (it starts on demand).
   Each viewer is asked once to allow the app's scopes (if any).

LATER
  Add a child:     upload its zip, run the notebook with it, Deploy.
  Remove a child:  delete <install_dir>/child_apps/<name> in the workspace, Deploy.
  Update the catalog itself: run the notebook with the new app-ception.zip (children carry
                   over), Deploy.
  A child built elsewhere: its Python wheels must be linux x86_64 / Python 3.11, either in a
  wheels/ folder inside the child or in <V>/catalog_wheelhouse. If a wheel is missing, the card
  names the package.

#!/bin/bash
# Build the air-gapped install packages, on a connected machine:
#   dist/airgap/app-catalog.zip          the catalog (no children), CATALOG_OFFLINE=1
#   dist/airgap/child-<name>.zip         one child each: its app + the wheels it needs
#   dist/airgap/install_catalog.py       the installer notebook (handles both kinds)
#   dist/airgap/README.txt               the UI steps
#
#   scripts/build_airgap_packages.sh <child> [child ...]    (folder names under child_apps/)
#
# Every package is leak-scanned and the build fails on a hit. The generic patterns below catch
# workspace hosts and tokens; put anything specific to YOUR environment (workspace ids, service
# principal ids, emails) one regex per line in a file OUTSIDE the repo and point
# LEAK_PATTERNS_FILE at it, so the repo never ships the identifiers it hunts for.
set -euo pipefail
cd "$(dirname "$0")/.."
KIDS=("$@"); [ ${#KIDS[@]} -gt 0 ] || { sed -n "2,13p" "$0"; exit 2; }
OUT=dist/airgap
SHA=$(git rev-parse --short HEAD)$(git diff --quiet -- catalog scripts setup child_apps && echo "" || echo -dirty)
export PY=${PY:-$PWD/.catalog/platform-venv/bin/python}
rm -rf "$OUT"; mkdir -p "$OUT"
WORK=$(mktemp -d /tmp/app-catalog-pkg.XXXX)

leakscan() {  # fail if a workspace host, token or (via LEAK_PATTERNS_FILE) a site identifier survived
  local hits extra=()
  [ -n "${LEAK_PATTERNS_FILE:-}" ] && extra=(-f "$LEAK_PATTERNS_FILE")
  hits=$(grep -rIl -E -e '[a-z0-9-]+\.cloud\.databricks\.com|[a-z0-9-]+\.azuredatabricks\.net|[a-z0-9-]+\.databricksapps\.com|dapi[0-9a-f]{20}|eyJ[A-Za-z0-9_-]{20,}\.' "${extra[@]}" "$1" || true)
  if [ -n "$hits" ]; then echo "LEAK SCAN FAILED in $1:"; echo "$hits"; exit 1; fi
}
manifest() {  # $1 dir, $2 kind, $3 name
  python3 - "$1" "$2" "$3" "$SHA" <<'PY'
import hashlib, json, os, sys
root, kind, name, sha = sys.argv[1:5]
files = {}
for d, _, ns in os.walk(root):
    for n in ns:
        p = os.path.join(d, n); rel = os.path.relpath(p, root)
        files[rel] = {"sha256": hashlib.sha256(open(p, "rb").read()).hexdigest(), "bytes": os.path.getsize(p)}
big = [k for k, v in files.items() if v["bytes"] > 10 * 1024 * 1024 and not k.startswith("wheelhouse/")]
if big: sys.exit(f"files over 10 MB: {big}")
json.dump({"kind": kind, "name": name or None, "build": sha, "files": files}, open(os.path.join(root, "MANIFEST.json"), "w"), indent=1)
print(f"  {kind} {name}: {len(files)} files ({sum(k.startswith('wheelhouse/') for k in files)} wheels)")
PY
}
zipit() { (cd "$1" && zip -qr "$2" .); }

# ── 1. the catalog itself ────────────────────────────────────────────────────
C=$WORK/catalog; mkdir -p "$C"
node scripts/deploy.mjs --stage-dir "$C/app" --only none >/dev/null
cat > "$C/app/catalog.overrides.yaml" <<'EOF'
# Optional per-child settings for THIS deployment, keyed by child folder name (see README).
{}
EOF
python3 - "$C/app/app.yaml" <<'PY'
import sys
p = sys.argv[1]; t = open(p).read().rstrip() + "\n"
t += ('  # Air-gapped: never contact a package index or registry (catalog/lib/offline.mjs).\n'
      '  - name: CATALOG_OFFLINE\n    value: "1"\n'
      '  # Set by install_catalog.py to the volume folder holding the child apps\' wheels.\n'
      '  - name: CATALOG_WHEELHOUSE\n    value: ""\n')
open(p, "w").write(t)
PY
rm -f "$C/app/catalog/BUILD_ID"; echo "airgap-$SHA" > "$C/app/catalog/BUILD_ID"
leakscan "$C"; manifest "$C" catalog ""; zipit "$C" "$PWD/$OUT/app-catalog.zip"

# ── 2. one package per child ─────────────────────────────────────────────────
for k in "${KIDS[@]}"; do
  S=$WORK/stage-$k; P=$WORK/child-$k; mkdir -p "$P/child" "$P/wheelhouse"
  node scripts/deploy.mjs --stage-dir "$S" --only "$k" >/dev/null
  mv "$S/child_apps/$k" "$P/child/$k"
  D=$P/child/$k
  # wheels for whatever its requirements need (the catalog skips what the runtime pre-installs)
  req=$(find "$D" -maxdepth 2 -name requirements.txt | head -1)
  if [ -n "$req" ]; then (cd "$(dirname "$req")" && bash "$OLDPWD/scripts/vendor_wheels.sh" "$P/wheelhouse" -r requirements.txt | tail -1); fi
  # a wheel the child ships for itself (an apx app's own wheel) stays in its folder
  for w in "$D"/.build/*.whl; do [ -e "$w" ] && rm -f "$P/wheelhouse/$(basename "$w")"; done
  leakscan "$P/child"; manifest "$P" child "$k"; zipit "$P" "$PWD/$OUT/child-$k.zip"
done

cp setup/airgap/install_catalog.py "$OUT/install_catalog.py"
cp setup/airgap/README.txt "$OUT/README.txt"
leakscan "$OUT/install_catalog.py"; leakscan "$OUT/README.txt"
(cd "$OUT" && shasum -a 256 *.zip install_catalog.py README.txt > SHA256SUMS)
ls -la "$OUT"
rm -rf "$WORK"

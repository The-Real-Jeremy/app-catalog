#!/bin/bash
# Download the wheels a child app needs, built for the Databricks Apps runtime
# (linux x86_64, CPython 3.11), on a CONNECTED machine — for an air-gapped catalog
# (APPCEPTION_OFFLINE=1). Put the result in the child's wheels/ folder, or upload it
# to the shared wheelhouse volume (APPCEPTION_WHEELHOUSE).
#
#   scripts/vendor_wheels.sh <out_dir> -r <requirements.txt>     # everything a child lists
#   scripts/vendor_wheels.sh <out_dir> 'humanize==4.*' orjson     # named packages
#
# Downloads the full dependency closure: the catalog drops lines the platform's
# pre-installed libraries already satisfy, but a vendored package's own dependencies
# must resolve from wheels too. Binary wheels only (an sdist would need a compiler and
# an index at install time). Uses this machine's own pip index configuration.
# PY= overrides the interpreter that runs pip.
set -euo pipefail
[ $# -ge 2 ] || { sed -n '2,12p' "$0"; exit 2; }
out=$1; shift
mkdir -p "$out"
PY=${PY:-python3}
"$PY" -m pip download --disable-pip-version-check --only-binary=:all: \
  --platform manylinux2014_x86_64 --platform manylinux_2_17_x86_64 --platform manylinux_2_28_x86_64 --platform any \
  --python-version 3.11 --implementation cp --abi cp311 --abi abi3 --abi none \
  -d "$out" "$@"
n=$(ls "$out"/*.whl 2>/dev/null | wc -l | tr -d ' ')
big=$(find "$out" -name '*.whl' -size +10M | wc -l | tr -d ' ')
echo "vendor_wheels: $n wheel(s) in $out ($(du -sh "$out" | cut -f1))${big:+; $big over 10 MB}"

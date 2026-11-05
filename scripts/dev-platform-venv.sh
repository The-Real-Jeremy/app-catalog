#!/usr/bin/env bash
# Local emulation of the Databricks Apps PLATFORM venv, so children run on a laptop
# with the same Python and the same pre-installed libraries they get in the container.
#
# Versions are the ones MEASURED in the container (2026-10-14,
# `pip list` from the platform .venv), which match docs.databricks.com
# "dependencies" -> "Pre-installed Python libraries". Point the catalog at it with
#   APPCEPTION_PLATFORM_PYTHON=.catalog/platform-venv/bin/python
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="$ROOT/.catalog/platform-venv"
mkdir -p "$ROOT/.catalog"
uv venv --python 3.11 "$VENV"
uv pip install --python "$VENV/bin/python" \
  "databricks-sql-connector==3.4.0" "databricks-sdk==0.33.0" "mlflow-skinny==2.16.2" \
  "gradio==4.44.0" "streamlit==1.38.0" "shiny==1.1.0" "dash==2.18.1" "flask==3.0.3" \
  "fastapi==0.115.0" "uvicorn[standard]==0.30.6" "gunicorn==23.0.0" "huggingface-hub==0.35.3" \
  "dash-ag-grid==31.2.0" "dash-mantine-components==0.14.4" "dash-bootstrap-components==1.6.0" \
  "plotly==5.24.1" "plotly-resampler==0.10.0" "pandas==2.2.3" "numpy==1.26.4" "pyarrow==16.1.0" \
  "pip==24.0"
echo "platform venv ready: $VENV/bin/python"

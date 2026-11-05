#!/usr/bin/env python3
"""Run one SQL statement on a warehouse via the Statement Execution API (stdlib only).
Usage: SQL_TOKEN=... SQL_HOST=https://... python3 sql.py <warehouse_id> "<sql>"
Prints JSON {status, columns, rows}. Never prints the token. A non-SUCCEEDED state is
reported as such, never as an empty result."""
import json, os, sys, time, urllib.request

host, tok = os.environ["SQL_HOST"].rstrip("/"), os.environ["SQL_TOKEN"]
wh, stmt = sys.argv[1], sys.argv[2]

def call(method, path, body=None):
    req = urllib.request.Request(host + path, method=method, data=json.dumps(body).encode() if body else None,
                                 headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)

r = call("POST", "/api/2.0/sql/statements", {"warehouse_id": wh, "statement": stmt, "wait_timeout": "50s", "on_wait_timeout": "CONTINUE", "format": "JSON_ARRAY", "disposition": "INLINE"})
t0 = time.time()
while r["status"]["state"] in ("PENDING", "RUNNING") and time.time() - t0 < 600:
    time.sleep(2)
    r = call("GET", f"/api/2.0/sql/statements/{r['statement_id']}")
st = r["status"]
cols = [c["name"] for c in r.get("manifest", {}).get("schema", {}).get("columns", [])]
print(json.dumps({"status": st["state"], "error": st.get("error", {}).get("message"), "columns": cols, "rows": r.get("result", {}).get("data_array", [])}))

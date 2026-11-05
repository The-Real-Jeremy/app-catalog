"""Flask starter for the App-ception (pre-installed Flask, `flask run`).

Exercises what a path prefix breaks in a server-rendered app: url_for links,
static files, a form POST, a redirect (Location header) and a session cookie.
"""
import os

from flask import Flask, redirect, render_template, request, session, url_for

app = Flask(__name__)
app.secret_key = os.environ.get("FLASK_SECRET", "starter-not-secret")


@app.get("/")
def index():
    return render_template("index.html", name=session.get("name"), viewer=request.headers.get("X-Forwarded-Preferred-Username"),
                           base=os.environ.get("APPCEPTION_BASE_PATH", os.environ.get("CATALOG_BASE_PATH", "/")))


@app.post("/greet")
def greet():
    session["name"] = (request.form.get("name") or "").strip()[:40] or None
    return redirect(url_for("index"))


@app.get("/api/ping")
def ping():
    return {"ok": True, "path_seen_by_flask": request.path}

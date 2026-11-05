"""FastAPI starter for the App-ception.

Its command hard-codes --port 8000, as many standalone apps do; the catalog
rewrites that to the child's own port. The page checks the three transports
that matter behind a proxy: a JSON fetch, a WebSocket and Server-Sent Events.
`humanize` comes from requirements.txt (the child's own venv); FastAPI and
uvicorn come from the platform's pre-installed libraries.
"""
import asyncio
import datetime as dt
import os

import humanize
from fastapi import FastAPI, Request, WebSocket
from fastapi.responses import HTMLResponse, StreamingResponse

app = FastAPI(title="FastAPI starter")
STARTED = dt.datetime.now(dt.timezone.utc)

PAGE = """<!doctype html><html><head><meta charset="utf-8"><title>FastAPI starter</title>
<style>body{margin:0;font:15px/1.5 system-ui,sans-serif;background:#0f1420;color:#e8edf5}main{max-width:700px;margin:48px auto;padding:0 24px}
.row{display:flex;justify-content:space-between;border-bottom:1px solid #232b3b;padding:10px 0}.ok{color:#0ca30c}.bad{color:#d03b3b}.dim{color:#a6b0c3}</style></head>
<body><main><h1>FastAPI starter</h1><p class="dim">__WHO__ · up __UP__ · base __BASE__</p>
<div class="row"><span>fetch /api/hello</span><b id="f" class="dim">…</b></div>
<div class="row"><span>WebSocket /ws</span><b id="w" class="dim">…</b></div>
<div class="row"><span>Server-Sent Events /api/stream</span><b id="s" class="dim">…</b></div>
<p><a style="color:#6ea3f9" href="/docs">OpenAPI docs</a></p></main>
<script>
const set=(id,ok,t)=>{const e=document.getElementById(id);e.textContent=t;e.className=ok?'ok':'bad'};
fetch('/api/hello').then(r=>r.json()).then(j=>set('f',true,j.message)).catch(e=>set('f',false,String(e)));
const ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws');
ws.onopen=()=>ws.send('ping');ws.onmessage=e=>set('w',true,e.data);ws.onerror=()=>set('w',false,'failed');
let n=0;const es=new EventSource('/api/stream');es.onmessage=e=>{n++;set('s',true,'tick '+e.data+' ('+n+' received)');if(n>=3)es.close()};es.onerror=()=>{if(n<3)set('s',false,'failed')};
</script></body></html>"""


@app.get("/", response_class=HTMLResponse)
def page(request: Request):
    who = request.headers.get("x-forwarded-preferred-username") or "there"
    up = humanize.naturaldelta(dt.datetime.now(dt.timezone.utc) - STARTED)
    return PAGE.replace("__WHO__", f"Hello {who}").replace("__UP__", up).replace("__BASE__", os.environ.get("APPCEPTION_BASE_PATH", os.environ.get("CATALOG_BASE_PATH", "/")))


@app.get("/api/hello")
def hello():
    return {"message": f"hello from FastAPI (humanize {humanize.__version__})"}


@app.websocket("/ws")
async def ws(socket: WebSocket):
    await socket.accept()
    msg = await socket.receive_text()
    await socket.send_text(f"pong to {msg!r}")
    await socket.close()


@app.get("/api/stream")
async def stream():
    async def gen():
        for i in range(1, 4):
            yield f"data: {i}\n\n"
            await asyncio.sleep(0.4)
    return StreamingResponse(gen(), media_type="text/event-stream")

#!/usr/bin/env node
/**
 * QA control daemon: ONE headed Chrome (own profile, own port — never a pool slot, never
 * --headless), ONE long-lived CDP session to ONE page, with a workspace bearer header on
 * every request, so a deployed Databricks App can be driven like a viewer with no SSO.
 *
 * Why a daemon: the extra header lives only as long as the CDP session; a connect-per-command
 * driver lets the page's own later fetches go out unauthenticated. The Apps proxy down-scopes the
 * forwarded token to the app's user_api_scopes, so on-behalf-of behaviour is the viewer's.
 * State plainly in any write-up: auth was a bearer header, not an SSO cookie.
 *
 *   node scripts/qa/cdpd.mjs &                 # starts Chrome + control server on 127.0.0.1:9378
 *   curl -s localhost:9378/nav -d '{"url":"https://…/"}'
 *   curl -s localhost:9378/eval -d '{"expr":"document.title"}'
 *   curl -s localhost:9378/shot -d '{"path":"/abs/file.png"}'
 *   curl -s localhost:9378/log                 # console + exceptions + failed requests since last /mark
 *   curl -s localhost:9378/mark                # start a new log window
 *   curl -s localhost:9378/quit
 * The token is minted by the CLI inside this process and never printed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { writeFileSync, rmSync } from 'node:fs';

const PROFILE = process.env.QA_PROFILE || process.env.DATABRICKS_CONFIG_PROFILE || 'DEFAULT';
const CDP_PORT = 9377;
const CTL_PORT = 9378;
const DIR = '/tmp/app-catalog-qa-chrome';
const W = 1512;
const H = 982;

function token() {
  const r = spawnSync('databricks', ['auth', 'token', '--profile', PROFILE], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`token: ${r.stderr.slice(0, 200)}`);
  return JSON.parse(r.stdout).access_token;
}
let TOKEN = token();
let tokenAt = Date.now();

rmSync(DIR, { recursive: true, force: true });
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  `--user-data-dir=${DIR}`, `--remote-debugging-port=${CDP_PORT}`, '--no-first-run', '--no-default-browser-check',
  `--window-size=${W},${H + 120}`, '--window-position=40,40', 'about:blank',
], { stdio: 'ignore', detached: false });

async function cdpUrl() {
  for (let i = 0; i < 60; i += 1) {
    try { return (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json()).webSocketDebuggerUrl; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error('chrome did not open its debugging port');
}
const ws = new WebSocket(await cdpUrl());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
let log = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) rej(new Error(JSON.stringify(msg.error))); else res(msg.result);
    return;
  }
  const p = msg.params ?? {};
  if (msg.method === 'Fetch.requestPaused') {
    let host = '';
    try { host = new URL(p.request.url).host; } catch { /* data: etc. */ }
    const sid = msg.sessionId;
    if (APP_HOST_RE.test(host)) {
      const headers = Object.entries(p.request.headers).filter(([k]) => k.toLowerCase() !== 'authorization').map(([name, value]) => ({ name, value }));
      headers.push({ name: 'Authorization', value: `Bearer ${TOKEN}` });
      send('Fetch.continueRequest', { requestId: p.requestId, headers }, sid).catch(() => {});
    } else {
      send('Fetch.continueRequest', { requestId: p.requestId }, sid).catch(() => {});
    }
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning', 'assert'].includes(p.type)) {
    log.push({ kind: `console.${p.type}`, text: p.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 400), url: p.stackTrace?.callFrames?.[0]?.url ?? null });
  } else if (msg.method === 'Runtime.exceptionThrown') {
    log.push({ kind: 'exception', text: (p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? '').slice(0, 400), url: p.exceptionDetails?.url ?? null });
  } else if (msg.method === 'Network.responseReceived' && p.response?.status >= 400) {
    log.push({ kind: `http ${p.response.status}`, text: p.response.url.slice(0, 300), type: p.type });
  } else if (msg.method === 'Network.loadingFailed' && !p.canceled) {
    log.push({ kind: 'net failed', text: `${p.errorText} ${p.type ?? ''}`, id: p.requestId });
  } else if (msg.method === 'Network.webSocketCreated') {
    log.push({ kind: 'ws open', text: p.url.slice(0, 300) });
  } else if (msg.method === 'Network.webSocketClosed') {
    log.push({ kind: 'ws closed', text: p.requestId });
  }
};
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const n = ++id;
  pending.set(n, { res, rej });
  ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
});
const { targetInfos } = await send('Target.getTargets');
const page = targetInfos.find((t) => t.type === 'page');
const { sessionId } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
const S = (m, p) => send(m, p, sessionId);
await S('Page.enable');
await S('Runtime.enable');
await S('Network.enable');
// The bearer header goes ONLY to the app's own host. Network.setExtraHTTPHeaders would add it to
// every request, so cross-origin fetches (cdn.plot.ly, font CDNs) get an Authorization header,
// trigger a CORS preflight the CDN refuses, and the harness manufactures console errors a real
// SSO browser never has (measured: 403 preflight on cdn.plot.ly/world_110m.json).
const APP_HOST_RE = /\.databricksapps\.com$/;
let MODE = 'scoped';
await S('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
await S('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false });

/** `databricks auth token` returns a CACHED token, so its age is not ours to assume: read the
 *  JWT's own exp and re-mint when it is within 5 minutes of expiring (the CLI only refreshes once
 *  the cached one has actually expired, so this may take a couple of attempts). */
function expOf(t) {
  try { return JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()).exp * 1000; } catch { return 0; }
}
function refresh() {
  if (expOf(TOKEN) - Date.now() > 5 * 60000) return;
  const before = TOKEN;
  TOKEN = token(); tokenAt = Date.now();
  if (MODE === 'global') S('Network.setExtraHTTPHeaders', { headers: { Authorization: `Bearer ${TOKEN}` } }).catch(() => {});
  console.log(`[cdpd] token re-minted: ${TOKEN === before ? 'CLI returned the same (still cached)' : 'new'}, expires ${new Date(expOf(TOKEN)).toISOString()}`);
}
setInterval(refresh, 30000).unref?.();
async function evaluate(expr, timeoutMs = 60000) {
  const r = await S('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: timeoutMs });
  if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text };
  return { value: r.result.value };
}

const server = createServer(async (req, res) => {
  const body = await new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { try { r(b ? JSON.parse(b) : {}); } catch (e) { r({ _bad: String(e.message) }); } }); });
  const out = (o, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (body._bad) return out({ error: `request body is not JSON: ${body._bad}` }, 400); // a bad request must not kill the daemon
  try {
    refresh();
    if (req.url === '/nav') {
      await S('Page.navigate', { url: body.url });
      // wait for load, then report WHERE we are (a login page is not the app)
      const t0 = Date.now();
      let st = null;
      while (Date.now() - t0 < (body.timeoutMs ?? 45000)) {
        st = (await evaluate('({ready: document.readyState, href: location.href, title: document.title})')).value;
        if (st?.ready === 'complete' && st.href !== 'about:blank') break;
        await new Promise((r) => setTimeout(r, 250));
      }
      return out({ ...st, ms: Date.now() - t0, loginWall: /login\.html|Sign In/i.test(`${st?.href} ${st?.title}`) });
    }
    if (req.url === '/eval') return out(await evaluate(body.expr, body.timeoutMs));
    // A TRUSTED click at viewport (x, y): some canvases (deck.gl) ignore synthetic DOM events.
    if (req.url === '/click') {
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await S('Input.dispatchMouseEvent', { type, x: body.x, y: body.y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 });
      }
      return out({ clicked: [body.x, body.y] });
    }
    if (req.url === '/shot') {
      const r = await S('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !!body.full });
      writeFileSync(body.path, Buffer.from(r.data, 'base64'));
      return out({ path: body.path, bytes: Buffer.from(r.data, 'base64').length });
    }
    if (req.url === '/log') return out({ n: log.length, log, tokenExpiresInS: Math.round((expOf(TOKEN) - Date.now()) / 1000) });
    if (req.url === '/mode') {
      // 'scoped' (default): header only to *.databricksapps.com via Fetch interception — faithful
      //   for HTTP, but a WebSocket handshake is never intercepted, so it goes out unauthenticated.
      // 'global': Network.setExtraHTTPHeaders — reaches WebSocket handshakes too, but also sends
      //   the header to every CDN, whose CORS preflights then fail (harness artefacts, not app faults).
      if (body.mode === 'global') { await S('Fetch.disable'); await S('Network.setExtraHTTPHeaders', { headers: { Authorization: `Bearer ${TOKEN}` } }); }
      else { await S('Network.setExtraHTTPHeaders', { headers: {} }); await S('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }); }
      MODE = body.mode === 'global' ? 'global' : 'scoped';
      return out({ mode: MODE });
    }
    if (req.url === '/cookies') {
      const { cookies } = await S('Network.getAllCookies');
      return out(cookies.map((c) => ({ name: c.name, domain: c.domain, path: c.path, httpOnly: c.httpOnly, len: String(c.value).length })));
    }
    if (req.url === '/mark') { const n = log.length; log = []; return out({ cleared: n }); }
    if (req.url === '/quit') { out({ bye: true }); setTimeout(() => { try { chrome.kill('SIGTERM'); } catch { /* gone */ } process.exit(0); }, 200); return undefined; }
    return out({ error: 'unknown' }, 404);
  } catch (e) { return out({ error: String(e.message ?? e) }, 500); }
});
server.listen(CTL_PORT, '127.0.0.1', () => console.log(`[cdpd] chrome pid ${chrome.pid} on :${CDP_PORT}; control on :${CTL_PORT}; viewport ${W}x${H}`));
chrome.on('exit', () => process.exit(0));

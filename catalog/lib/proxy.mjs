/**
 * Reverse proxy from the master's port to a child's localhost port.
 *
 * HTTP: the request is streamed through with its headers intact — including the
 * platform's identity headers (x-forwarded-email / -user / -preferred-username)
 * and the viewer's on-behalf-of token (x-forwarded-access-token), so a child's
 * OBO code works unchanged. Only HTML and CSS bodies are buffered (to rewrite
 * root-relative URLs); everything else, including SSE and large downloads, is
 * piped as it arrives.
 *
 * WebSocket: the upgrade is replayed to the child on a raw socket and the two
 * sockets are piped together (Streamlit, Shiny, Gradio and Node apps use these).
 */
import http from 'node:http';
import { connect } from 'node:net';
import zlib from 'node:zlib';
import { rewriteHtml, rewriteCss, rewriteLocation, rewriteSetCookie, relaxFraming } from './rewrite.mjs';

const MAX_REWRITE_BYTES = 25 * 1024 * 1024;
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer']);

const agents = new Map();
function agentFor(child) {
  const key = `${child.host}:${child.port}`;
  let a = agents.get(key);
  if (!a) { a = new http.Agent({ keepAlive: true, maxSockets: 64, keepAliveMsecs: 15000 }); agents.set(key, a); }
  return a;
}

function decompress(buf, encoding) {
  const e = String(encoding || '').toLowerCase().trim();
  if (!e || e === 'identity') return buf;
  if (e === 'gzip' || e === 'x-gzip') return zlib.gunzipSync(buf);
  if (e === 'deflate') { try { return zlib.inflateSync(buf); } catch { return zlib.inflateRawSync(buf); } }
  if (e === 'br') return zlib.brotliDecompressSync(buf);
  throw new Error(`unsupported content-encoding ${e}`);
}

export function shimTag(child, version) {
  const p = child.prefix.replace(/"/g, '');
  return `<script src="/_catalog/shim.js?v=${version}" data-prefix="${p}" data-mode="${child.m.mount}" data-name="${child.name}"></script>`;
}

/**
 * Proxy one HTTP request. `path` is what the child should see (prefix already
 * stripped); `ctx` carries { hosts, shimVersion, onHtml }.
 */
export function proxyHttp(req, res, child, path, ctx) {
  child.active += 1;
  child.touch();
  let released = false;
  const release = () => { if (!released) { released = true; child.active -= 1; child.touch(); } };
  res.on('close', release);

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(k)) headers[k] = v;
  headers['x-forwarded-prefix'] = child.prefix;
  headers['x-catalog-child'] = child.name;
  if (req.headers.connection && /upgrade/i.test(req.headers.connection)) headers.connection = req.headers.connection;

  const upstream = http.request({
    host: child.host, port: child.port, method: req.method, path, headers, agent: agentFor(child),
  }, (ures) => {
    const rh = { ...ures.headers };
    for (const h of HOP_BY_HOP) delete rh[h];
    relaxFraming(rh);
    if (rh.location) rh.location = rewriteLocation(rh.location, child.prefix, ctx.hosts);
    if (rh['set-cookie'] && child.m.mount === 'prefix') {
      rh['set-cookie'] = [].concat(rh['set-cookie']).map((c) => rewriteSetCookie(c, child.prefix));
    }
    rh['x-catalog-child'] = child.name;
    const type = String(rh['content-type'] || '').toLowerCase();
    const status = ures.statusCode;
    const bodyless = req.method === 'HEAD' || status === 204 || status === 304 || (status >= 100 && status < 200);
    const isHtml = type.includes('text/html');
    const isCss = type.includes('text/css');
    const isStream = type.includes('text/event-stream');

    if (isStream) {
      child.sockets += 1;
      res.on('close', () => { child.sockets -= 1; child.touch(); });
      rh['x-accel-buffering'] = 'no';
      res.writeHead(status, rh);
      res.flushHeaders?.();
      ures.pipe(res);
      return;
    }
    if (bodyless || (!isHtml && !isCss)) {
      res.writeHead(status, rh);
      ures.pipe(res);
      return;
    }
    // Buffer, decompress, rewrite.
    const chunks = [];
    let size = 0;
    let tooBig = false;
    ures.on('data', (c) => {
      if (tooBig) return;
      size += c.length;
      if (size > MAX_REWRITE_BYTES) { tooBig = true; return; }
      chunks.push(c);
    });
    ures.on('end', () => {
      if (tooBig) {
        // Too large to rewrite safely; tell the truth rather than truncate.
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`catalog: ${child.name} returned a ${type} body over ${MAX_REWRITE_BYTES} bytes, which the catalog will not rewrite`);
        return;
      }
      let body;
      try { body = decompress(Buffer.concat(chunks), rh['content-encoding']).toString('utf8'); } catch (e) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`catalog: could not decode ${child.name}'s response (${e.message})`);
        return;
      }
      let out;
      if (isHtml) {
        out = rewriteHtml(body, { prefix: child.prefix, hosts: ctx.hosts, shimTag: shimTag(child, ctx.shimVersion) });
        ctx.onHtml?.(req, res, child, rh);
      } else {
        out = rewriteCss(body, child.prefix, ctx.hosts);
      }
      const buf = Buffer.from(out, 'utf8');
      delete rh['content-encoding'];
      delete rh['content-length'];
      delete rh.etag; // the body is no longer the child's exact bytes
      rh['content-length'] = String(buf.length);
      res.writeHead(status, rh);
      res.end(buf);
    });
    ures.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  });

  upstream.on('error', (e) => {
    release();
    if (res.headersSent) { res.destroy(); return; }
    ctx.onError?.(req, res, child, e);
  });
  req.on('aborted', () => upstream.destroy());
  req.pipe(upstream);
}

/** Proxy a WebSocket (or any HTTP upgrade). */
export function proxyUpgrade(req, socket, head, child, path) {
  const upstream = connect({ host: child.host, port: child.port });
  let counted = false;
  const cleanup = () => {
    if (counted) { counted = false; child.sockets -= 1; child.touch(); }
    socket.destroy();
    upstream.destroy();
  };
  upstream.on('connect', () => {
    child.sockets += 1;
    counted = true;
    child.touch();
    const lines = [`${req.method} ${path} HTTP/${req.httpVersion}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    lines.push(`X-Forwarded-Prefix: ${child.prefix}`);
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  // Any traffic keeps the child warm.
  upstream.on('data', () => child.touch());
  upstream.on('error', cleanup);
  socket.on('error', cleanup);
  upstream.on('close', cleanup);
  socket.on('close', cleanup);
}

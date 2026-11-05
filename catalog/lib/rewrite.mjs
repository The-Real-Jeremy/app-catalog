/**
 * Response rewriting for children that assume they own the site root.
 *
 * The proxy strips /apps/<name> before a request reaches the child, so the child
 * believes it lives at "/". Whatever ROOT-RELATIVE URL it emits ("/static/x.css",
 * "/api/y", "Location: /login") would therefore escape its prefix in the browser.
 * We fix the static ones here; the dynamic ones (fetch, XHR, WebSocket, history)
 * are fixed in the browser by shim.js, and anything left over is routed by the
 * Referer / last-child cookie fallback in server.mjs.
 *
 * Only ROOT-RELATIVE ("/x") and same-host absolute URLs are touched. Relative
 * URLs already resolve under the prefix, and other hosts are not ours.
 */

const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?$/i;

export function prefixPath(url, prefix) {
  if (!url.startsWith('/') || url.startsWith('//')) return url;
  if (url === prefix || url.startsWith(`${prefix}/`) || url.startsWith(`${prefix}?`) || url.startsWith(`${prefix}#`)) return url;
  if (url.startsWith('/_catalog/')) return url;
  return prefix + url;
}

/** Rewrite one URL value from HTML/CSS/headers. */
export function rewriteUrl(value, prefix, hosts = []) {
  const v = value.trim();
  if (v.startsWith('/') && !v.startsWith('//')) return prefixPath(v, prefix);
  const m = /^(https?:)?\/\/([^/?#]+)(.*)$/i.exec(v);
  if (m && (LOCAL_HOST_RE.test(m[2]) || hosts.includes(m[2].toLowerCase()))) {
    const rest = m[3] || '/';
    return prefixPath(rest.startsWith('/') ? rest : `/${rest}`, prefix);
  }
  return value;
}

export function rewriteLocation(loc, prefix, hosts) {
  if (!loc) return loc;
  return rewriteUrl(loc, prefix, hosts);
}

/** Scope a child's cookies to its prefix so two children's "session" cookies
 *  cannot collide. Not applied in root mode, where the document path is "/" and
 *  the app's own JS must still be able to read its cookies. */
export function rewriteSetCookie(value, prefix) {
  const parts = value.split(';');
  for (let i = 1; i < parts.length; i += 1) {
    const m = /^\s*path\s*=\s*(.*)$/i.exec(parts[i]);
    if (m) {
      const p = m[1].trim() || '/';
      parts[i] = ` Path=${p.startsWith('/') ? prefixPath(p, prefix) : p}`;
      if (p === '/') parts[i] = ` Path=${prefix}/`;
    }
  }
  return parts.join(';');
}

export function rewriteCss(css, prefix, hosts) {
  return css
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, u) => `url(${q}${rewriteUrl(u, prefix, hosts)}${q})`)
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, u) => `@import ${q}${rewriteUrl(u, prefix, hosts)}${q}`);
}

const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'poster', 'data', 'background', 'manifest', 'cite', 'icon', 'xlink:href']);

function rewriteSrcset(v, prefix, hosts) {
  return v.split(',').map((part) => {
    const t = part.trim();
    if (!t) return part;
    const [u, ...rest] = t.split(/\s+/);
    return [rewriteUrl(u, prefix, hosts), ...rest].join(' ');
  }).join(', ');
}

function rewriteTag(tag, prefix, hosts) {
  // tag is "<name ...attrs...>" (no nested tags)
  const nameMatch = /^<([a-zA-Z][a-zA-Z0-9:-]*)/.exec(tag);
  if (!nameMatch) return tag;
  const tagName = nameMatch[1].toLowerCase();
  const isRefresh = tagName === 'meta' && /http-equiv\s*=\s*["']?refresh/i.test(tag);
  return tag.replace(/(\s)([a-zA-Z:_-]+)(\s*=\s*)("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g, (m, sp, attr, eq, whole, dq, sq, bare) => {
    const a = attr.toLowerCase();
    const val = dq ?? sq ?? bare ?? '';
    const quote = dq != null ? '"' : (sq != null ? "'" : '');
    let next = val;
    if (URL_ATTRS.has(a)) next = rewriteUrl(val, prefix, hosts);
    else if (a === 'srcset' || a === 'imagesrcset') next = rewriteSrcset(val, prefix, hosts);
    else if (a === 'style') next = rewriteCss(val, prefix, hosts);
    else if (a === 'content' && isRefresh) next = val.replace(/(url\s*=\s*)(\S+)/i, (x, k, u) => k + rewriteUrl(u, prefix, hosts));
    if (next === val) return m;
    return `${sp}${attr}${eq}${quote}${next}${quote}`;
  });
}

/**
 * Rewrite an HTML document. Script bodies are left alone (the shim handles
 * runtime URLs); style bodies get the CSS treatment; comments are skipped.
 */
export function rewriteHtml(html, { prefix, hosts = [], shimTag = '' }) {
  let out = '';
  let i = 0;
  const n = html.length;
  const lower = html.toLowerCase();
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) { out += html.slice(i); break; }
    out += html.slice(i, lt);
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      const stop = end === -1 ? n : end + 3;
      out += html.slice(lt, stop); i = stop; continue;
    }
    const gt = html.indexOf('>', lt);
    if (gt === -1) { out += html.slice(lt); break; }
    const tag = html.slice(lt, gt + 1);
    const tagLower = lower.slice(lt, Math.min(gt + 1, lt + 8));
    out += rewriteTag(tag, prefix, hosts);
    i = gt + 1;
    if (/^<script[\s>]/.test(tagLower) && !tag.endsWith('/>')) {
      const close = lower.indexOf('</script', i);
      const stop = close === -1 ? n : close;
      out += html.slice(i, stop); i = stop;
    } else if (/^<style[\s>]/.test(tagLower)) {
      const close = lower.indexOf('</style', i);
      const stop = close === -1 ? n : close;
      out += rewriteCss(html.slice(i, stop), prefix, hosts); i = stop;
    }
  }
  if (!shimTag) return out;
  // Inject the shim as the FIRST thing in <head> so it runs before any app script.
  const head = /<head(\s[^>]*)?>/i.exec(out);
  if (head) return out.slice(0, head.index + head[0].length) + shimTag + out.slice(head.index + head[0].length);
  const htmlTag = /<html(\s[^>]*)?>/i.exec(out);
  if (htmlTag) return out.slice(0, htmlTag.index + htmlTag[0].length) + shimTag + out.slice(htmlTag.index + htmlTag[0].length);
  const doctype = /<!doctype[^>]*>/i.exec(out);
  if (doctype) return out.slice(0, doctype.index + doctype[0].length) + shimTag + out.slice(doctype.index + doctype[0].length);
  return shimTag + out;
}

/** Drop frame-blocking headers: the child is shown inside the catalog's own
 *  same-origin viewer, which X-Frame-Options/frame-ancestors would blank. */
export function relaxFraming(headers) {
  delete headers['x-frame-options'];
  for (const k of ['content-security-policy', 'content-security-policy-report-only']) {
    if (!headers[k]) continue;
    const v = Array.isArray(headers[k]) ? headers[k].join(', ') : headers[k];
    const kept = v.split(';').map((d) => d.trim()).filter((d) => d && !/^frame-ancestors\b/i.test(d)).join('; ');
    if (kept) headers[k] = kept; else delete headers[k];
  }
}

/*
 * App-ception — child URL shim.
 *
 * Injected as the first <script> in every HTML page a child app serves. The
 * child believes it lives at "/", but in the browser it lives at /apps/<name>/.
 * This keeps every ROOT-RELATIVE URL the page creates at runtime inside that
 * prefix: fetch, XMLHttpRequest, WebSocket, EventSource, sendBeacon, window.open,
 * the src/href/action properties and attributes of elements, and history.
 *
 * Two mount modes (chosen by the catalog, see discover.mjs):
 *   prefix  the address bar keeps /apps/<name>/… (history calls are prefixed)
 *   root    for apps whose client-side router reads location.pathname and has
 *           no basename: the prefix is removed from the address bar BEFORE the
 *           app boots, so the router sees "/…"; network calls are still prefixed.
 *
 * The shim never touches a URL that is relative, on another host, or already
 * inside the prefix.
 */
(function () {
  'use strict';
  var script = document.currentScript;
  if (!script || window.__appception) return;
  var P = script.getAttribute('data-prefix');
  var MODE = script.getAttribute('data-mode') || 'prefix';
  var NAME = script.getAttribute('data-name') || '';
  if (!P) return;
  var ORIGIN = location.origin;
  var HOST = location.host;
  window.__appception = { prefix: P, mode: MODE, name: NAME };

  function inPrefix(path) {
    return path === P || path.indexOf(P + '/') === 0 || path.indexOf(P + '?') === 0 || path.indexOf(P + '#') === 0 || path.indexOf('/_catalog/') === 0;
  }
  function fixPath(path) { return inPrefix(path) ? path : P + path; }

  /** Rewrite one URL (string or URL object). Returns the same type it was given
   *  when unchanged, a string otherwise. */
  function fix(u, opts) {
    if (u == null) return u;
    var s;
    try { s = typeof u === 'string' ? u : String(u); } catch (e) { return u; }
    if (!s) return u;
    var c = s.charAt(0);
    if (c === '/' && s.charAt(1) !== '/') return inPrefix(s) ? u : fixPath(s);
    if (/^(data|blob|javascript|mailto|tel|about):/i.test(s)) return u;
    if (/^https?:\/\//i.test(s) || /^wss?:\/\//i.test(s) || s.indexOf('//') === 0) {
      var parsed;
      try { parsed = new URL(s, location.href); } catch (e) { return u; }
      if (parsed.host !== HOST) return u;
      if (inPrefix(parsed.pathname)) return u;
      parsed.pathname = fixPath(parsed.pathname);
      return parsed.toString();
    }
    // A RELATIVE url: in prefix mode it already resolves under the prefix. In
    // root mode the document URL has had its prefix removed, so resolve it and
    // put the prefix back.
    if (MODE === 'root' && !(opts && opts.navigation)) {
      try {
        var r = new URL(s, location.href);
        if (r.host === HOST && !inPrefix(r.pathname)) { r.pathname = fixPath(r.pathname); return r.pathname + r.search + r.hash; }
      } catch (e) { /* leave */ }
    }
    return u;
  }

  // ── root mode: make the router see "/" before any app code runs ──────────
  if (MODE === 'root' && inPrefix(location.pathname) && location.pathname.indexOf('/_catalog/') !== 0) {
    var stripped = location.pathname.slice(P.length) || '/';
    try { history.replaceState(history.state, '', stripped + location.search + location.hash); } catch (e) { /* ignore */ }
  }

  // ── network ──────────────────────────────────────────────────────────────
  var origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      try {
        if (typeof input === 'string' || (window.URL && input instanceof URL)) input = fix(input);
        else if (window.Request && input instanceof Request) {
          var nu = fix(input.url);
          if (nu !== input.url) input = new Request(nu, input);
        }
      } catch (e) { /* fall through with the original */ }
      return origFetch.call(this, input, init);
    };
  }
  var XHR = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (XHR && XHR.open) {
    var origOpen = XHR.open;
    XHR.open = function (method, url) {
      var args = Array.prototype.slice.call(arguments);
      args[1] = fix(url);
      return origOpen.apply(this, args);
    };
  }
  function wrapCtor(name, mapArgs) {
    var Orig = window[name];
    if (!Orig) return;
    var Wrapped = function () {
      var args = Array.prototype.slice.call(arguments);
      try { mapArgs(args); } catch (e) { /* keep the original arguments */ }
      return Reflect.construct(Orig, args);
    };
    Wrapped.prototype = Orig.prototype;
    try { Object.getOwnPropertyNames(Orig).forEach(function (k) { if (!(k in Wrapped)) { try { Wrapped[k] = Orig[k]; } catch (e) {} } }); } catch (e) {}
    ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k) { if (k in Orig) { try { Object.defineProperty(Wrapped, k, { value: Orig[k] }); } catch (e) {} } });
    window[name] = Wrapped;
  }
  wrapCtor('WebSocket', function (args) {
    var s = String(args[0]);
    if (s.charAt(0) === '/' && s.charAt(1) !== '/') s = (location.protocol === 'https:' ? 'wss://' : 'ws://') + HOST + s;
    else if (/^https?:/i.test(s)) s = s.replace(/^http/i, 'ws');
    args[0] = fix(s);
  });
  wrapCtor('EventSource', function (args) { args[0] = fix(args[0]); });
  if (navigator.sendBeacon) {
    var origBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) { return origBeacon(fix(url), data); };
  }
  var origOpenWin = window.open;
  window.open = function (url) {
    var args = Array.prototype.slice.call(arguments);
    if (args.length) args[0] = fix(args[0], { navigation: true });
    return origOpenWin.apply(window, args);
  };

  // ── element URL properties and attributes ────────────────────────────────
  var PROPS = [
    ['HTMLImageElement', 'src'], ['HTMLScriptElement', 'src'], ['HTMLLinkElement', 'href'],
    ['HTMLIFrameElement', 'src'], ['HTMLSourceElement', 'src'], ['HTMLMediaElement', 'src'],
    ['HTMLFormElement', 'action'], ['HTMLEmbedElement', 'src'], ['HTMLTrackElement', 'src'],
    ['HTMLObjectElement', 'data'], ['HTMLInputElement', 'src'],
  ];
  if (MODE === 'prefix') PROPS.push(['HTMLAnchorElement', 'href'], ['HTMLAreaElement', 'href']);
  PROPS.forEach(function (pair) {
    var C = window[pair[0]];
    if (!C) return;
    var d = Object.getOwnPropertyDescriptor(C.prototype, pair[1]);
    if (!d || !d.set) return;
    Object.defineProperty(C.prototype, pair[1], {
      configurable: true, enumerable: d.enumerable,
      get: d.get,
      set: function (v) { return d.set.call(this, fix(v)); },
    });
  });
  var ATTRS = { src: 1, href: 1, action: 1, formaction: 1, poster: 1, data: 1 };
  var origSetAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    try {
      var n = String(name).toLowerCase();
      if (ATTRS[n] && typeof value === 'string') {
        var isAnchor = this instanceof HTMLAnchorElement || (window.HTMLAreaElement && this instanceof HTMLAreaElement);
        if (!(isAnchor && MODE === 'root')) value = fix(value);
      }
    } catch (e) { /* ignore */ }
    return origSetAttr.call(this, name, value);
  };

  // ── history ──────────────────────────────────────────────────────────────
  function notifyParent() {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ appception: 'nav', name: NAME, mode: MODE, path: location.pathname + location.search + location.hash, title: document.title }, ORIGIN);
      }
    } catch (e) { /* ignore */ }
  }
  ['pushState', 'replaceState'].forEach(function (k) {
    var orig = history[k];
    if (!orig) return;
    history[k] = function (state, title, url) {
      var args = Array.prototype.slice.call(arguments);
      if (MODE === 'prefix' && args.length > 2 && args[2] != null) args[2] = fix(args[2], { navigation: true });
      var r = orig.apply(history, args);
      notifyParent();
      return r;
    };
  });
  window.addEventListener('popstate', notifyParent);
  window.addEventListener('hashchange', notifyParent);
  window.addEventListener('load', notifyParent);
  // document.title changes are interesting to the viewer too
  try { new MutationObserver(notifyParent).observe(document.querySelector('title') || document.head || document.documentElement, { childList: true, subtree: true, characterData: true }); } catch (e) {}

  // ── a way back, when the app is opened outside the catalog's viewer ──────
  if (window.top === window && MODE === 'prefix') {
    var addPill = function () {
      if (document.getElementById('app-ception-pill')) return;
      var a = document.createElement('a');
      a.id = 'app-ception-pill';
      a.href = '/?app=' + encodeURIComponent(NAME);
      a.textContent = '◂ Catalog';
      a.title = 'Back to the app catalog';
      a.setAttribute('style', 'position:fixed;right:14px;bottom:14px;z-index:2147483647;font:600 12px/1 system-ui,-apple-system,sans-serif;padding:8px 12px;border-radius:999px;background:rgba(17,24,39,.85);color:#9cc0ff;text-decoration:none;box-shadow:0 4px 18px rgba(0,0,0,.35);opacity:.55;transition:opacity .2s');
      a.onmouseenter = function () { a.style.opacity = '1'; };
      a.onmouseleave = function () { a.style.opacity = '.55'; };
      (document.body || document.documentElement).appendChild(a);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addPill); else addPill();
  }
})();

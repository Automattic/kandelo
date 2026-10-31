/**
 * Blob-URL iframe interceptor for guest web previews: framework-free.
 *
 * WHY THIS EXISTS
 * ---------------
 * Guest pages are served on Kandelo's preview origin by the preview service
 * worker (`preview-origin/preview-service-worker.js`), which forwards every
 * request under `<scope>computer/<name>/` to the tab that runs the machine.
 * The worker can only route requests from documents it controls.
 *
 * A `blob:` document is not reliably controlled by a service worker, and
 * neither is the `about:srcdoc` document this helper used to substitute:
 * inside the sandboxed preview frame, Firefox gives an `about:srcdoc`
 * document no controller, and Chromium leaves `blob:` documents in a
 * cross-origin frame uncontrolled. The WordPress block and site editor
 * canvas is such a document: it is mounted from
 * `URL.createObjectURL(new Blob([html], { type: "text/html" }))` and pulls
 * `<script src=".../wp-admin/load-scripts.php?...">`, which would then go
 * past the bridge to the preview origin's network and fail.
 *
 * WHAT IT DOES
 * ------------
 * When an iframe's `src` is set to a `blob:` URL whose content is a
 * `text/html` string, this helper posts the HTML (with this helper injected
 * at the top of its `<head>`, as the owning tab injects it into every guest
 * page) to the preview service worker under an unguessable id and points
 * the iframe at `<scope>computer/<name>/__kandelo_blob/<id>` instead. The
 * worker serves that document, to frames of the same machine, as an
 * ordinary navigation it controls, so every engine routes the canvas's
 * requests (and a blob iframe or keepalive fetch inside it) through the
 * bridge. A reload shows it again until the app revokes the blob URL, which
 * this helper passes on to the worker. Reading `iframe.src` still returns
 * the blob URL the app assigned.
 *
 * It is:
 *   - idempotent (safe to inject more than once),
 *   - a no-op unless a text/html blob URL is actually used as an iframe src
 *     in a document the preview worker controls under a machine's path,
 *   - transparent to non-iframe blob usage (downloads, workers, media, ...).
 *
 * It must run before the app creates its blob iframes; the owning tab
 * injects it as the first thing in <head> (lib/preview/response-shaping.ts).
 */
(function () {
  if (typeof window === "undefined" || window.__kandeloBlobIframePatched) {
    return;
  }
  window.__kandeloBlobIframePatched = true;
  // This helper's own source, to inject into the documents it hands to the
  // preview worker. The owning tab injects it as an inline script.
  var selfSource = document.currentScript && !document.currentScript.src
    ? document.currentScript.textContent
    : "";

  // Keep equal to PREVIEW_PROTOCOL_VERSION in
  // apps/browser-demos/lib/preview/protocol.ts (preview-bridge.test.ts checks).
  var PROTOCOL_VERSION = 3;

  var NativeBlob = window.Blob;
  if (typeof NativeBlob !== "function" || typeof URL === "undefined") {
    return;
  }

  // blobUrl -> HTML string, for blob: URLs we know wrap an HTML document.
  var htmlByUrl = new Map();
  // blobUrl -> ids of the worker's copies, so revoking the URL retires them.
  var idsByUrl = new Map();
  // Blob instance -> HTML string, captured synchronously at construction time
  // so the iframe `src` setter can divert to srcdoc without an async read.
  var htmlByBlob = new WeakMap();

  function isHtmlType(type) {
    return typeof type === "string" && type.toLowerCase().indexOf("text/html") === 0;
  }

  // 1) Remember the text for text/html blobs. We only capture when every part
  //    is a string (the block-editor case); anything else falls back to the
  //    native behavior and is left untouched.
  function PatchedBlob(parts, options) {
    var blob = new NativeBlob(parts, options);
    try {
      if (
        options &&
        isHtmlType(options.type) &&
        Array.isArray(parts) &&
        parts.every(function (p) { return typeof p === "string"; })
      ) {
        htmlByBlob.set(blob, parts.join(""));
      }
    } catch (e) {
      /* never let tracking break Blob construction */
    }
    return blob;
  }
  PatchedBlob.prototype = NativeBlob.prototype;
  try {
    // Preserve static members and `blob instanceof Blob` for native instances.
    Object.setPrototypeOf(PatchedBlob, NativeBlob);
  } catch (e) {
    /* ignore */
  }
  window.Blob = PatchedBlob;

  // 2) Map the blob URL to its HTML when the URL is minted, and forget it when
  //    revoked so the map does not grow without bound.
  var nativeCreate = URL.createObjectURL.bind(URL);
  var nativeRevoke = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = function (obj) {
    var url = nativeCreate(obj);
    try {
      if (obj && htmlByBlob.has(obj)) {
        htmlByUrl.set(url, htmlByBlob.get(obj));
      }
    } catch (e) {
      /* ignore */
    }
    return url;
  };
  URL.revokeObjectURL = function (url) {
    try {
      htmlByUrl.delete(url);
      var ids = idsByUrl.get(url);
      idsByUrl.delete(url);
      var controller = navigator.serviceWorker && navigator.serviceWorker.controller;
      if (ids && controller) {
        ids.forEach(function (id) {
          controller.postMessage({ type: "preview-blob-revoked", v: PROTOCOL_VERSION, id: id });
        });
      }
    } catch (e) {
      /* ignore */
    }
    return nativeRevoke(url);
  };

  // 3) Point iframe src=<html-blob-url> at the preview worker's copy.
  var proto = window.HTMLIFrameElement && window.HTMLIFrameElement.prototype;
  if (!proto) {
    return;
  }
  var srcDesc = Object.getOwnPropertyDescriptor(proto, "src");
  if (!srcDesc || typeof srcDesc.set !== "function") {
    return;
  }

  // Keep equal to MACHINE_NAME_PATTERN in
  // apps/browser-demos/lib/preview/protocol.ts (preview-bridge.test.ts checks).
  var MACHINE_ROOT = /^(.*\/computer\/[a-z]{2,12}-[a-z]{2,12}-[a-z]{2,12}-[a-z2-7]{20})(?:\/|$)/;

  // Shadow slot so reading iframe.src still returns the blob URL the app
  // assigned (some components compare against it).
  var SHADOW = "__kandeloSrcValue";

  function machineRoot() {
    var match = MACHINE_ROOT.exec(location.pathname);
    return match ? match[1] : null;
  }

  function randomId() {
    var bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    var out = "";
    for (var i = 0; i < bytes.length; i++) {
      out += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
    }
    return out;
  }

  // The same placement the owning tab uses for guest pages
  // (injectBlobIframeInterceptor in lib/preview/response-shaping.ts).
  function withHelper(html) {
    if (!selfSource || html.indexOf("__kandeloBlobIframePatched") !== -1) return html;
    var tag = "<script>" + selfSource + "</" + "script>";
    var head = /<head[^>]*>/i.exec(html);
    if (head) return html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length);
    var root = /<html[^>]*>/i.exec(html);
    if (root) return html.slice(0, root.index + root[0].length) + tag + html.slice(root.index + root[0].length);
    return tag + html;
  }

  function divertToWorker(iframe, value) {
    var html = htmlByUrl.get(value);
    if (html === undefined) return false;
    if (iframe[SHADOW] === value) return true;
    var controller = navigator.serviceWorker && navigator.serviceWorker.controller;
    var root = machineRoot();
    if (!controller || !root) return false;
    try {
      var id = randomId();
      controller.postMessage({
        type: "preview-blob-document",
        v: PROTOCOL_VERSION,
        id: id,
        html: withHelper(html),
        baseUrl: document.baseURI,
      });
      var ids = idsByUrl.get(value) || [];
      ids.push(id);
      idsByUrl.set(value, ids);
      iframe[SHADOW] = value;
      srcDesc.set.call(iframe, root + "/__kandelo_blob/" + id);
      return true;
    } catch (e) {
      return false;
    }
  }

  function clearDivert(iframe) {
    if (iframe[SHADOW] !== undefined) {
      try {
        delete iframe[SHADOW];
      } catch (e) {
        iframe[SHADOW] = undefined;
      }
    }
  }

  // 4) [RUNTIME-WORKAROUND: FIREFOX-KEEPALIVE-FETCH-BYPASSES-SERVICE-WORKER]
  // Firefox 155 (Playwright build; no released Firefox checked yet) sends
  // a `fetch(..., { keepalive: true })` straight to the network instead of
  // to the controlling service worker, so such a write
  // (WordPress saves editor preferences that way) reaches the preview
  // origin's static host instead of the guest's server. Until one probe
  // shows that keepalive requests reach the preview worker in this browser,
  // same-origin keepalive fetches are sent without keepalive: they reach
  // the guest, but may be cancelled if the page unloads first. Only an init
  // dictionary that sets `keepalive: true` is affected: a keepalive Request
  // object passed to fetch (with or without an init) and sendBeacon reach
  // the worker in Firefox (measured), so they are left alone.
  // See tests/runtime-workarounds/FIREFOX-KEEPALIVE-FETCH-BYPASSES-SERVICE-WORKER/.
  var nativeFetch = window.fetch;
  var probeRoot = machineRoot();
  if (typeof nativeFetch === "function" && probeRoot &&
      navigator.serviceWorker && navigator.serviceWorker.controller) {
    var keepaliveReachesWorker = false;
    nativeFetch.call(window, probeRoot + "/__kandelo_keepalive_probe", {
      keepalive: true,
      cache: "no-store",
      redirect: "manual",
    }).then(function (response) {
      keepaliveReachesWorker = response.headers.get("x-kandelo-preview-worker") === "keepalive";
    }, function () {
      keepaliveReachesWorker = false;
    });
    var sameOrigin = function (input) {
      try {
        var url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
        return url.origin === location.origin;
      } catch (e) {
        return false;
      }
    };
    window.fetch = function (input, init) {
      if (!keepaliveReachesWorker && init && init.keepalive && sameOrigin(input)) {
        init = Object.assign({}, init, { keepalive: false });
      }
      return nativeFetch.call(window, input, init);
    };
  }

  Object.defineProperty(proto, "src", {
    configurable: true,
    enumerable: srcDesc.enumerable,
    get: function () {
      return this[SHADOW] !== undefined ? this[SHADOW] : srcDesc.get.call(this);
    },
    set: function (value) {
      if (typeof value === "string" && htmlByUrl.has(value) && divertToWorker(this, value)) {
        return;
      }
      clearDivert(this);
      srcDesc.set.call(this, value);
    },
  });

  var nativeSetAttribute = proto.setAttribute;
  proto.setAttribute = function (name, value) {
    if (
      name &&
      String(name).toLowerCase() === "src" &&
      typeof value === "string" &&
      htmlByUrl.has(value) &&
      divertToWorker(this, value)
    ) {
      return undefined;
    }
    if (name && String(name).toLowerCase() === "src") clearDivert(this);
    return nativeSetAttribute.call(this, name, value);
  };
})();

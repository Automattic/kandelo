/**
 * Blob-URL iframe interceptor — reusable, framework-free.
 *
 * WHY THIS EXISTS
 * ---------------
 * The browser demos serve an in-kernel HTTP stack (nginx/PHP/WordPress) to the
 * page through a service worker that intercepts `fetch` for the app prefix
 * (e.g. `/app/…`) and bridges it into the Wasm kernel. The service worker can
 * only route requests from documents it *controls*.
 *
 * A `blob:` document is NOT controlled by the service worker (and has no base
 * URL), so any subresource it requests — e.g. WordPress's block/site editor
 * canvas, which is mounted from `URL.createObjectURL(new Blob([html]))` and
 * pulls `<script src=".../app/wp-admin/load-scripts.php?…">` — bypasses the
 * bridge entirely and hits the page's real origin (the static host), which has
 * no such file. Result: a spurious 404 for load-scripts.php/load-styles.php and
 * broken iframe assets. `about:srcdoc` documents, by contrast, ARE controlled
 * by the service worker and resolve app URLs correctly.
 *
 * WHAT IT DOES
 * ------------
 * Patches the DOM so that any iframe whose `src` is set to a `blob:` URL backed
 * by `text/html` content is instead rendered from `srcdoc` (an about:srcdoc
 * document), which the service worker controls. This neutralizes the whole
 * class of "blob iframe escapes the bridge" bugs for every app, not just
 * WordPress, without patching app code.
 *
 * It is:
 *   - idempotent (safe to inject more than once),
 *   - a no-op unless a text/html blob URL is actually used as an iframe src,
 *   - transparent to non-iframe blob usage (downloads, workers, media, …).
 *
 * It must run before the app creates its blob iframes; injecting it as the
 * first thing in <head> guarantees that.
 */
(function () {
  if (typeof window === "undefined" || window.__kandeloBlobIframePatched) {
    return;
  }
  window.__kandeloBlobIframePatched = true;

  var NativeBlob = window.Blob;
  if (typeof NativeBlob !== "function" || typeof URL === "undefined") {
    return;
  }

  // blobUrl -> HTML string, for blob: URLs we know wrap an HTML document.
  var htmlByUrl = new Map();
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
    } catch (e) {
      /* ignore */
    }
    return nativeRevoke(url);
  };

  // 3) Divert iframe src=<html-blob-url> to srcdoc.
  var proto = window.HTMLIFrameElement && window.HTMLIFrameElement.prototype;
  if (!proto) {
    return;
  }
  var srcDesc = Object.getOwnPropertyDescriptor(proto, "src");
  if (!srcDesc || typeof srcDesc.set !== "function") {
    return;
  }

  // Shadow slot so reading iframe.src still returns the blob URL the app
  // assigned (some components compare against it), while the document actually
  // shown is the srcdoc one that the service worker controls.
  var SHADOW = "__kandeloSrcValue";

  function divertToSrcdoc(iframe, value) {
    var html = htmlByUrl.get(value);
    if (html === undefined) {
      return false;
    }
    try {
      iframe[SHADOW] = value;
      // Only (re)assign when the content actually changes, so re-renders that
      // set the same src do not force a reload.
      if (iframe.getAttribute("srcdoc") !== html) {
        iframe.setAttribute("srcdoc", html);
      }
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
      try {
        iframe.removeAttribute("srcdoc");
      } catch (e) {
        /* ignore */
      }
    }
  }

  Object.defineProperty(proto, "src", {
    configurable: true,
    enumerable: srcDesc.enumerable,
    get: function () {
      return this[SHADOW] !== undefined ? this[SHADOW] : srcDesc.get.call(this);
    },
    set: function (value) {
      if (typeof value === "string" && htmlByUrl.has(value) && divertToSrcdoc(this, value)) {
        // srcdoc wins over src per the HTML spec; do not also start a blob load.
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
      divertToSrcdoc(this, value)
    ) {
      return undefined;
    }
    return nativeSetAttribute.call(this, name, value);
  };
})();

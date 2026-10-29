/**
 * Kandelo preview relay: a static preview-origin page each Kandelo tab embeds
 * once, hidden and sandboxed. It registers the preview service worker in the
 * tab's storage partition and moves bridge ports from the Kandelo page to that
 * worker; the worker's answers come back the same way.
 *
 * Bind and closing messages carry the machine's secret (see
 * MACHINE_NAME_PATTERN in apps/browser-demos/lib/preview/protocol.ts). This
 * page passes each one straight to the worker and keeps nothing: no
 * variable, storage, BroadcastChannel or message to anyone else ever holds
 * a secret. A guest page framed in this same tab can still script this
 * window and read one in passing; that same-tab residual is documented in
 * docs/browser-support.md.
 *
 * It accepts messages only from its parent, and only when the parent's origin
 * is one this deployment's Kandelo app runs on (injected at build time).
 * Every message carries the protocol version; see
 * apps/browser-demos/lib/preview/protocol.ts.
 */
(function () {
  "use strict";
  // Injected by the build (apps/browser-demos/vite.config.ts):
  // { protocolVersion, kandeloOrigins: [exact origins], kandeloOriginPattern }.
  var PREVIEW_CONFIG = "__KANDELO_PREVIEW_ORIGIN_CONFIG__";
  var PROTOCOL_VERSION = 3;
  var ENSURE_INTERVAL_MS = 2000;
  var config = PREVIEW_CONFIG && typeof PREVIEW_CONFIG === "object" &&
      Array.isArray(PREVIEW_CONFIG.kandeloOrigins)
    ? PREVIEW_CONFIG
    : { kandeloOrigins: [], kandeloOriginPattern: null };
  var originPattern = typeof config.kandeloOriginPattern === "string"
    ? new RegExp(config.kandeloOriginPattern)
    : null;

  function allowedParent(origin) {
    return config.kandeloOrigins.indexOf(origin) !== -1 ||
      (originPattern !== null && originPattern.test(origin));
  }

  if (window.parent === window) return;

  // The parent's origin, learned from the referrer (the Kandelo page embeds
  // this frame with referrerpolicy="origin") and pinned by its first message.
  var parentOrigin = null;
  try {
    var referrer = document.referrer ? new URL(document.referrer).origin : null;
    if (referrer && allowedParent(referrer)) parentOrigin = referrer;
  } catch (_error) {
    parentOrigin = null;
  }

  function toParent(message) {
    message.v = PROTOCOL_VERSION;
    var targets = parentOrigin ? [parentOrigin] : config.kandeloOrigins;
    targets.forEach(function (origin) {
      window.parent.postMessage(message, origin);
    });
  }

  if (config.protocolVersion !== PROTOCOL_VERSION) {
    toParent({ type: "preview-relay-failed", error: "this preview origin is not configured" });
    return;
  }
  if (!("serviceWorker" in navigator)) {
    toParent({ type: "preview-relay-failed", error: "service workers are unavailable" });
    return;
  }

  var scope = new URL("../", location.href).pathname;
  var scopeUrl = new URL(scope, location.href).href;
  var workerUrl = new URL(scope + "preview-service-worker.js", location.href).href;

  // The deployment's worker can change under a live tab: a deploy with new
  // worker bytes, the browser's update check, or a guest page (they share
  // this origin) that unregisters the registration and perhaps registers it
  // again. So nothing here holds on to a registration: every message looks
  // the deployment's registration up again (registering it if it is gone)
  // and goes to its current active worker, and only when that worker is
  // this deployment's exact script; until it is, messages wait. A worker
  // with any other script URL (`preview-service-worker.js?x`, registered by
  // a guest) refuses to install, so waiting cannot last past a real update.
  // A timer repeats the lookup, so a registration a guest removed comes
  // back, and owners hear of the new worker, without waiting for a message.
  function registration() {
    return navigator.serviceWorker.getRegistration(scopeUrl).then(function (found) {
      if (found && found.scope === scopeUrl) return found;
      return navigator.serviceWorker.register(workerUrl, { scope: scope, updateViaCache: "none" });
    });
  }

  function currentWorker() {
    return registration().then(function (current) {
      var ready = current.active;
      if (ready && ready.scriptURL === workerUrl) return ready;
      return new Promise(function (resolve) {
        var watched = [];
        var settled = false;
        var timer = setTimeout(again, 1000);
        function again() {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          current.removeEventListener("updatefound", onUpdateFound);
          navigator.serviceWorker.removeEventListener("controllerchange", again);
          watched.forEach(function (candidate) {
            candidate.removeEventListener("statechange", again);
          });
          resolve(currentWorker());
        }
        function watch(worker) {
          if (!worker || watched.indexOf(worker) !== -1) return;
          watched.push(worker);
          worker.addEventListener("statechange", again);
        }
        function onUpdateFound() {
          watch(current.installing);
        }
        current.addEventListener("updatefound", onUpdateFound);
        navigator.serviceWorker.addEventListener("controllerchange", again);
        [current.installing, current.waiting, current.active].forEach(watch);
      });
    });
  }

  var lastWorker = null;

  function toWorker(message, transfer, attempt) {
    currentWorker().then(function (worker) {
      noteWorker(worker);
      worker.postMessage(message, transfer || []);
    }, function () {
      // Registering failed (the network, or a quota); try again for a while.
      // The page's own bind timeout reports a machine that never binds.
      if ((attempt || 0) < 10) {
        setTimeout(function () {
          toWorker(message, transfer, (attempt || 0) + 1);
        }, 1000);
      }
    });
  }

  // A new active worker holds none of this tab's bridge ports. Tell the
  // parent, whose owners bind their machines again.
  function noteWorker(worker) {
    if (lastWorker !== null && worker !== lastWorker) {
      toParent({ type: "preview-worker-changed" });
    }
    lastWorker = worker;
  }
  var ensuring = false;
  function ensureWorker() {
    if (ensuring) return;
    ensuring = true;
    currentWorker().then(function (worker) {
      ensuring = false;
      noteWorker(worker);
    }, function () {
      ensuring = false;
    });
  }
  navigator.serviceWorker.addEventListener("controllerchange", ensureWorker);

  // Answers from the worker for this relay's tab.
  navigator.serviceWorker.addEventListener("message", function (event) {
    var message = event.data;
    if (!message || message.v !== PROTOCOL_VERSION || typeof message.type !== "string") return;
    if ([
      "preview-bridge-ready", "preview-bridge-refused", "preview-need-bridge",
      "preview-machine-status",
    ].indexOf(message.type) === -1) return;
    toParent(message);
  });
  navigator.serviceWorker.startMessages();

  window.addEventListener("message", function (event) {
    // A script on this origin can dispatch a synthetic message event here
    // with any source and origin it likes; only the browser's own count.
    if (!event.isTrusted) return;
    if (event.source !== window.parent || !allowedParent(event.origin)) return;
    if (parentOrigin !== null && event.origin !== parentOrigin) return;
    parentOrigin = event.origin;
    var message = event.data;
    if (!message || typeof message.type !== "string") return;
    if (message.v !== PROTOCOL_VERSION) {
      toParent({
        type: "preview-bridge-refused", name: String(message.name), seq: message.seq, code: "version-mismatch",
      });
      return;
    }
    // A retried delivery can reach the worker after a later message of the
    // same name; the sequence number lets the worker ignore it.
    if (message.type === "preview-bridge" && event.ports[0]) {
      toWorker({
        type: "preview-bridge", v: PROTOCOL_VERSION, name: message.name, secret: message.secret,
        seq: message.seq,
      }, [event.ports[0]]);
    } else if (message.type === "preview-machine-closing") {
      toWorker({
        type: message.type, v: PROTOCOL_VERSION, name: message.name, secret: message.secret,
        seq: message.seq,
      });
    }
  });

  currentWorker().then(function (worker) {
    noteWorker(worker);
    toParent({ type: "preview-relay-ready" });
    setInterval(ensureWorker, ENSURE_INTERVAL_MS);
  }, function (error) {
    // The DOMException name lets the page tell a browser that denies this
    // origin storage (a SecurityError, as Firefox's "All cross-site cookies"
    // gives a cross-site relay) from other failures; see
    // relayFailureMessage in apps/browser-demos/lib/preview/preview-relay.ts.
    toParent({
      type: "preview-relay-failed",
      error: String(error && error.message || error),
      errorName: String(error && error.name || ""),
    });
  });
})();

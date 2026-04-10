/**
 * Unified Service Worker — dual-mode file that serves as both:
 *
 * 1. Page bootstrap script (when loaded via <script> tag):
 *    Detects if crossOriginIsolated is false, registers itself as a SW,
 *    then reloads the page so SharedArrayBuffer works.
 *
 * 2. Service Worker (when registered):
 *    - Adds COOP/COEP/CORP headers to ALL fetch responses → enables SharedArrayBuffer
 *    - Handles HTTP bridge for nginx/wordpress/lamp demos (MessagePort from page)
 *    - Includes cookie jar for WordPress sessions
 *    - Revalidates navigation requests to ensure fresh HTML (cache busting)
 */

// ============================================================
// Mode 1: Page script — register this file as a service worker
// ============================================================
if (typeof window !== "undefined") {
  if (!window.crossOriginIsolated && "serviceWorker" in navigator) {
    // If a SW is already controlling this page but we're still not
    // crossOriginIsolated, one reload should fix it (the SW will add headers).
    if (navigator.serviceWorker.controller) {
      // Trigger update check so a new SW version is picked up on next visit
      navigator.serviceWorker.ready.then(function (reg) {
        reg.update();
      });
      window.location.reload();
    } else {
      // Register this script as the service worker.
      // updateViaCache: "none" ensures the browser always fetches the SW
      // script from the network, so deploys take effect immediately.
      // Reload once the SW takes control (controllerchange fires after
      // clients.claim() completes, guaranteeing the SW intercepts fetches).
      var scriptUrl = document.currentScript && document.currentScript.src;
      if (scriptUrl) {
        navigator.serviceWorker
          .register(scriptUrl, { updateViaCache: "none" })
          .then(function () {
            navigator.serviceWorker.addEventListener(
              "controllerchange",
              function () {
                window.location.reload();
              },
            );
          })
          .catch(function (err) {
            console.warn("[COI SW] registration failed:", err);
          });
      }
    }
  } else if (window.crossOriginIsolated && "serviceWorker" in navigator) {
    // Already isolated — just ensure SW stays up to date
    navigator.serviceWorker.ready.then(function (reg) {
      reg.update();
    });
  }
  // Stop executing — the rest is service worker code
} else {
  // ============================================================
  // Mode 2: Service Worker
  // ============================================================

  // --- Bridge state (MessagePort-based HTTP protocol) ---
  var bridgePort = null;
  var pendingRequests = new Map();
  var nextRequestId = 0;
  var appPrefix = "/app/";

  // --- Cookie jar ---
  // (Set-Cookie on synthetic SW responses is ignored by the browser,
  // so the SW stores cookies and injects them into outgoing requests)
  var cookieJar = new Map();

  function parseSetCookie(header) {
    var parts = header.split(";").map(function (s) {
      return s.trim();
    });
    if (parts.length === 0) return null;
    var eqIdx = parts[0].indexOf("=");
    if (eqIdx < 0) return null;
    var name = parts[0].slice(0, eqIdx);
    var value = parts[0].slice(eqIdx + 1);
    var path = "/";
    var expires;
    for (var i = 1; i < parts.length; i++) {
      var lower = parts[i].toLowerCase();
      if (lower.startsWith("path=")) {
        path = parts[i].slice(5);
      } else if (lower.startsWith("expires=")) {
        var d = new Date(parts[i].slice(8));
        if (!isNaN(d.getTime())) expires = d.getTime();
      } else if (lower.startsWith("max-age=")) {
        var seconds = parseInt(parts[i].slice(8));
        if (!isNaN(seconds)) expires = Date.now() + seconds * 1000;
      }
    }
    return { name: name, value: value, path: path, expires: expires };
  }

  function storeCookies(setCookieValues) {
    for (var j = 0; j < setCookieValues.length; j++) {
      var cookie = parseSetCookie(setCookieValues[j]);
      if (!cookie) continue;
      if (cookie.expires !== undefined && cookie.expires < Date.now()) {
        cookieJar.delete(cookie.name);
      } else {
        // Prepend app prefix to cookie path so it matches browser-side URLs.
        // WordPress sets paths like "/" or "/wp-admin/" but the browser sees
        // "/app/" or "/app/wp-admin/".
        var prefix = appPrefix.slice(0, -1); // "/app" (or "/base/app")
        if (!cookie.path.startsWith(prefix)) {
          cookie.path = prefix + cookie.path;
        }
        cookieJar.set(cookie.name, cookie);
      }
    }
  }

  function getCookiesForPath(path) {
    var pairs = [];
    cookieJar.forEach(function (cookie, name) {
      if (cookie.expires !== undefined && cookie.expires < Date.now()) {
        cookieJar.delete(name);
        return;
      }
      if (path.startsWith(cookie.path)) {
        pairs.push(cookie.name + "=" + cookie.value);
      }
    });
    return pairs.join("; ");
  }

  // --- Bridge port setup ---
  function initBridgePort(port) {
    bridgePort = port;
    port.onmessage = function (event) {
      var msg = event.data;
      if (msg && msg.type === "http-response") {
        var pending = pendingRequests.get(msg.requestId);
        if (pending) {
          pendingRequests.delete(msg.requestId);
          pending.resolve({
            status: msg.status,
            headers: msg.headers,
            body: msg.body,
          });
        }
      } else if (msg && msg.type === "http-error") {
        var pending2 = pendingRequests.get(msg.requestId);
        if (pending2) {
          pendingRequests.delete(msg.requestId);
          pending2.reject(new Error(msg.error || "Bridge request failed"));
        }
      }
    };
  }

  function bridgeFetch(request) {
    if (!bridgePort) {
      return Promise.reject(new Error("Bridge port not initialized"));
    }
    var requestId = nextRequestId++;
    return new Promise(function (resolve, reject) {
      pendingRequests.set(requestId, { resolve: resolve, reject: reject });
      bridgePort.postMessage({
        type: "http-request",
        requestId: requestId,
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: request.body,
      });
    });
  }

  // --- Lifecycle ---
  self.addEventListener("install", function () {
    self.skipWaiting();
  });

  self.addEventListener("activate", function (event) {
    event.waitUntil(
      // Clear any Cache Storage entries from previous SW versions, then claim
      caches.keys().then(function (names) {
        return Promise.all(
          names.map(function (name) {
            return caches.delete(name);
          }),
        );
      }).then(function () {
        return self.clients.claim();
      }),
    );
  });

  // --- Configuration via postMessage ---
  self.addEventListener("message", function (event) {
    var msg = event.data;
    if (msg && msg.type === "init-bridge") {
      var port = event.ports[0];
      if (port) {
        initBridgePort(port);
        appPrefix = msg.appPrefix || "/app/";
        // Reset cookie jar when bridge reinitializes (new demo session)
        cookieJar.clear();
      }
      var replyPort = event.ports[1];
      if (replyPort) {
        replyPort.postMessage({ type: "bridge-ready" });
      }
    }
  });

  // --- CORS proxy URL (injected at build time, empty string in dev) ---
  var CORS_PROXY_URL = "__CORS_PROXY_URL__";

  /**
   * Check if a URL is cross-origin relative to the service worker's origin.
   */
  function isCrossOrigin(url) {
    return url.origin !== self.location.origin;
  }

  /**
   * Fetch a cross-origin URL, routing through the CORS proxy if configured.
   * Returns a Response with CORP headers added so COEP: require-corp is satisfied.
   */
  function fetchCrossOrigin(request) {
    var targetUrl = request.url;

    // If we have a CORS proxy, route through it
    if (CORS_PROXY_URL) {
      var proxyUrl = CORS_PROXY_URL + encodeURIComponent(targetUrl);
      return fetch(proxyUrl).then(function (response) {
        var headers = new Headers(response.headers);
        headers.set("Cross-Origin-Resource-Policy", "cross-origin");
        if (!headers.has("Cross-Origin-Embedder-Policy")) {
          headers.set("Cross-Origin-Embedder-Policy", "require-corp");
        }
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: headers,
        });
      });
    }

    // No CORS proxy — try direct fetch and add CORP headers
    return fetch(request).then(function (response) {
      if (response.type === "opaque" || response.type === "opaqueredirect") {
        return response;
      }
      var headers = new Headers(response.headers);
      if (!headers.has("Cross-Origin-Resource-Policy")) {
        headers.set("Cross-Origin-Resource-Policy", "cross-origin");
      }
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: headers,
      });
    });
  }

  // --- Fetch interception ---
  self.addEventListener("fetch", function (event) {
    var url = new URL(event.request.url);

    // Bridge requests — forward to kernel via MessageChannel
    if (url.pathname.startsWith(appPrefix) && bridgePort) {
      event.respondWith(handleAppRequest(event.request, url));
      return;
    }

    // Cross-origin requests — route through CORS proxy if available
    if (isCrossOrigin(url)) {
      event.respondWith(fetchCrossOrigin(event.request));
      return;
    }

    // Same-origin requests — pass through but add COI headers
    event.respondWith(
      (function () {
        // Navigation requests (HTML pages): revalidate with the server so
        // deploys take effect immediately. Vite's content-hashed asset
        // filenames handle JS/CSS/wasm cache busting, but only if the
        // HTML referencing them is fresh.
        var fetchOptions =
          event.request.mode === "navigate"
            ? new Request(event.request, { cache: "no-cache" })
            : event.request;

        return fetch(fetchOptions).then(function (response) {
          // Can't modify opaque or redirect responses
          if (
            response.type === "opaque" ||
            response.type === "opaqueredirect"
          ) {
            return response;
          }
          var headers = new Headers(response.headers);
          if (!headers.has("Cross-Origin-Opener-Policy")) {
            headers.set("Cross-Origin-Opener-Policy", "same-origin");
          }
          if (!headers.has("Cross-Origin-Embedder-Policy")) {
            headers.set("Cross-Origin-Embedder-Policy", "require-corp");
          }
          if (!headers.has("Cross-Origin-Resource-Policy")) {
            headers.set("Cross-Origin-Resource-Policy", "same-origin");
          }
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: headers,
          });
        });
      })(),
    );
  });

  function handleAppRequest(request, url) {
    return (async function () {
      try {
        // Strip the app prefix so nginx sees the original path
        var appPath = url.pathname.slice(appPrefix.length - 1); // Keep leading /

        var headers = {};
        request.headers.forEach(function (value, key) {
          headers[key] = value;
        });
        headers["host"] = url.host;

        // Inject cookies from our jar
        var jarCookies = getCookiesForPath(url.pathname);
        if (jarCookies) {
          var existing = headers["cookie"];
          headers["cookie"] = existing
            ? existing + "; " + jarCookies
            : jarCookies;
        }

        var body = null;
        if (request.method !== "GET" && request.method !== "HEAD") {
          var ab = await request.arrayBuffer();
          if (ab.byteLength > 0) {
            body = new Uint8Array(ab);
          }
        }

        var bridgeResp = await bridgeFetch({
          method: request.method,
          url: appPath + url.search,
          headers: headers,
          body: body,
        });

        // Store cookies from bridge response
        var rawSetCookie =
          bridgeResp.headers["Set-Cookie"] ||
          bridgeResp.headers["set-cookie"];
        if (rawSetCookie) {
          storeCookies(rawSetCookie.split("\n"));
        }

        // Build Response
        var respHeaders = new Headers();
        for (var key in bridgeResp.headers) {
          var lower = key.toLowerCase();
          if (
            lower === "transfer-encoding" ||
            lower === "connection" ||
            lower === "keep-alive"
          ) {
            continue;
          }
          if (lower === "set-cookie") {
            var cookies = bridgeResp.headers[key].split("\n");
            for (var c = 0; c < cookies.length; c++) {
              respHeaders.append(key, cookies[c]);
            }
          } else {
            respHeaders.set(key, bridgeResp.headers[key]);
          }
        }

        // Rewrite redirect Location: match protocol to request (avoid mixed
        // content on HTTPS) and add app prefix if missing.
        if (bridgeResp.status >= 300 && bridgeResp.status < 400) {
          var location =
            bridgeResp.headers["Location"] || bridgeResp.headers["location"];
          if (location) {
            try {
              var locUrl = new URL(location, url.origin);
              if (locUrl.hostname === url.hostname) {
                locUrl.protocol = url.protocol;
                if (!locUrl.pathname.startsWith(appPrefix)) {
                  locUrl.pathname = appPrefix.slice(0, -1) + locUrl.pathname;
                }
                respHeaders.set("Location", locUrl.toString());
              }
            } catch (e) {
              /* leave as-is */
            }
          }
        }

        // COEP/CORP for cross-origin isolation
        if (!respHeaders.has("Cross-Origin-Embedder-Policy")) {
          respHeaders.set("Cross-Origin-Embedder-Policy", "require-corp");
        }
        if (!respHeaders.has("Cross-Origin-Resource-Policy")) {
          respHeaders.set("Cross-Origin-Resource-Policy", "same-origin");
        }

        return new Response(bridgeResp.body, {
          status: bridgeResp.status,
          headers: respHeaders,
        });
      } catch (err) {
        return new Response("Bridge error: " + err, {
          status: 502,
          headers: {
            "Cross-Origin-Embedder-Policy": "require-corp",
            "Cross-Origin-Resource-Policy": "same-origin",
          },
        });
      }
    })();
  }
}

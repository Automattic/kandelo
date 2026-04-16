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
 *    - Auto-restores bridge after browser terminates and restarts the SW
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
  // Set to true once a bridge has been configured (via init-bridge or cache restore).
  // Used to distinguish "never configured" from "configured but SW restarted".
  var bridgeConfigured = false;

  // --- Bridge restoration state ---
  // Single in-flight restoration promise, shared by concurrent fetch events
  var bridgeRestorePromise = null;

  // Eagerly restore cached appPrefix on SW startup so we can detect
  // bridge-destined requests even after the browser terminates and
  // restarts this service worker (which resets all module-level state).
  var BRIDGE_CACHE = "sw-bridge-config";
  var appPrefixReady = caches.open(BRIDGE_CACHE).then(function (cache) {
    return cache.match("app-prefix");
  }).then(function (resp) {
    if (resp) return resp.text();
    return null;
  }).then(function (prefix) {
    if (prefix) {
      appPrefix = prefix;
      bridgeConfigured = true;
    }
  }).catch(function () {
    // Cache read failed — not critical, bridge restore will be skipped
  });

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

  // --- Bridge restoration ---
  // When the browser terminates and restarts this SW, bridgePort is lost.
  // These functions ask a client page to re-establish the bridge.

  function ensureBridge() {
    if (bridgePort) return Promise.resolve(true);
    if (bridgeRestorePromise) return bridgeRestorePromise;

    bridgeRestorePromise = requestBridgeFromClient().then(function (result) {
      bridgeRestorePromise = null;
      return result;
    }).catch(function () {
      bridgeRestorePromise = null;
      return false;
    });
    return bridgeRestorePromise;
  }

  function requestBridgeFromClient() {
    return self.clients.matchAll({ type: "window" }).then(function (allClients) {
      if (allClients.length === 0) return false;

      return new Promise(function (resolve) {
        var timeout = setTimeout(function () { resolve(false); }, 5000);
        var done = false;

        allClients.forEach(function (client) {
          var ch = new MessageChannel();
          ch.port1.onmessage = function (event) {
            if (done) return;
            var data = event.data;
            if (data && data.type === "bridge-restored" && event.ports[0]) {
              done = true;
              clearTimeout(timeout);
              initBridgePort(event.ports[0]);
              if (data.appPrefix) appPrefix = data.appPrefix;
              resolve(true);
            }
          };
          client.postMessage({ type: "need-bridge" }, [ch.port2]);
        });
      });
    });
  }

  // --- Lifecycle ---
  self.addEventListener("install", function () {
    self.skipWaiting();
  });

  self.addEventListener("activate", function (event) {
    event.waitUntil(
      // Clear Cache Storage entries from previous SW versions, but preserve
      // bridge config so we can restore the bridge after SW restart.
      caches.keys().then(function (names) {
        return Promise.all(
          names.filter(function (name) {
            return name !== BRIDGE_CACHE;
          }).map(function (name) {
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
        bridgeConfigured = true;
        // Reset cookie jar when bridge reinitializes (new demo session)
        cookieJar.clear();
        // Persist appPrefix so we can detect bridge-destined requests
        // after the browser terminates and restarts this SW
        caches.open(BRIDGE_CACHE).then(function (cache) {
          cache.put("app-prefix", new Response(appPrefix));
        }).catch(function () {});
      }
      var replyPort = event.ports[1];
      if (replyPort) {
        replyPort.postMessage({ type: "bridge-ready" });
      }
    }
  });

  // --- CORS proxy URL (injected at build time, empty string in dev) ---
  var CORS_PROXY_URL = "__CORS_PROXY_URL__";
  // In dev mode the placeholder is not replaced — treat as unconfigured
  if (CORS_PROXY_URL.indexOf("__") === 0) CORS_PROXY_URL = "";

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
      var proxyUrl = CORS_PROXY_URL + targetUrl;
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

  /**
   * Fetch a same-origin request and add COI headers.
   */
  function fetchWithCoiHeaders(request) {
    // Navigation requests (HTML pages): revalidate with the server so
    // deploys take effect immediately. Vite's content-hashed asset
    // filenames handle JS/CSS/wasm cache busting, but only if the
    // HTML referencing them is fresh.
    var fetchOptions =
      request.mode === "navigate"
        ? new Request(request, { cache: "no-cache" })
        : request;

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
      // fetch() auto-decompresses the body, so the stream is already decoded.
      // When the original response had Content-Encoding, remove it along with
      // Content-Length (which reflects the compressed size, not the decoded body).
      // Firefox throws NS_ERROR_CORRUPTED_CONTENT if Content-Encoding is kept
      // on an already-decoded body.  Only strip when Content-Encoding was present
      // so that uncompressed responses preserve their Content-Length (needed by
      // HEAD requests that check file sizes).
      if (headers.has("Content-Encoding")) {
        headers.delete("Content-Encoding");
        headers.delete("Content-Length");
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

    // Fast path: bridge is active and URL matches app prefix
    if (bridgePort && url.pathname.startsWith(appPrefix)) {
      event.respondWith(handleAppRequest(event.request, url));
      return;
    }

    // Cross-origin requests — route through CORS proxy if available
    if (isCrossOrigin(url)) {
      event.respondWith(fetchCrossOrigin(event.request));
      return;
    }

    // Bridge may need restoration (SW was terminated and restarted by browser).
    // Wait for cached appPrefix to load, then check if this URL should go
    // through the bridge.
    if (!bridgePort) {
      event.respondWith(
        appPrefixReady.then(function () {
          if (bridgeConfigured && url.pathname.startsWith(appPrefix)) {
            return ensureBridge().then(function (restored) {
              if (restored) {
                return handleAppRequest(event.request, url);
              }
              return new Response(
                "Service worker bridge unavailable — please reload the page",
                {
                  status: 503,
                  headers: {
                    "Content-Type": "text/plain",
                    "Cross-Origin-Embedder-Policy": "require-corp",
                    "Cross-Origin-Resource-Policy": "same-origin",
                  },
                },
              );
            });
          }
          return fetchWithCoiHeaders(event.request);
        })
      );
      return;
    }

    // Same-origin requests — pass through but add COI headers
    event.respondWith(fetchWithCoiHeaders(event.request));
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

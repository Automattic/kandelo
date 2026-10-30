/**
 * Unified Service Worker — dual-mode file that serves as both:
 *
 * 1. Page bootstrap script (when loaded via <script> tag):
 *    Detects if crossOriginIsolated is false, registers itself as a SW,
 *    then reloads the page so SharedArrayBuffer works.
 *
 * 2. Service Worker (when registered):
 *    - Adds COOP/COEP/CORP headers to ALL fetch responses → enables SharedArrayBuffer
 *    - Routes cross-origin reads through the CORS proxy, behind the
 *      credential gate
 *    - Caches lazy VFS assets
 *    - Revalidates navigation requests to ensure fresh HTML (cache busting)
 *    - Serves the viewer shell for `<scope>computer/<name>/…` navigations
 *
 * It serves no guest web page. Guest pages come from the deployment's
 * separate preview origin and its own service worker
 * (apps/browser-demos/preview-origin/), so guest scripts never run on this
 * origin. See docs/browser-support.md, "Guest web previews run on their own
 * origin".
 */

// ============================================================
// Mode 1: Page script — register this file as a service worker
// ============================================================
if (typeof window !== "undefined") {
  if ("serviceWorker" in navigator) {
    // document.currentScript is the deployment-owned authority for this
    // classic bootstrap. Its directory, not the page URL or a message, owns
    // the registration scope.
    var bootstrapScriptUrl = document.currentScript && document.currentScript.src;
    if (bootstrapScriptUrl) {
      var expectedBootstrapScriptUrl = new URL(bootstrapScriptUrl).href;
      var expectedBootstrapScopePath = new URL(
        "./",
        expectedBootstrapScriptUrl,
      ).pathname;
      var expectedBootstrapScopeUrl = new URL(
        expectedBootstrapScopePath,
        window.location.href,
      ).href;

      function waitForBootstrapActive(registration) {
        return new Promise(function (resolve, reject) {
          var observedWorkers = [];
          function cleanup() {
            registration.removeEventListener("updatefound", check);
            observedWorkers.forEach(function (worker) {
              worker.removeEventListener("statechange", check);
            });
          }
          function observe(worker) {
            if (!worker || observedWorkers.indexOf(worker) !== -1) return;
            observedWorkers.push(worker);
            worker.addEventListener("statechange", check);
          }
          function check() {
            observe(registration.installing);
            observe(registration.waiting);
            observe(registration.active);
            if (!registration.active) return;
            cleanup();
            if (registration.active.scriptURL !== expectedBootstrapScriptUrl) {
              reject(new Error("registered service worker active script mismatch"));
              return;
            }
            resolve(registration);
          }
          registration.addEventListener("updatefound", check);
          check();
        });
      }

      function waitForBootstrapController(registration) {
        return new Promise(function (resolve) {
          function check() {
            var controller = navigator.serviceWorker.controller;
            if (!controller || controller.scriptURL !== expectedBootstrapScriptUrl) {
              return;
            }
            navigator.serviceWorker.removeEventListener(
              "controllerchange",
              check,
            );
            resolve(registration);
          }
          navigator.serviceWorker.addEventListener("controllerchange", check);
          check();
        });
      }

      navigator.serviceWorker
        .register(expectedBootstrapScriptUrl, {
          scope: expectedBootstrapScopePath,
          updateViaCache: "none",
        })
        .then(function (registration) {
          if (registration.scope !== expectedBootstrapScopeUrl) {
            throw new Error("registered service worker scope mismatch");
          }
          return waitForBootstrapActive(registration);
        })
        .then(waitForBootstrapController)
        .then(function (registration) {
          if (window.crossOriginIsolated) {
            return registration.update();
          }
          window.location.reload();
        })
        .catch(function (err) {
          console.warn("[COI SW] registration failed:", err);
        });
    }
  }
  // Stop executing — the rest is service worker code
} else {
  // ============================================================
  // Mode 2: Service Worker
  // ============================================================

  // The registration scope is the durable ownership authority. Keep this
  // validator equivalent to normalizeDeploymentBase in kandelo-session: the
  // classic worker cannot import the TypeScript helper at runtime.
  function normalizeScopePath(value) {
    if (
      typeof value !== "string" || value === "" ||
      !value.startsWith("/") || !value.endsWith("/")
    ) {
      throw new Error("service worker registration scope path is invalid");
    }
    var sentinelOrigin = "https://kandelo.invalid";
    var parsed = new URL(value, sentinelOrigin);
    if (parsed.origin !== sentinelOrigin || parsed.pathname !== value) {
      throw new Error("service worker registration scope path is invalid");
    }
    if (value === "/") return value;

    var segments = value.slice(1, -1).split("/");
    if (segments.some(function (segment) { return segment === ""; })) {
      throw new Error("service worker registration scope path is invalid");
    }
    var percentEscape = /%[0-9a-f]{2}/i;
    segments.forEach(function (segment) {
      var decoded;
      try {
        decoded = decodeURIComponent(segment);
      } catch (_error) {
        throw new Error("service worker registration scope path is invalid");
      }
      if (
        decoded === "." || decoded === ".." || decoded.indexOf("/") !== -1 ||
        decoded.indexOf("\\") !== -1 || decoded.indexOf("\0") !== -1 ||
        percentEscape.test(decoded)
      ) {
        throw new Error("service worker registration scope path is invalid");
      }
    });
    return value;
  }

  function registrationScopePath() {
    var registrationUrl = new URL(self.registration.scope);
    var workerUrl = new URL(self.location.href);
    if (
      (registrationUrl.protocol !== "http:" &&
        registrationUrl.protocol !== "https:") ||
      (workerUrl.protocol !== "http:" && workerUrl.protocol !== "https:") ||
      registrationUrl.origin === "null" || workerUrl.origin === "null" ||
      registrationUrl.origin !== workerUrl.origin ||
      registrationUrl.username !== "" || registrationUrl.password !== "" ||
      registrationUrl.search !== "" || registrationUrl.hash !== ""
    ) {
      throw new Error("service worker registration scope authority is invalid");
    }
    return normalizeScopePath(registrationUrl.pathname);
  }

  var SCOPE_PATH = registrationScopePath();
  var CACHE_NAMESPACE = "kandelo-sw:" + encodeURIComponent(SCOPE_PATH) + ":";
  // Grouped builds replace this authenticated manifest digest. Ungrouped
  // deployments retain the established cache name.
  var LAZY_ASSET_CACHE_VERSION = null /*__KANDELO_VFS_LAZY_CACHE_VERSION__*/;
  var LAZY_ASSET_CACHE = CACHE_NAMESPACE +
    (LAZY_ASSET_CACHE_VERSION === null
      ? "lazy-assets-v1"
      : "lazy-assets-v1:" + LAZY_ASSET_CACHE_VERSION);
  // Keep equal to MACHINE_NAME_PATTERN and LEGACY_MACHINE_NAME_PATTERN in
  // lib/preview/protocol.ts (preview-bridge.test.ts checks). Old three-word
  // names still open the viewer shell, which explains they no longer work.
  var MACHINE_NAME_PATTERN = /^[a-z]{2,12}-[a-z]{2,12}-[a-z]{2,12}-[a-z2-7]{20}$/;
  var LEGACY_MACHINE_NAME_PATTERN = /^[a-z]{2,12}-[a-z]{2,12}-[a-z]{2,12}$/;

  // --- Lifecycle ---
  self.addEventListener("install", function () {
    self.skipWaiting();
  });

  self.addEventListener("activate", function (event) {
    event.waitUntil(
      // Delete only obsolete versions owned by this exact registration scope.
      // Legacy and sibling caches are outside this worker's proven authority.
      caches.keys().then(function (names) {
        return Promise.all(
          names.filter(function (name) {
            // Includes the retired "bridge-v2" cookie-jar cache: guest
            // cookies no longer live on this origin.
            return name.startsWith(CACHE_NAMESPACE) &&
              name !== LAZY_ASSET_CACHE;
          }).map(function (name) {
            return caches.delete(name);
          }),
        );
      }).then(function () {
        return self.clients.claim();
      }),
    );
  });

  // --- Complete CORS proxy profile (injected at build time) ---
  var CORS_PROXY_CONFIG = "__CORS_PROXY_CONFIG__";
  var proxySessionFactory = "__CORS_PROXY_SESSION_TRANSPORT__";
  var proxySessionFetch = typeof proxySessionFactory === "function" ? proxySessionFactory() : null;
  var corsProxyWarningKeys = new Set();

  // Mirror of the credential field set (ANONYMOUS_OMISSION_EXCLUDED_NAMES,
  // exported as CREDENTIAL_REQUEST_HEADER_NAMES) in
  // host/src/networking/browser-cors-proxy.ts. Only a request whose tag the
  // owning kernel worker vouches for may carry one to the proxy.
  var CREDENTIAL_REQUEST_HEADER_NAMES = new Set([
    "authorization", "chatgpt-account-id", "cookie", "cookie2",
    "proxy-authorization",
  ]);
  // Mirror of GRANTED_CREDENTIAL_REQUEST_HEADER_NAMES there: the fields a
  // verified grant lets through. Cookies and proxy credentials never pass.
  var GRANTED_CREDENTIAL_REQUEST_HEADER_NAMES = new Set([
    "authorization", "chatgpt-account-id",
  ]);
  // Mirror of CREDENTIAL_GRANT_REQUEST_HEADER and
  // CORS_PROXY_ALLOWED_REQUEST_HEADERS_HEADER there, lowercased.
  var CREDENTIAL_GRANT_HEADER = "x-kandelo-credential-grant";
  var CREDENTIAL_OPT_IN_HEADER = "x-cors-proxy-allowed-request-headers";

  function normalizedCorsProxyConfig() {
    if (!CORS_PROXY_CONFIG || typeof CORS_PROXY_CONFIG !== "object") return null;
    if (
      typeof CORS_PROXY_CONFIG.url !== "string" ||
      !Array.isArray(CORS_PROXY_CONFIG.allowedRequestHeaderNames) ||
      typeof CORS_PROXY_CONFIG.allowAnonymousGetHeaderOmission !== "boolean" ||
      (CORS_PROXY_CONFIG.rangeRequestHeaderAlias !== undefined &&
        typeof CORS_PROXY_CONFIG.rangeRequestHeaderAlias !== "string")
    ) {
      return null;
    }
    return CORS_PROXY_CONFIG;
  }

  function normalizedCorsProxyUrl() {
    var config = normalizedCorsProxyConfig();
    return config ? new URL(config.url, self.location.href).href : "";
  }

  // The development credential relay (loopback development servers only):
  // it carries its HTTPS destinations' requests in the proxy's place, with
  // the same projection, so a credential reaches it only with a verified
  // grant and the opt-in this worker re-derives. Mirror of
  // host/src/networking/credential-relay.ts.
  function credentialRelayConfig() {
    var config = normalizedCorsProxyConfig();
    var relay = config && config.credentialRelay;
    if (!relay || typeof relay.url !== "string" || !Array.isArray(relay.allowedOrigins)) {
      return null;
    }
    return relay;
  }

  // Mirror of credentialRelayCarries().
  function credentialRelayFor(targetUrl) {
    var relay = credentialRelayConfig();
    if (!relay) return null;
    try {
      return relay.allowedOrigins.indexOf(new URL(targetUrl).origin) >= 0 ? relay : null;
    } catch (_error) {
      return null;
    }
  }

  // Mirror of credentialRelayFetchUrl().
  function credentialRelayFetchUrl(relay, targetUrl) {
    return new URL(relay.url, self.location.href).href + "?url=" +
      encodeURIComponent(targetUrl);
  }

  function isCredentialRelayUrl(url) {
    var relay = credentialRelayConfig();
    if (!relay) return false;
    var endpoint = new URL(relay.url, self.location.href);
    return url.origin === endpoint.origin && url.pathname === endpoint.pathname;
  }

  function isCorsProxyFetchUrl(targetUrl) {
    var proxyUrl = normalizedCorsProxyUrl();
    return proxyUrl && targetUrl.startsWith(proxyUrl);
  }

  function isCorsProxySessionUrl(targetUrl) {
    var proxyUrl = normalizedCorsProxyUrl();
    return proxyUrl && targetUrl === new URL("/cors-proxy-session", proxyUrl).href;
  }

  function corsProxyTargetUrl(fetchUrl) {
    var proxyUrl = normalizedCorsProxyUrl();
    if (!proxyUrl || !fetchUrl.startsWith(proxyUrl)) return null;
    var suffix = fetchUrl.slice(proxyUrl.length);
    if (!suffix) return null;
    try {
      var targetUrl = proxyUrl.endsWith("?")
        ? suffix
        : decodeURIComponent(suffix);
      var target = new URL(targetUrl);
      return target.protocol === "http:" || target.protocol === "https:"
        ? target.href
        : null;
    } catch (_error) {
      return null;
    }
  }

  function corsProxyFetchUrl(targetUrl) {
    var proxyUrl = normalizedCorsProxyUrl();
    if (targetUrl.startsWith(proxyUrl)) {
      return targetUrl;
    }
    return proxyUrl + (
      proxyUrl.endsWith("?") ? targetUrl : encodeURIComponent(targetUrl)
    );
  }

  function proxyAllowedHeaderNames(config) {
    var allowed = new Set();
    config.allowedRequestHeaderNames.forEach(function (name) {
      allowed.add(String(name).toLowerCase());
    });
    return allowed;
  }

  // Request-header names the browser sets or forbids on every fetch(): a guest
  // value can never reach the origin regardless of the proxy allow-list, so
  // dropping them is the browser's own constraint, not a proxy-imposed loss.
  // Omitted for ANY method so body-bearing protocols (git smart-HTTP's
  // git-upload-pack POST, whose request carries content-length/accept-encoding/
  // user-agent) traverse the proxy instead of failing before dispatch.
  // Credential names (authorization/cookie/cookie2/proxy-authorization) are
  // NOT dropped here — they must still fail loudly. Kept in sync with
  // BROWSER_CONTROLLED_REQUEST_HEADER_NAMES in
  // host/src/networking/browser-cors-proxy.ts.
  var BROWSER_CONTROLLED_REQUEST_HEADER_NAMES = new Set([
    "accept-charset", "accept-encoding", "access-control-request-headers",
    "access-control-request-method", "connection", "content-length", "date",
    "dnt", "expect", "host", "keep-alive", "origin", "permissions-policy",
    "referer", "te", "trailer", "transfer-encoding", "upgrade", "via",
    "accept-language", "user-agent",
  ]);

  function isBrowserManagedRequestHeader(name) {
    return BROWSER_CONTROLLED_REQUEST_HEADER_NAMES.has(name) ||
      name.indexOf("proxy-") === 0 || name.indexOf("sec-") === 0;
  }

  function proxyProjectionFailure(request, targetUrl, unsupportedNames) {
    var targetOrigin = new URL(targetUrl).origin;
    return new Response(
      "Browser CORS proxy " + normalizedCorsProxyUrl() + " cannot relay " +
        request.method + " request to " + targetOrigin +
        " with unsupported request headers: " + unsupportedNames.join(", "),
      {
        status: 502,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      },
    );
  }

  // `grant` is credentialGate()'s finding that the owning kernel worker
  // vouched for this request's tag (null otherwise). Only then do the fields
  // a grant covers pass, with the proxy's opt-in re-derived here. The tag
  // itself never leaves the browser, granted or not.
  function projectCorsProxyRequest(request, outgoingUrl, targetUrl, grant) {
    var config = normalizedCorsProxyConfig();
    if (!config) return Promise.resolve(request);
    var allowed = proxyAllowedHeaderNames(config);
    var headers = new Headers();
    var unsupported = [];
    var credential = false;
    var grantedAuthorization = false;
    request.headers.forEach(function (value, name) {
      var lower = name.toLowerCase();
      if (lower === "x-kandelo-proxy-session") {
        // Reprojection owns quota metadata, just as it owns the range alias.
        // The session transport reads its own persisted, verified credential.
        // It authenticates this app to the proxy's quota service, never a
        // guest to a destination, so it is not a credential field here.
      } else if (lower === CREDENTIAL_GRANT_HEADER) {
        // Consumed by credentialGate(); upstream never sees it.
      } else if (lower === CREDENTIAL_OPT_IN_HEADER) {
        // Re-derived below from what a verified grant actually carries.
      } else if (grant && GRANTED_CREDENTIAL_REQUEST_HEADER_NAMES.has(lower)) {
        headers.append(name, value);
        if (lower === "authorization") grantedAuthorization = true;
        credential = true;
      } else if (CREDENTIAL_REQUEST_HEADER_NAMES.has(lower)) {
        // Credentials are never silently dropped, even though some match the
        // browser-managed prefixes below — surface them so the request fails
        // loudly instead of going out unauthenticated.
        unsupported.push(lower);
        credential = true;
      } else if (allowed.has(lower)) {
        headers.append(name, value);
      } else if (lower === "if-range") {
        // The proxy cannot carry it; fetchThroughCorsProxy applies its
        // semantics to the answer instead (RFC 9110 section 13.1.5).
      } else if (lower === config.rangeRequestHeaderAlias) {
        // Part of the WP Cloud Range workaround (see below). Projection owns
        // the alias: it is re-derived from Range below, so a caller's value is
        // never relayed. Kandelo's own kernel worker sends it when its guest
        // traffic reaches the proxy URL through this worker already
        // projected; that is not an unsupported field.
      } else if (isBrowserManagedRequestHeader(lower)) {
        // Fetch adds these fields independently of the Headers supplied by
        // callers. Do not copy them into the proxy request or classify them as
        // application-owned unsupported occurrences; Fetch will manage the
        // outer request's own values.
      } else {
        unsupported.push(lower);
      }
    });
    // WORKAROUND, mirroring BrowserCorsProxy.project(): WP Cloud, which hosts
    // the Playground CORS proxy, strips the Range header before the request
    // reaches the proxy's PHP, so the proxy also reads the same value from an
    // alias header (X-Cors-Proxy-Range). Send both. Remove this, the alias
    // handling above, and the no-store mode below as soon as WP Cloud relays
    // Range headers to PHP (see BrowserCorsProxyConfig.rangeRequestHeaderAlias
    // in host/src/networking/browser-cors-proxy.ts).
    var range = headers.get("range");
    if (config.rangeRequestHeaderAlias && range !== null) {
      headers.set(config.rangeRequestHeaderAlias, range);
    }
    if (grantedAuthorization) {
      // Mirrors BrowserCorsProxy.project(): the proxy relays Authorization
      // only when the request opts in to it by name.
      headers.set(CREDENTIAL_OPT_IN_HEADER, "Authorization");
    }
    var diagnosticNames = Array.from(new Set(unsupported)).sort();
    if (diagnosticNames.length > 0) {
      var canOmit = config.allowAnonymousGetHeaderOmission &&
        request.method === "GET" && !credential;
      if (!canOmit) {
        return Promise.resolve(
          proxyProjectionFailure(request, targetUrl, diagnosticNames),
        );
      }
      var targetOrigin = new URL(targetUrl).origin;
      var warningKey = targetOrigin + "\n" + diagnosticNames.join("\n");
      if (!corsProxyWarningKeys.has(warningKey)) {
        corsProxyWarningKeys.add(warningKey);
        console.warn(
          "Browser CORS proxy omitted unsupported request headers for " +
            targetOrigin + ": " + diagnosticNames.join(", "),
        );
      }
    }
    // The proxy URL differs from the page's, so this has to be a new Request.
    // Carry the page's abort signal across so a cancelled page fetch cancels
    // the proxied one before response headers, in browsers that signal it.
    // (Chromium and WebKit did not when measured 2026-09-26; after headers,
    // cancelling the response stream reaches the proxy regardless.)
    // Range survives through the allow-list above like any other field.
    var init = {
      method: request.method,
      headers: headers,
      // The deployment selects this proxy. Authenticate only to its own
      // origin; the proxy must remove application cookies before forwarding.
      // Reprojection must not anonymize a private same-origin proxy request.
      credentials: new URL(outgoingUrl).origin === self.location.origin
        ? "same-origin" : "omit",
      referrerPolicy: "strict-origin",
      mode: "cors",
      redirect: request.redirect,
      signal: request.signal,
    };
    if (config.rangeRequestHeaderAlias && headers.has(config.rangeRequestHeaderAlias)) {
      // WORKAROUND, part of the WP Cloud Range alias (mirrors
      // BrowserCorsProxy.fetch): the HTTP cache may shrink Range on the wire
      // to the bytes it has not stored, but not the alias, so the proxy would
      // answer a different range and the cache would join a short body. In
      // Chromium this also skips the preflight cache (documented technical
      // debt). Remove with the alias, as soon as WP Cloud relays Range
      // headers to PHP.
      init.cache = "no-store";
    }
    if (request.method === "GET" || request.method === "HEAD") {
      return Promise.resolve(new Request(outgoingUrl, init));
    }
    return request.arrayBuffer().then(function (body) {
      if (body.byteLength > 0) init.body = body;
      return new Request(outgoingUrl, init);
    });
  }

  // Mirror of ifRangeMatches() in host/src/networking/browser-cors-proxy.ts:
  // does a 206 satisfy an If-Range condition? Unconfirmable counts as no.
  function ifRangeMatches(ifRange, headers) {
    var value = ifRange.trim();
    if (value.indexOf("W/") === 0) return false;
    if (value.charAt(0) === '"') {
      return (headers.get("etag") || "").trim() === value;
    }
    var lastModified = (headers.get("last-modified") || "").trim();
    if (!lastModified || lastModified !== value) return false;
    var modified = Date.parse(lastModified);
    var date = Date.parse(headers.get("date") || "");
    return isFinite(modified) && isFinite(date) && date - modified >= 1000;
  }

  // Mirror of BrowserCorsProxy.fetch(): send the projected request and honor
  // an If-Range the proxy cannot carry. A 206 or 416 without the matching
  // validator is discarded for the whole representation, as a server whose
  // If-Range condition is false would send (RFC 9110 section 13.1.5). The
  // cost of doubt is one extra full request, never a slice of a changed
  // resource. Several If-Range fields reach here joined, which never match.
  function fetchThroughCorsProxy(request, outgoingUrl, targetUrl, grant) {
    var config = normalizedCorsProxyConfig();
    // The development relay's destinations go to the relay instead, projected
    // exactly as for the proxy (mirrors BrowserCorsProxy.fetch).
    var relay = credentialRelayFor(targetUrl);
    if (relay) outgoingUrl = credentialRelayFetchUrl(relay, targetUrl);
    var ifRange = config && !proxyAllowedHeaderNames(config).has("if-range")
      ? request.headers.get("if-range")
      : null;
    return projectCorsProxyRequest(request, outgoingUrl, targetUrl, grant || null).then(function (projected) {
      if (projected instanceof Response) return projected;
      function send(projected) {
        // Same-origin, so say so: the browser's own cookies are not the
        // guest's. The relay has no proxy session protocol.
        if (relay) return fetch(new Request(projected, { credentials: "omit" }));
        if (!proxySessionFetch) return fetch(projected);
        // Firefox can retain POST bytes internally while Request.body is null.
        // Read by method instead of using that getter to decide body presence.
        return (projected.method === "GET" || projected.method === "HEAD"
          ? Promise.resolve(undefined) : projected.arrayBuffer()).then(function (body) {
          return proxySessionFetch(projected.url, {
            method: projected.method, headers: projected.headers, body: body,
            credentials: projected.credentials, referrerPolicy: projected.referrerPolicy,
            mode: projected.mode, redirect: projected.redirect, cache: projected.cache, signal: projected.signal,
          }, function (url, init) { return fetch(new Request(url, init)); });
        });
      }
      return send(projected).then(function (response) {
        if (
          ifRange === null || projected.method !== "GET" ||
          (response.status !== 206 && response.status !== 416) ||
          ifRangeMatches(ifRange, response.headers)
        ) {
          return response;
        }
        if (response.body) response.body.cancel().catch(function () {});
        var headers = new Headers(projected.headers);
        headers.delete("range");
        if (config.rangeRequestHeaderAlias) {
          headers.delete(config.rangeRequestHeaderAlias);
        }
        return send(new Request(projected, { headers: headers, cache: "default" }));
      });
    });
  }

  /**
   * Check if a URL is cross-origin relative to the service worker's origin.
   */
  function isCrossOrigin(url) {
    return url.origin !== self.location.origin;
  }

  // --- Credential gate ---
  // The kernel worker adds credentials, the proxy's credential opt-in, and a
  // grant's tag only to requests a process the user granted wrote (see
  // host/src/credential-grants.ts). This is a second, independent gate at the
  // browser's network edge. What it guarantees: only Kandelo's kernel-worker
  // script can present a grant tag and vouch for it, so a page script, a
  // guest preview, or a worker started from any other script cannot send
  // credentials through the proxy.
  // - A proxy request that carries a credential field or the opt-in without
  //   a tag is refused.
  // - A tag is accepted only on a request to the configured proxy, from a
  //   dedicated worker running exactly the kernel worker's entry script
  //   (KERNEL_WORKER_SCRIPT_PATHS, injected at build time), and only once
  //   that worker has vouched for it: it holds a live grant with that token
  //   whose destinations include the target origin.
  // - The tag is removed before the request leaves the browser.
  // What it does not guarantee: any script the app's origin runs can still
  // start a genuine kernel worker and answer that kernel's credential prompt
  // itself. Guest web previews run on a separate preview origin, so the
  // app's origin runs only Kandelo's own code.
  // The answer is cached in memory only, keyed by token and bound to the
  // client that presented it; another client presenting the same tag is
  // refused without asking. An entry ends when the kernel worker announces
  // the grant ended, when a later verification finds its client gone, when
  // the bounded cache evicts it, or when this worker's state resets (an
  // update or an idle restart), after which the next request asks again.
  // There is no expiry: the kernel worker itself attaches a tag only after
  // the kernel confirms the grant for that request.
  //
  // WHY a BroadcastChannel question and a fetch answer: Chromium delivers no
  // Client.postMessage() to a dedicated worker (it has no
  // navigator.serviceWorker in workers; measured 2026-10-29), while every
  // engine delivers BroadcastChannel messages to workers. The browser stamps
  // the answering fetch with its sender's client id, which no script can
  // forge, and that client must be the kernel worker that presented the tag.
  // The broadcast carries the token's hash, never the token.
  // Mirror of CREDENTIAL_GATE_CHANNEL in host/src/credential-gate.ts.
  var CREDENTIAL_GATE_CHANNEL = "kandelo-credential-grants";
  var CREDENTIAL_GATE_REPLY_PATH = "__kandelo_credential_grant_reply";
  var CREDENTIAL_GATE_TIMEOUT_MS = 5000;
  var CREDENTIAL_GATE_CACHE_LIMIT = 256;
  var CREDENTIAL_GATE_REPLY_URL = new URL(
    CREDENTIAL_GATE_REPLY_PATH, self.registration.scope,
  ).href;
  // URL paths of the kernel worker's entry script, injected at build time by
  // apps/browser-demos/vite.config.ts. Not injected (a raw copy of this
  // file): no client can present a tag.
  var KERNEL_WORKER_SCRIPT_PATHS = "__KERNEL_WORKER_SCRIPT_PATHS__";
  var kernelWorkerScriptPaths = new Set(
    Array.isArray(KERNEL_WORKER_SCRIPT_PATHS) ? KERNEL_WORKER_SCRIPT_PATHS : [],
  );
  var credentialGrantCache = new Map(); // token -> { clientId, tokenHash, origins }
  var pendingCredentialVerifications = new Map(); // id -> { clientId, settle }
  var credentialGateChannel = typeof BroadcastChannel === "function"
    ? new BroadcastChannel(CREDENTIAL_GATE_CHANNEL) : null;
  if (credentialGateChannel) {
    credentialGateChannel.onmessage = function (event) {
      var message = event.data;
      if (
        !message || message.type !== "credential-grant-ended" ||
        typeof message.tokenHash !== "string"
      ) return;
      credentialGrantCache.forEach(function (entry, token) {
        if (entry.tokenHash === message.tokenHash) credentialGrantCache.delete(token);
      });
    };
  }

  function isCredentialGateReply(url) {
    return url.origin + url.pathname === CREDENTIAL_GATE_REPLY_URL;
  }

  function credentialRefusal(reason) {
    return new Response("Kandelo refused this request: " + reason + "\n", {
      status: 403,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  function carriesCredentialFields(request) {
    if (request.headers.has(CREDENTIAL_OPT_IN_HEADER)) return true;
    var found = false;
    CREDENTIAL_REQUEST_HEADER_NAMES.forEach(function (name) {
      if (request.headers.has(name)) found = true;
    });
    return found;
  }

  // Mirror of credentialTokenHash() in host/src/credential-gate.ts.
  function credentialTokenHash(token) {
    return crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))
      .then(function (digest) {
        var binary = "";
        new Uint8Array(digest).forEach(function (byte) {
          binary += String.fromCharCode(byte);
        });
        return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_")
          .replace(/=+$/, "");
      });
  }

  // Only Kandelo's kernel worker presents a grant tag: a dedicated worker on
  // this origin whose script is exactly the kernel worker's entry (origin
  // and path; the query Vite adds in development is ignored). Windows
  // (pages, frames, guest previews) and workers started from any other
  // script, including a blob: or data: URL or a proxied third-party body,
  // never do.
  function isCredentialGateClient(client) {
    if (!client || client.type !== "worker") return false;
    var clientUrl;
    try {
      clientUrl = new URL(client.url);
    } catch (_error) {
      return false;
    }
    if (clientUrl.protocol !== "http:" && clientUrl.protocol !== "https:") return false;
    if (clientUrl.origin !== self.location.origin) return false;
    return kernelWorkerScriptPaths.has(clientUrl.pathname);
  }

  function answerCredentialGateReply(event) {
    if (event.request.method !== "POST") {
      return Promise.resolve(new Response(null, { status: 405 }));
    }
    return event.request.text().then(function (text) {
      var reply = null;
      try {
        reply = JSON.parse(text);
      } catch (_error) {
        reply = null;
      }
      var pending = reply && typeof reply.id === "string"
        ? pendingCredentialVerifications.get(reply.id) : undefined;
      if (
        !pending || pending.clientId !== event.clientId ||
        reply.type !== "credential-grant-verified" ||
        typeof reply.valid !== "boolean"
      ) {
        return new Response(null, { status: 403 });
      }
      pending.settle(reply.valid);
      return new Response(null, { status: 204 });
    });
  }

  function askKernelWorker(clientId, token, origin) {
    return credentialTokenHash(token).then(function (tokenHash) {
      return new Promise(function (resolve) {
        var id = crypto.randomUUID();
        var timer = setTimeout(function () { settle(false); }, CREDENTIAL_GATE_TIMEOUT_MS);
        function settle(valid) {
          clearTimeout(timer);
          pendingCredentialVerifications.delete(id);
          resolve({ valid: valid, tokenHash: tokenHash });
        }
        pendingCredentialVerifications.set(id, { clientId: clientId, settle: settle });
        credentialGateChannel.postMessage({
          type: "credential-grant-verify",
          id: id,
          tokenHash: tokenHash,
          origin: origin,
          replyUrl: CREDENTIAL_GATE_REPLY_URL,
        });
      });
    });
  }

  function pruneCredentialGrantCache() {
    credentialGrantCache.forEach(function (entry, token) {
      self.clients.get(entry.clientId).then(function (client) {
        if (!client) credentialGrantCache.delete(token);
      }).catch(function () {});
    });
  }

  // Bounded: a grant evicted here is simply asked about again.
  function rememberCredentialGrant(token, entry) {
    credentialGrantCache.set(token, entry);
    while (credentialGrantCache.size > CREDENTIAL_GATE_CACHE_LIMIT) {
      credentialGrantCache.delete(credentialGrantCache.keys().next().value);
    }
  }

  // Resolves to null (nothing to gate), { token } (a verified grant), or a
  // 403 Response. `targetUrl` is where the proxy would send the request, or
  // null when the request is not going to the configured proxy.
  function credentialGate(event, targetUrl) {
    var request = event.request;
    var tag = request.headers.get(CREDENTIAL_GRANT_HEADER);
    if (tag === null) {
      return Promise.resolve(carriesCredentialFields(request)
        ? credentialRefusal(
          "it carries credentials, or the CORS proxy's credential opt-in, " +
            "without a Kandelo credential grant.",
        )
        : null);
    }
    var target = null;
    try {
      target = targetUrl ? new URL(targetUrl) : null;
    } catch (_error) {
      target = null;
    }
    if (!target || target.protocol !== "https:") {
      return Promise.resolve(credentialRefusal(
        "a credential grant tag is accepted only on HTTPS requests through " +
          "the configured CORS proxy.",
      ));
    }
    var origin = target.origin;
    var clientId = event.clientId;
    var cached = credentialGrantCache.get(tag);
    if (cached && cached.clientId !== clientId) {
      return Promise.resolve(credentialRefusal(
        "its credential grant tag belongs to another client.",
      ));
    }
    if (cached && cached.origins.has(origin)) {
      return Promise.resolve({ token: tag });
    }
    var refused = credentialRefusal(
      "no Kandelo process holds a credential grant for this request.",
    );
    if (!clientId || !credentialGateChannel) return Promise.resolve(refused);
    return self.clients.get(clientId).then(function (client) {
      if (!isCredentialGateClient(client)) return refused;
      return askKernelWorker(clientId, tag, origin).then(function (answer) {
        pruneCredentialGrantCache();
        if (!answer.valid) return refused;
        // Another client may have presented the tag while this one waited.
        var entry = credentialGrantCache.get(tag);
        if (entry && entry.clientId !== clientId) return refused;
        if (!entry) {
          entry = { clientId: clientId, tokenHash: answer.tokenHash, origins: new Set() };
          rememberCredentialGrant(tag, entry);
        }
        entry.origins.add(origin);
        return { token: tag };
      });
    });
  }

  function isCorsProxyRequestUrl(href) {
    return isCorsProxyFetchUrl(href) && !isCorsProxySessionUrl(href);
  }

  // Mirror of devCorsProxyPathForBase() in apps/browser-demos/vite.config.ts:
  // the development relay's path, which exists only on a Vite server and may
  // not be the configured proxy (VITE_CORS_PROXY_URL).
  function isDevCorsProxyUrl(url) {
    return !isCrossOrigin(url) && url.pathname === SCOPE_PATH + "__kandelo_cors_proxy";
  }

  // A proxy answers with a third party's bytes. Only fetch() (destination
  // "") may read them. As a document, frame, script, worker or style they
  // would render or run, and from a same-origin proxy they would run with
  // this origin's authority: a worker started from a proxied body could, for
  // one, pose as Kandelo code.
  function proxyDestinationRefusal(request, url) {
    if (request.destination === "") return null;
    if (
      !isCorsProxyRequestUrl(url.href) && !isDevCorsProxyUrl(url) &&
      !isCredentialRelayUrl(url)
    ) return null;
    return new Response(
      "Kandelo refused this request: the CORS proxy's answers are data for " +
        "fetch(), not for a load as " + request.destination + ".\n",
      { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  }

  function isCanonicalPagesVfsRequest(request, url) {
    if (
      request.method !== "GET" || request.mode === "navigate" ||
      isCrossOrigin(url) || url.search || url.hash
    ) return false;
    var scriptPath = new URL(self.location.href).pathname;
    var basePath = scriptPath.slice(0, scriptPath.lastIndexOf("/") + 1);
    if (!url.pathname.startsWith(basePath)) return false;
    var relative = url.pathname.slice(basePath.length);
    var match = relative.match(
      /^products\/([a-z0-9][a-z0-9._-]{0,127})\/sha256-([0-9a-f]{64})\/([a-z0-9][a-z0-9._-]{0,127})-([1-9][0-9]*)\.vfs\.zst$/,
    );
    return match !== null && match[1] === match[3];
  }

  function isScopedLazyVfsRequest(request, url) {
    return request.method === "GET" &&
      request.mode !== "navigate" &&
      !isCrossOrigin(url) &&
      url.search === "" &&
      url.hash === "" &&
      url.pathname.startsWith(SCOPE_PATH + "vfs-groups/");
  }

  // Cache a lazy group asset while the page reads it. The page gets the
  // native response at once, so its download progress counts bytes as they
  // arrive; waiting for the whole body first made a 177 MB program show no
  // progress until it had finished. The cache gets a clone of that response,
  // never a rebuilt one: rebuilding would remove the authenticated
  // Content-Length the lazy VFS integrity check consumes.
  //
  // Only a complete body becomes an entry. cache.put() reads the clone to its
  // end before it stores anything, and rejects if the body errors, so a
  // download the network drops leaves no entry. The rejection needs no
  // report: the page sees the same failure on its own copy of the stream.
  // A page that aborts ends only its own copy. Chromium, Firefox and WebKit
  // keep this worker's fetch running (as they did when the worker held the
  // response), so the download still completes into the cache.
  //
  // Memory: the clone tees the body, and a tee holds each chunk until both
  // copies have read it. Whichever copy reads slower (the page, if it stalls
  // while the cache keeps writing) leaves its unread bytes queued in this
  // worker, up to the whole body. Holding the response until the cache was
  // done held all of it, twice, every time.
  function cacheCompleteLazyVfsResponse(request, response) {
    if (response.status !== 200 || response.type !== "basic" || response.body === null) {
      return Promise.resolve();
    }
    var copy = response.clone();
    return caches.open(LAZY_ASSET_CACHE).then(function (cache) {
      return cache.put(request, copy);
    }).catch(function () {
      if (copy.bodyUsed) return;
      // The cache never started reading; release the tee so it does not
      // hold the page's bytes for a reader that will never come.
      return copy.body.cancel().catch(function () {});
    });
  }

  function fetchScopedLazyVfsRequest(event) {
    var request = event.request;
    // Keep the worker alive until the cache write finishes, which is after
    // the page already has its response. Register the promise now, while
    // the event is dispatching, where every engine accepts waitUntil().
    var finishCacheWrite;
    event.waitUntil(new Promise(function (resolve) {
      finishCacheWrite = resolve;
    }));
    var answer = caches.keys().then(function (cacheNames) {
      if (cacheNames.indexOf(LAZY_ASSET_CACHE) === -1) return null;
      return caches.open(LAZY_ASSET_CACHE).then(function (cache) {
        return cache.match(request);
      });
    }).then(function (cached) {
      if (cached) return cached;
      return fetch(request).then(function (response) {
        finishCacheWrite(cacheCompleteLazyVfsResponse(request, response));
        return response;
      });
    });
    // A cache hit or a failed fetch has no cache write to wait for. (A
    // second resolve() after the one above changes nothing.)
    answer.then(function () { finishCacheWrite(); }, function () { finishCacheWrite(); });
    return answer;
  }

  /**
   * Fetch a cross-origin URL, routing through the CORS proxy if configured.
   * The body must first be readable through CORS. The synthetic response then
   * carries the policy headers needed by the cross-origin-isolated page.
   */
  function corsSafeResponseHeaders(response) {
    var headers = new Headers();
    [
      "Accept-Ranges",
      "Cache-Control",
      "Content-Length",
      "Content-Range",
      "Content-Type",
      "ETag",
      "Expires",
      "Last-Modified",
      "Retry-After",
      "X-Kandelo-Proxy-Session",
    ].forEach(function (name) {
      var value = response.headers.get(name);
      if (value) headers.set(name, value);
    });

    // The page is cross-origin isolated. Cross-origin fetch() requests are
    // allowed by COEP when they pass CORS, and this synthetic response is the
    // response the page sees. Do not depend on the proxy or upstream server to
    // provide these policy headers.
    headers.set("Access-Control-Allow-Origin", self.location.origin);
    headers.set("Access-Control-Allow-Credentials", "true");
    headers.set("Access-Control-Expose-Headers", [
      "Accept-Ranges",
      "Content-Length",
      "Content-Range",
      "Content-Type",
      "ETag",
      "Last-Modified",
      "Retry-After",
      "X-Kandelo-Proxy-Session",
      "X-Playground-Cors-Proxy",
    ].join(", "));
    headers.set("Cross-Origin-Resource-Policy", "cross-origin");
    headers.set("Cross-Origin-Embedder-Policy", "require-corp");
    headers.append("Vary", "Origin");
    return headers;
  }

  function isNullBodyStatus(status) {
    return status === 204 || status === 205 || status === 304;
  }

  function responseBodyForStatus(status, body) {
    return isNullBodyStatus(status) ? null : body;
  }

  function responseWithHeaders(response, headers) {
    return new Response(responseBodyForStatus(response.status, response.body), {
      status: response.status,
      statusText: response.statusText,
      headers: headers,
    });
  }

  // Gate, then relay through the proxy. The refusal gets the same CORS and
  // embedder-policy headers as a relayed answer so the caller can read it.
  function fetchGatedThroughCorsProxy(event, outgoingUrl, targetUrl, gateTargetUrl) {
    var request = event.request;
    return credentialGate(event, gateTargetUrl).then(function (gate) {
      if (gate instanceof Response) return gate;
      return fetchThroughCorsProxy(request, outgoingUrl, targetUrl, gate);
    }).then(function (response) {
      var headers = corsSafeResponseHeaders(response);
      return responseWithHeaders(response, headers);
    });
  }

  // A request to the development credential relay (the kernel worker's, or
  // any script's) passes the same gate as one to the proxy, then goes on
  // projected: credentials and the re-derived opt-in only with a verified
  // grant, never the tag. The relay's own answer, already limited to inert
  // fields, comes back unchanged.
  function fetchGatedThroughCredentialRelay(event, url) {
    var targetUrl = null;
    try {
      targetUrl = new URL(url.searchParams.get("url")).href;
    } catch (_error) {
      targetUrl = null;
    }
    var relayable = targetUrl !== null && credentialRelayFor(targetUrl) !== null;
    return credentialGate(event, relayable ? targetUrl : null).then(function (gate) {
      if (gate instanceof Response) return gate;
      // Nothing to relay (the relay answers 404, 400 or 403 itself), and
      // nothing credentialed to forward.
      if (!relayable) return fetch(event.request);
      return fetchThroughCorsProxy(event.request, url.href, targetUrl, gate);
    });
  }

  function fetchCrossOrigin(event) {
    var request = event.request;
    var targetUrl = request.url;

    // This fixed endpoint belongs to the configured proxy's quota protocol.
    // Wrapping it as an asset would recurse into that proxy's self-target ban.
    if (isCorsProxySessionUrl(targetUrl)) return fetch(request);

    // The page and worker runtime may already be deliberately fetching the
    // configured CORS proxy. Do not wrap that request in the same proxy again.
    if (isCorsProxyFetchUrl(targetUrl)) {
      var proxiedTargetUrl = corsProxyTargetUrl(targetUrl);
      return fetchGatedThroughCorsProxy(
        event, targetUrl, proxiedTargetUrl || targetUrl, proxiedTargetUrl,
      );
    }

    // If we have a CORS proxy, route reads through it. The proxy exists to
    // make CORS-less GET/HEAD subresources readable under COEP; its only POST
    // authority is the reviewed git-upload-pack boundary, and that traffic
    // targets the proxy URL deliberately. A body-bearing page request belongs
    // to a server that speaks CORS itself — the signalling piplet, for one —
    // so wrapping it turns a working direct request into a relay refusal.
    if (
      normalizedCorsProxyConfig() &&
      (request.method === "GET" || request.method === "HEAD")
    ) {
      var proxyUrl = corsProxyFetchUrl(targetUrl);
      // A tag is meaningful only on the kernel worker's own proxy requests,
      // so gate as for a request that is not going to the proxy.
      return fetchGatedThroughCorsProxy(event, proxyUrl, targetUrl, null);
    }

    // No proxy: try a normal CORS fetch. Policy headers are useful only after
    // CORS has made the response body readable; they cannot un-opaque a body.
    return fetch(request).then(function (response) {
      if (response.type === "opaque" || response.type === "opaqueredirect") {
        return response;
      }
      var headers = corsSafeResponseHeaders(response);
      return responseWithHeaders(response, headers);
    });
  }

  // Only Kandelo may frame a Kandelo document: a guest page on the preview
  // origin must not frame the app (for example to clickjack the credential
  // prompt of a machine it embeds). Hosts that cannot send headers get them
  // here; a deployment's own frame-ancestors policy is kept.
  function addDocumentHeaders(headers) {
    var policy = headers.get("Content-Security-Policy");
    if (!policy || !/(?:^|;)\s*frame-ancestors\s/i.test(policy)) {
      headers.set(
        "Content-Security-Policy",
        policy ? policy + "; frame-ancestors 'self'" : "frame-ancestors 'self'",
      );
    }
    if (!headers.has("Origin-Agent-Cluster")) headers.set("Origin-Agent-Cluster", "?1");
    return headers;
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
      if (request.mode === "navigate") addDocumentHeaders(headers);
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
      return responseWithHeaders(response, headers);
    });
  }

  // --- Kandelo's own computer/ addresses ---
  // `<scope>computer/<name>/<path>` is the address users share and terminal
  // links open. On this origin it is only ever the viewer shell, a Kandelo
  // page that embeds the guest page from the preview origin. Anything else
  // under computer/ is refused: guest bytes never come from this origin.
  var COMPUTER_ROOT = SCOPE_PATH + "computer";
  var VIEWER_SHELL_URL = SCOPE_PATH + "pages/kandelo/viewer.html";

  function computerRefusal() {
    return new Response(
      "Guest web pages are served from this deployment's preview origin.\n",
      {
        status: 404,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cross-Origin-Embedder-Policy": "require-corp",
          "Cross-Origin-Resource-Policy": "same-origin",
        },
      },
    );
  }

  function serveComputerAddress(request, url) {
    var name = url.pathname.slice(COMPUTER_ROOT.length + 1).split("/")[0];
    if (
      request.mode !== "navigate" ||
      (request.method !== "GET" && request.method !== "HEAD") ||
      !(MACHINE_NAME_PATTERN.test(name) || LEGACY_MACHINE_NAME_PATTERN.test(name))
    ) {
      return Promise.resolve(computerRefusal());
    }
    return fetchWithCoiHeaders(
      new Request(VIEWER_SHELL_URL, { cache: "no-cache", credentials: "same-origin" }),
    ).then(function (response) {
      if (!response.ok) return computerRefusal();
      var headers = new Headers(response.headers);
      addDocumentHeaders(headers);
      return new Response(request.method === "HEAD" ? null : response.body, {
        status: 200,
        headers: headers,
      });
    });
  }

  // --- Fetch interception ---
  self.addEventListener("fetch", function (event) {
    var url = new URL(event.request.url);

    // A kernel worker's answer to the credential gate (see credentialGate).
    if (!isCrossOrigin(url) && isCredentialGateReply(url)) {
      event.respondWith(answerCredentialGateReply(event));
      return;
    }

    var proxyRefusal = proxyDestinationRefusal(event.request, url);
    if (proxyRefusal) {
      event.respondWith(proxyRefusal);
      return;
    }

    if (!isCrossOrigin(url) && isCredentialRelayUrl(url)) {
      event.respondWith(fetchGatedThroughCredentialRelay(event, url));
      return;
    }

    // A grant's tag is meaningful only on the way to the configured proxy
    // (or the development relay, above); anywhere else it is refused rather
    // than sent on.
    if (
      event.request.headers.has(CREDENTIAL_GRANT_HEADER) &&
      !isCorsProxyRequestUrl(url.href)
    ) {
      event.respondWith(credentialGate(event, null).then(function (refusal) {
        return isCrossOrigin(url)
          ? responseWithHeaders(refusal, corsSafeResponseHeaders(refusal))
          : refusal;
      }));
      return;
    }

    // Group assets have an immutable deployment-local identity. Cache only
    // their complete native responses before bridge/proxy/header rewriting.
    if (isScopedLazyVfsRequest(event.request, url)) {
      event.respondWith(fetchScopedLazyVfsRequest(event));
      return;
    }

    // Cross-origin requests — route through CORS proxy if available.
    if (isCrossOrigin(url)) {
      event.respondWith(fetchCrossOrigin(event));
      return;
    }

    // A same-origin proxy (the development relay) is gated like any other;
    // ordinary traffic to it passes untouched.
    if (
      isCorsProxyRequestUrl(url.href) &&
      (event.request.headers.has(CREDENTIAL_GRANT_HEADER) ||
        carriesCredentialFields(event.request))
    ) {
      event.respondWith(credentialGate(event, corsProxyTargetUrl(url.href)).then(function (gate) {
        if (gate instanceof Response) return gate;
        var headers = new Headers(event.request.headers);
        headers.delete(CREDENTIAL_GRANT_HEADER);
        return fetchWithCoiHeaders(new Request(event.request, { headers: headers }));
      }));
      return;
    }

    // A native same-origin Response retains its authenticated Content-Length
    // and streaming body. Reconstructing it below strips that forbidden
    // response header in browsers. Exact canonical Pages VFS paths need no
    // additional CORP/COEP headers because they are same-origin resources.
    if (isCanonicalPagesVfsRequest(event.request, url)) {
      event.respondWith(fetch(event.request));
      return;
    }

    if (
      url.pathname === COMPUTER_ROOT ||
      url.pathname.indexOf(COMPUTER_ROOT + "/") === 0
    ) {
      event.respondWith(serveComputerAddress(event.request, url));
      return;
    }

    event.respondWith(fetchWithCoiHeaders(event.request));
  });
}

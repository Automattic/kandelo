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
  var BRIDGE_CACHE = CACHE_NAMESPACE + "bridge-v2";
  var BRIDGE_AUTHORITY_KEY = "bridge-authority-v1";
  var BRIDGE_AUTHORITY_VERSION = 1;
  var BRIDGE_AUTHORITY_MAX_BYTES = 64 * 1024;
  var BRIDGE_AUTHORITY_MAX_COOKIES = 32;
  var BRIDGE_APP_PREFIX_MAX_BYTES = 4096;
  var BRIDGE_COOKIE_NAME_MAX_BYTES = 256;
  var BRIDGE_COOKIE_VALUE_MAX_BYTES = 4096;
  var BRIDGE_COOKIE_PATH_MAX_BYTES = 4096;
  var BRIDGE_REVISION_LIMIT = Number.MAX_SAFE_INTEGER;
  var COOKIE_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
  var INVALID_COOKIE_FIELD_PATTERN = /[\u0000-\u001f\u007f;]/;
  // Grouped builds replace this authenticated manifest digest. Ungrouped
  // deployments retain the established cache name.
  var LAZY_ASSET_CACHE_VERSION = null /*__KANDELO_VFS_LAZY_CACHE_VERSION__*/;
  var LAZY_ASSET_CACHE = CACHE_NAMESPACE +
    (LAZY_ASSET_CACHE_VERSION === null
      ? "lazy-assets-v1"
      : "lazy-assets-v1:" + LAZY_ASSET_CACHE_VERSION);
  var SESSION_ID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  // --- SW-minted machine names ---
  // The service worker owns machine naming. On init-bridge it mints a
  // three-word name (adjective-color-noun), so every live machine has a
  // stable, shareable /app/<name>/ URL. The word lists are embedded here as
  // static data (not build-injected): the classic worker cannot import a
  // module, minting must always work — including in the Playwright harness
  // that serves near-raw worker source — and the lists have no deployment
  // variance. Three lists of >=128 distinct words give >=128^3 (~2M)
  // combinations, so live collisions are negligible; mintInstanceName still
  // regenerates on the rare hit. Keep each list alphabetized, deduplicated,
  // lowercase [a-z], and within the 2-12 length bound the validator enforces.
  var INSTANCE_ADJECTIVES = [
    "able", "active", "agile", "alert", "amused", "ardent", "artful", "awake",
    "balmy", "blithe", "bold", "bonny", "brave", "bright", "brisk", "bubbly",
    "busy", "calm", "canny", "cheery", "chipper", "civil", "classy", "clean",
    "clear", "clever", "cozy", "crafty", "crisp", "curious", "cute", "dapper",
    "daring", "dashing", "deft", "dreamy", "driven", "eager", "early",
    "earnest", "easy", "elated", "epic", "fair", "fancy", "festive", "fiery",
    "fleet", "fond", "frank", "free", "fresh", "frisky", "funny", "fuzzy",
    "gallant", "game", "genial", "gentle", "giddy", "gifted", "glad", "glossy",
    "golden", "good", "graceful", "grand", "grateful", "groovy", "handy",
    "happy", "hardy", "hearty", "helpful", "heroic", "honest", "hopeful",
    "humble", "ideal", "jaunty", "jazzy", "jolly", "jovial", "joyful",
    "joyous", "keen", "kind", "kindly", "lavish", "lean", "limber", "lithe",
    "lively", "lofty", "loyal", "lucid", "lucky", "lush", "magic", "mellow",
    "merry", "mighty", "mild", "mindful", "modest", "neat", "nice", "nimble",
    "noble", "plucky", "poised", "polite", "prime", "prompt", "proud", "pure",
    "quaint", "quick", "quiet", "quirky", "rapid", "ready", "regal", "robust",
    "rosy", "ruddy", "sage", "saucy", "savvy", "serene", "sharp", "shiny",
    "silky", "sleek", "smart", "snappy", "snazzy", "spry", "stable", "steady",
    "sturdy", "suave", "sunny", "super", "sweet", "swift", "tame", "tender",
    "tidy", "trusty", "upbeat", "urbane", "valiant", "vibrant", "vital",
    "vivid", "warm", "wily", "winning", "wise", "witty", "zany", "zesty",
  ];
  var INSTANCE_COLORS = [
    "amber", "amethyst", "apricot", "aqua", "ash", "auburn", "azure", "beige",
    "beryl", "black", "blond", "blue", "blush", "brass", "bronze", "brown",
    "buff", "burgundy", "canary", "caramel", "cardinal", "carmine", "celadon", "cerise",
    "cerulean", "charcoal", "cherry", "chestnut", "chocolate", "cinnamon", "citrine", "claret",
    "cobalt", "coffee", "copper", "coral", "cornflower", "cream", "crimson", "cyan",
    "denim", "ebony", "ecru", "emerald", "fawn", "flax", "fuchsia", "garnet",
    "ginger", "gold", "golden", "gray", "green", "heather", "henna", "honey",
    "indigo", "ivory", "jade", "jasmine", "jet", "khaki", "lavender", "lemon",
    "lilac", "lime", "magenta", "mahogany", "maize", "maroon", "mauve", "mint",
    "mocha", "mulberry", "mustard", "navy", "ochre", "olive", "onyx", "opal",
    "orange", "orchid", "peach", "pearl", "periwinkle", "pewter", "pine", "pink",
    "plum", "puce", "pumpkin", "purple", "quartz", "raisin", "red", "rose",
    "ruby", "russet", "rust", "saffron", "salmon", "sand", "sapphire", "scarlet",
    "sepia", "sienna", "silver", "slate", "snow", "steel", "straw", "sunset",
    "tan", "tangerine", "taupe", "teal", "terra", "topaz", "turquoise", "umber",
    "verdant", "vermilion", "violet", "viridian", "wheat", "white", "wine", "wisteria",
    "yellow",
  ];
  var INSTANCE_NOUNS = [
    "acorn", "alder", "almond", "antler", "arbor", "aspen", "badger", "bamboo",
    "basil", "beacon", "beaver", "birch", "bison", "bloom", "bluff", "bramble",
    "branch", "breeze", "brook", "buck", "cactus", "canyon", "cedar", "cliff",
    "clover", "comet", "cove", "crane", "creek", "crocus", "crow", "daisy",
    "dale", "dawn", "delta", "dingo", "dolphin", "dove", "dune", "dusk",
    "eagle", "egret", "elk", "ember", "falcon", "fawn", "fern", "finch",
    "fjord", "forest", "fox", "frost", "garden", "glacier", "glade", "grove",
    "gull", "harbor", "hare", "hawk", "hazel", "heath", "heron", "hollow",
    "holly", "ibis", "inlet", "iris", "island", "jay", "juniper", "kelp",
    "kestrel", "koala", "lagoon", "lake", "lark", "laurel", "leaf", "ledge",
    "lily", "linden", "lotus", "lynx", "magpie", "mallard", "maple", "marsh",
    "meadow", "mesa", "mist", "moose", "moss", "moth", "nectar", "nettle",
    "oak", "oasis", "ocean", "orchard", "osprey", "otter", "owl", "palm",
    "panther", "peak", "pebble", "petal", "pigeon", "plateau", "pond", "poppy",
    "prairie", "quail", "rabbit", "raven", "reed", "reef", "ridge", "river",
    "robin", "rowan", "sable", "sequoia", "shore", "sparrow", "spruce", "star",
    "stone", "storm", "stream", "summit", "swan", "teak", "thistle", "thorn",
    "thrush", "tiger", "timber", "tulip", "tundra", "valley", "vine", "vireo",
    "walnut", "warbler", "wave", "willow", "wolf", "wombat", "wren", "yarrow",
    "yew", "zephyr",
  ];
  var INSTANCE_NAME_PATTERN = /^[a-z]{2,12}-[a-z]{2,12}-[a-z]{2,12}$/;

  function pickWord(list) {
    // crypto is available in a service worker global scope.
    var idx = crypto.getRandomValues(new Uint32Array(1))[0] % list.length;
    return list[idx];
  }

  function generateInstanceName() {
    return pickWord(INSTANCE_ADJECTIVES) + "-" +
      pickWord(INSTANCE_COLORS) + "-" + pickWord(INSTANCE_NOUNS);
  }

  function mintInstanceName() {
    for (var attempt = 0; attempt < 50; attempt++) {
      var candidate = generateInstanceName();
      if (!instances.has(candidate)) return candidate;
    }
    throw new Error("service worker could not mint a unique instance name");
  }

  function isValidInstanceName(name) {
    return typeof name === "string" && INSTANCE_NAME_PATTERN.test(name);
  }

  function appPrefixForName(name) {
    return SCOPE_PATH + "app/" + name + "/";
  }

  function utf8ByteLength(value) {
    return new TextEncoder().encode(value).byteLength;
  }

  function isValidAppPrefix(value) {
    if (
      typeof value !== "string" ||
      utf8ByteLength(value) > BRIDGE_APP_PREFIX_MAX_BYTES
    ) {
      return false;
    }
    try {
      var normalized = normalizeScopePath(value);
      return normalized !== SCOPE_PATH && normalized.startsWith(SCOPE_PATH);
    } catch (_error) {
      return false;
    }
  }

  function isValidSessionId(value) {
    return typeof value === "string" && SESSION_ID_PATTERN.test(value);
  }

  function isBridgeMessagePort(value) {
    return value && typeof value.postMessage === "function";
  }

  function postInvalidScopeConfig(target) {
    if (!isBridgeMessagePort(target)) return;
    target.postMessage({
      type: "bridge-error",
      code: "invalid-scope-config",
    });
  }

  // --- Bridge registry (per-machine, keyed by SW-minted name) ---
  // Replaces the former single-instance globals. Each browser tab that boots a
  // kernel gets its own InstanceRecord keyed by a minted name; the fetch
  // handler picks the record per request so two tabs under one scope never
  // clobber each other's routing.
  var instances = new Map(); // name -> InstanceRecord
  var clientToInstance = new Map(); // clientId -> name (viewing map)
  // Request correlation stays global: request ids are unique across instances.
  var pendingRequests = new Map(); // requestId -> {resolve, reject}
  var nextRequestId = 0;

  function makeInstanceRecord(name, sessionId, owningClientId) {
    return {
      name: name,
      appPrefix: appPrefixForName(name),
      owningClientId: owningClientId || null,
      bridgePort: null,
      sessionId: sessionId,
      cookieJar: new Map(),
      liveBridgeEpoch: 0,
      durableAuthority: null,
      viewerClientIds: new Set(),
      status: "live",
      // Task 2: per-record durable-write serialization and a single in-flight
      // need-bridge restore promise. Every authoritative Cache Storage write for
      // this machine chains on stateMutationQueue so an obsolete cookie commit
      // can never race a newer one; bridgeRestorePromise coalesces concurrent
      // fetches that all discover a null bridgePort after a worker restart.
      stateMutationQueue: Promise.resolve(),
      bridgeRestorePromise: null,
    };
  }

  // Per-instance durable restore. A restarted worker re-evaluates this module
  // with an empty registry, so before it can serve any named machine it scans
  // Cache Storage for every per-name durable-authority entry and pre-creates a
  // reconnecting InstanceRecord (bridgePort = null) for each. The live bridge
  // ports are re-supplied on demand by the need-bridge handshake; until then a
  // named fetch resolves to a reconnecting record that drives that handshake.
  // The fetch handler awaits this promise before any per-machine dispatch so a
  // request that arrives during the scan sees the restored registry, not an
  // empty one, and lazy-VFS classification stays ordered behind it.
  var appPrefixReady = restoreInstancesFromDurableAuthority().catch(function () {
    // A failed scan leaves the registry empty rather than half-populated: a
    // named machine then reports unavailable (truthful) instead of routing to a
    // record built from unread bytes.
  });

  function restoreInstancesFromDurableAuthority() {
    return caches.open(BRIDGE_CACHE).then(function (cache) {
      return cache.keys().then(function (requests) {
        return Promise.all(requests.map(function (request) {
          var name = authorityNameFromCacheUrl(request.url);
          if (!name || instances.has(name)) return null;
          return cache.match(request).then(function (response) {
            if (!response) return null;
            return response.text().then(function (text) {
              var authority = bridgeAuthorityFromJson(text, name);
              // A present-but-invalid entry is quarantined, never used to
              // manufacture a partial record.
              if (!authority) return null;
              var record = makeInstanceRecord(name, authority.sessionId, null);
              record.durableAuthority = authority;
              record.status = "reconnecting";
              instances.set(name, record);
              return null;
            });
          });
        }));
      });
    });
  }

  // --- Cookie jar ---
  // (Set-Cookie on synthetic SW responses is ignored by the browser, so the SW
  // stores cookies per instance and injects them into outgoing requests.)
  //
  // Keyed by name AND path: cookies are identified by (name, domain, path) per
  // RFC 6265. WordPress sets the same auth cookie name for both /wp-admin
  // (ADMIN_COOKIE_PATH) and /wp-content/plugins (PLUGINS_COOKIE_PATH); keying by
  // name alone would drop one, breaking auth for that subtree. Domain is always
  // this origin, so name + path is a sufficient key. Each InstanceRecord owns
  // its own jar (record.cookieJar); jars are never shared between machines.

  function cookieKey(cookie) {
    return cookie.name + "\n" + cookie.path;
  }

  function isValidCookieRecord(cookie) {
    return Boolean(cookie) &&
      typeof cookie.name === "string" &&
      COOKIE_NAME_PATTERN.test(cookie.name) &&
      utf8ByteLength(cookie.name) <= BRIDGE_COOKIE_NAME_MAX_BYTES &&
      typeof cookie.value === "string" &&
      !INVALID_COOKIE_FIELD_PATTERN.test(cookie.value) &&
      utf8ByteLength(cookie.value) <= BRIDGE_COOKIE_VALUE_MAX_BYTES &&
      typeof cookie.path === "string" && cookie.path.startsWith(SCOPE_PATH) &&
      !INVALID_COOKIE_FIELD_PATTERN.test(cookie.path) &&
      utf8ByteLength(cookie.path) <= BRIDGE_COOKIE_PATH_MAX_BYTES &&
      (cookie.expires === undefined || (
        typeof cookie.expires === "number" && isFinite(cookie.expires)
      ));
  }

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

  // Returns true if the jar was mutated, so callers can persist it.
  function storeCookies(targetJar, targetAppPrefix, setCookieValues) {
    var mutated = false;
    for (var j = 0; j < setCookieValues.length; j++) {
      var cookie = parseSetCookie(setCookieValues[j]);
      if (!cookie) continue;
      // Prepend app prefix to cookie path so it matches browser-side URLs.
      // WordPress sets paths like "/" or "/wp-admin/" but the browser sees
      // "/app/" or "/app/wp-admin/".
      var prefix = targetAppPrefix.slice(0, -1); // "/app" (or "/base/app")
      if (!cookie.path.startsWith(prefix)) {
        cookie.path = prefix + cookie.path;
      }
      if (!isValidCookieRecord(cookie)) continue;
      // Identify by name + path so same-name cookies on different paths coexist.
      var key = cookieKey(cookie);
      if (cookie.expires !== undefined && cookie.expires < Date.now()) {
        if (targetJar.delete(key)) mutated = true;
      } else {
        var existing = targetJar.get(key);
        if (!existing && targetJar.size >= BRIDGE_AUTHORITY_MAX_COOKIES) {
          continue;
        }
        if (
          !existing || existing.value !== cookie.value ||
          existing.expires !== cookie.expires
        ) {
          targetJar.set(key, cookie);
          mutated = true;
        }
      }
    }
    return mutated;
  }

  function getCookiesForPath(record, path) {
    var matches = [];
    var expiredKeys = [];
    record.cookieJar.forEach(function (cookie, key) {
      if (cookie.expires !== undefined && cookie.expires < Date.now()) {
        expiredKeys.push(key);
        return;
      }
      if (path.startsWith(cookie.path)) {
        matches.push(cookie);
      }
    });
    // Task 1 keeps jars in memory, so expiration is a direct prune of the
    // record's own jar (no durable write to schedule).
    expiredKeys.forEach(function (key) {
      record.cookieJar.delete(key);
    });
    // RFC 6265: when several cookies match, list longer paths first.
    matches.sort(function (a, b) {
      return b.path.length - a.path.length;
    });
    return matches
      .map(function (cookie) {
        return cookie.name + "=" + cookie.value;
      })
      .join("; ");
  }

  // --- Per-instance durable authority (survives SW termination/restart) ---
  // Each machine persists a self-contained authority record under a name-keyed
  // Cache Storage entry so a reincarnated worker can pre-create the machine and
  // replay its cookie jar once the hosting tab re-supplies a bridge port.
  //
  // The key is BRIDGE_AUTHORITY_KEY + "/" + name, not the brief's
  // BRIDGE_AUTHORITY_KEY + ":" + name: Cache Storage resolves an entry key as a
  // URL against the worker script, and "bridge-authority-v1:able-blue-oak"
  // parses as a "bridge-authority-v1:" scheme, which Cache.put rejects because
  // the scheme is neither http nor https. A "/" separator keeps the entry a
  // same-origin http(s) URL — the same reason the removed single-instance key
  // avoided ":" — while still giving each machine its own name-keyed record.
  function bridgeAuthorityKeyFor(name) {
    return BRIDGE_AUTHORITY_KEY + "/" + name;
  }

  // Resolve the "app/"-style authority base once so restart scanning can map a
  // cache entry URL back to the machine name it belongs to.
  var authorityBasePathname = new URL(
    BRIDGE_AUTHORITY_KEY + "/",
    self.location.href,
  ).pathname;

  function authorityNameFromCacheUrl(entryUrl) {
    var pathname;
    try {
      pathname = new URL(entryUrl).pathname;
    } catch (_error) {
      return null;
    }
    if (pathname.indexOf(authorityBasePathname) !== 0) return null;
    var name = pathname.slice(authorityBasePathname.length);
    return isValidInstanceName(name) ? name : null;
  }

  function cookieRecordsFromJar(jar) {
    var records = [];
    jar.forEach(function (cookie) {
      records.push({
        name: cookie.name,
        value: cookie.value,
        path: cookie.path,
        expires: cookie.expires,
      });
    });
    return records;
  }

  function cookieJarFromRecords(records) {
    if (
      !Array.isArray(records) || records.length > BRIDGE_AUTHORITY_MAX_COOKIES
    ) {
      return null;
    }
    var restored = new Map();
    var now = Date.now();
    for (var i = 0; i < records.length; i++) {
      var cookie = records[i];
      if (!isValidCookieRecord(cookie)) return null;
      if (cookie.expires !== undefined && cookie.expires < now) continue;
      restored.set(cookieKey(cookie), cookie);
    }
    return restored;
  }

  function cloneCookieJar(jar) {
    var clone = new Map();
    jar.forEach(function (cookie, key) {
      clone.set(key, {
        name: cookie.name,
        value: cookie.value,
        path: cookie.path,
        expires: cookie.expires,
      });
    });
    return clone;
  }

  // Parse and fully validate a persisted authority for `name`. The prefix must
  // be well-formed AND equal the deterministic app prefix that this exact name
  // owns, so an entry whose name and prefix disagree can never restore a
  // machine under a foreign prefix. Returns the in-memory authority (jar as a
  // Map) or null; a null result quarantines the bytes.
  function bridgeAuthorityFromJson(text, name) {
    if (!text || utf8ByteLength(text) > BRIDGE_AUTHORITY_MAX_BYTES) return null;
    try {
      var record = JSON.parse(text);
      if (
        !record || record.version !== BRIDGE_AUTHORITY_VERSION ||
        !Number.isSafeInteger(record.revision) || record.revision < 0 ||
        record.revision >= BRIDGE_REVISION_LIMIT ||
        !isValidAppPrefix(record.appPrefix) ||
        record.appPrefix !== appPrefixForName(name) ||
        !isValidSessionId(record.sessionId)
      ) {
        return null;
      }
      var restoredJar = cookieJarFromRecords(record.cookies);
      if (!restoredJar) return null;
      return {
        version: BRIDGE_AUTHORITY_VERSION,
        revision: record.revision,
        appPrefix: record.appPrefix,
        sessionId: record.sessionId,
        cookieJar: restoredJar,
      };
    } catch (_error) {
      return null;
    }
  }

  function nextBridgeAuthority(record, nextSessionId, nextCookieJar) {
    var nextRevision = record.durableAuthority
      ? record.durableAuthority.revision + 1
      : 1;
    if (
      !Number.isSafeInteger(nextRevision) || nextRevision < 0 ||
      nextRevision >= BRIDGE_REVISION_LIMIT
    ) {
      throw new Error("service worker bridge revision limit reached");
    }
    return {
      version: BRIDGE_AUTHORITY_VERSION,
      revision: nextRevision,
      appPrefix: record.appPrefix,
      sessionId: nextSessionId,
      cookieJar: nextCookieJar,
    };
  }

  function bridgeAuthorityResponse(name, authority) {
    var text = JSON.stringify({
      version: authority.version,
      revision: authority.revision,
      appPrefix: authority.appPrefix,
      sessionId: authority.sessionId,
      cookies: cookieRecordsFromJar(authority.cookieJar),
    });
    // Round-trip through the exact restart validator so a write that could not
    // be restored (e.g. an oversized live Set-Cookie) fails loudly here instead
    // of persisting restart-invalid bytes.
    if (!bridgeAuthorityFromJson(text, name)) {
      throw new Error("service worker bridge authority is outside its bounds");
    }
    return new Response(text, {
      headers: { "Content-Type": "application/json" },
    });
  }

  function writeBridgeAuthority(record, authority) {
    // Materialize and validate all bytes before Cache Storage is touched.
    var response = bridgeAuthorityResponse(record.name, authority);
    return caches.open(BRIDGE_CACHE).then(function (cache) {
      // This put is the sole durable linearization point for the machine.
      return cache.put(bridgeAuthorityKeyFor(record.name), response);
    });
  }

  // Serialize every authoritative write for one machine so a slower obsolete
  // commit can never overwrite a newer one.
  function enqueueRecordMutation(record, operation) {
    var mutation = record.stateMutationQueue.then(operation);
    record.stateMutationQueue = mutation.catch(function () {});
    return mutation;
  }

  // Persist the machine's current in-memory jar as a new authority revision,
  // but only while the request's bridge epoch and session still match the live
  // record — an in-flight response from a superseded port must not repopulate
  // the successor's durable jar.
  function persistBridgeAuthority(record, bridgeEpoch, sessionId) {
    return enqueueRecordMutation(record, function () {
      if (
        bridgeEpoch !== record.liveBridgeEpoch || sessionId !== record.sessionId ||
        !record.durableAuthority || record.durableAuthority.sessionId !== sessionId
      ) {
        return false;
      }
      var authority = nextBridgeAuthority(
        record,
        sessionId,
        cloneCookieJar(record.cookieJar),
      );
      return writeBridgeAuthority(record, authority).then(function () {
        record.durableAuthority = authority;
        return true;
      });
    });
  }

  // Prune every instance whose owning client (host tab) has gone away. Task 1
  // does not persist instances, so teardown is a pure in-memory prune; Task 3
  // adds proactive offline notification to viewers.
  function teardownInstancesOwnedBy(clientId) {
    if (!clientId) return;
    instances.forEach(function (record, name) {
      if (record.owningClientId === clientId) instances.delete(name);
    });
    clientToInstance.forEach(function (name, cid) {
      if (!instances.has(name)) clientToInstance.delete(cid);
    });
  }

  // --- Offline lifecycle (Task 3) ---
  // Push a machine-lifecycle signal to every tab that is viewing this machine.
  // A dead client id simply resolves to no client and is skipped.
  function notifyViewers(record, type) {
    record.viewerClientIds.forEach(function (id) {
      self.clients.get(id).then(function (client) {
        if (client) client.postMessage({ type: type, name: record.name });
      }).catch(function () {});
    });
  }

  // Terminal offline: the owning tab is gone for good. Retire the machine from
  // the live registry, tell viewers, and garbage-collect its per-name durable
  // authority so a terminated machine does not leak a persisted entry across
  // reloads. Dropping durableAuthority first turns any in-flight persist for
  // this record into a no-op (persistBridgeAuthority requires a matching
  // durableAuthority), and the GC delete is serialized behind the record's
  // pending mutations so a slower authority write cannot land after the delete.
  function markInstanceOffline(record) {
    record.status = "offline";
    record.bridgePort = null;
    record.durableAuthority = null;
    notifyViewers(record, "machine-offline");
    instances.delete(record.name);
    clientToInstance.forEach(function (name, cid) {
      if (name === record.name) clientToInstance.delete(cid);
    });
    // Use the same "/" key separator writeBridgeAuthority uses (see
    // bridgeAuthorityKeyFor); the brief's ":" form is not a valid Cache Storage
    // URL and would never match the persisted entry.
    enqueueRecordMutation(record, function () {
      return caches.open(BRIDGE_CACHE).then(function (cache) {
        return cache.delete(bridgeAuthorityKeyFor(record.name));
      });
    }).catch(function () {});
  }

  // Lazy crash detection: a host tab that crashes never sends instance-closing,
  // so on the next request compare each record's owning client against the live
  // window clients. An owner that was known (owningClientId set) but is no
  // longer a window client is terminally gone. A durable-restored record
  // (owningClientId null) is never terminated here — its owner is unknown, not
  // proven gone, so it stays reconnecting/offline-reachable until a future
  // close GCs it. Concurrent requests share one matchAll via the coalesced
  // promise so a subresource burst does not fan out into many matchAll calls.
  var reconcileOwnersPromise = null;
  function reconcileOwners() {
    if (reconcileOwnersPromise) return reconcileOwnersPromise;
    reconcileOwnersPromise = self.clients.matchAll({ type: "window" }).then(
      function (wins) {
        var live = new Set(wins.map(function (w) { return w.id; }));
        instances.forEach(function (record) {
          if (record.owningClientId && !live.has(record.owningClientId)) {
            markInstanceOffline(record);
          }
        });
      },
    ).catch(function () {}).then(function () {
      reconcileOwnersPromise = null;
    });
    return reconcileOwnersPromise;
  }

  // Classify a failed bridge restore: the need-bridge handshake produced no
  // live port. If the machine's known owner is gone, the machine is terminally
  // offline; otherwise the owner (or an unknown durable-restored owner) may
  // still return, so keep it reconnecting and tell viewers it is reconnecting.
  function classifyFailedRestore(record) {
    return self.clients.matchAll({ type: "window" }).then(function (wins) {
      var ownerGone = record.owningClientId &&
        !wins.some(function (w) { return w.id === record.owningClientId; });
      if (ownerGone) {
        markInstanceOffline(record);
      } else {
        record.status = "reconnecting";
        notifyViewers(record, "machine-reconnecting");
      }
    });
  }

  // --- Bridge port setup (per instance) ---
  // http-response/http-error resolve the global pendingRequests map; the owning
  // record just records which port is live. (Task 2 wraps this in a durable
  // authority commit; for Task 1 minting is in-memory only.)
  function initBridgePortFor(record, port) {
    port.onmessage = function (event) {
      var m = event.data;
      if (m && m.type === "http-response") {
        var pending = pendingRequests.get(m.requestId);
        if (pending) {
          pendingRequests.delete(m.requestId);
          pending.resolve({
            status: m.status,
            headers: m.headers,
            body: m.body,
          });
        }
      } else if (m && m.type === "http-error") {
        var pending2 = pendingRequests.get(m.requestId);
        if (pending2) {
          pendingRequests.delete(m.requestId);
          pending2.reject(new Error(m.error || "Bridge request failed"));
        }
      }
    };
    record.bridgePort = port;
  }

  function bridgeFetch(record, request) {
    if (!record.bridgePort) {
      return Promise.reject(new Error("Bridge port not initialized"));
    }
    var requestId = nextRequestId++;
    return new Promise(function (resolve, reject) {
      pendingRequests.set(requestId, { resolve: resolve, reject: reject });
      record.bridgePort.postMessage({
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
      // Delete only obsolete versions owned by this exact registration scope.
      // Legacy and sibling caches are outside this worker's proven authority.
      caches.keys().then(function (names) {
        return Promise.all(
          names.filter(function (name) {
            return name.startsWith(CACHE_NAMESPACE) &&
              name !== BRIDGE_CACHE && name !== LAZY_ASSET_CACHE;
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
      var replyPort = event.ports[1];
      // The SW mints the name; the page no longer supplies an appPrefix. Only
      // the session id and the transferred ports are page-supplied and must be
      // validated before any registry mutation.
      if (
        !isValidSessionId(msg.sessionId) ||
        !isBridgeMessagePort(port) || !isBridgeMessagePort(replyPort)
      ) {
        postInvalidScopeConfig(replyPort);
        return;
      }
      // Mint and persist behind the startup scan so a fresh name never
      // collides with a machine the restart is still restoring, and so the
      // initial durable write is the machine's first linearized mutation.
      var record = null;
      event.waitUntil(
        appPrefixReady.then(function () {
          var name = mintInstanceName();
          record = makeInstanceRecord(
            name,
            msg.sessionId,
            event.source && event.source.id,
          );
          // The owning/shell client is deliberately NOT added to the viewing
          // map here. The shell (top-level demo page) is a different client
          // from the web-preview iframe; mapping it would make the shell's own
          // nameless same-origin GETs get redirected into the guest app and 404
          // against the kernel. The actual viewer (the iframe) is registered via
          // markViewer when it navigates to /app/<name>/. teardownInstancesOwnedBy
          // and reconcileOwners key off record.owningClientId, not the viewing
          // map, so owner attribution is unaffected.
          instances.set(name, record);
          // Persist the machine's initial authority before acknowledging so a
          // fresh login survives a worker restart. The durable write is the
          // linearization point; the live bridge commits only after it lands.
          return enqueueRecordMutation(record, function () {
            var authority = nextBridgeAuthority(record, record.sessionId, new Map());
            return writeBridgeAuthority(record, authority).then(function () {
              record.durableAuthority = authority;
              initBridgePortFor(record, port);
              record.status = "live";
              record.liveBridgeEpoch += 1;
              replyPort.postMessage({
                type: "bridge-ready",
                name: name,
                appPrefix: record.appPrefix,
              });
            });
          });
        }).catch(function () {
          if (record) {
            instances.delete(record.name);
          }
          replyPort.postMessage({
            type: "bridge-error",
            code: "bridge-init-failed",
          });
        }),
      );
    } else if (msg && msg.type === "instance-closing") {
      // A host tab announces (via pagehide) that it is going away. Only the tab
      // that owns a machine may retire it: postMessage is untrusted input, so a
      // viewer's forged instance-closing must not be able to take down another
      // tab's machine. Validate the name shape, then require the sender to be
      // the recorded owning client before marking the machine offline.
      if (isValidInstanceName(msg.name)) {
        var closing = instances.get(msg.name);
        var senderId = event.source && event.source.id;
        if (closing && senderId && closing.owningClientId === senderId) {
          markInstanceOffline(closing);
        }
      }
    }
  });

  // --- Blob-URL iframe interceptor (injected at build time) ---
  // Source of the reusable DOM patch in public/blob-iframe-interceptor.js.
  // We inline it into every bridged HTML document (see
  // injectBlobIframeInterceptor) so that apps which mount iframes from
  // `blob:` URLs — e.g. the WordPress block/site editor canvas — render
  // those iframes as service-worker-controlled `about:srcdoc` documents
  // instead. Without this, a blob: document is not SW-controlled, so its
  // subresource requests (load-scripts.php/load-styles.php, block assets)
  // escape the bridge and 404 against the static origin.
  var BLOB_IFRAME_INTERCEPTOR_SRC = "__BLOB_IFRAME_INTERCEPTOR__";

  // Insert the interceptor as the first <head> child so it runs before any
  // app script creates a blob iframe. Idempotent and HTML-only.
  function injectBlobIframeInterceptor(html) {
    if (
      !BLOB_IFRAME_INTERCEPTOR_SRC ||
      BLOB_IFRAME_INTERCEPTOR_SRC.indexOf("__BLOB_IFRAME") === 0 ||
      html.indexOf("__kandeloBlobIframePatched") !== -1
    ) {
      return html;
    }
    var tag = "<script>" + BLOB_IFRAME_INTERCEPTOR_SRC + "</script>";
    var headMatch = html.match(/<head[^>]*>/i);
    if (headMatch) {
      var at = headMatch.index + headMatch[0].length;
      return html.slice(0, at) + tag + html.slice(at);
    }
    var htmlMatch = html.match(/<html[^>]*>/i);
    if (htmlMatch) {
      var htmlAt = htmlMatch.index + htmlMatch[0].length;
      return html.slice(0, htmlAt) + tag + html.slice(htmlAt);
    }
    return tag + html;
  }

  // --- Complete CORS proxy profile (injected at build time) ---
  var CORS_PROXY_CONFIG = "__CORS_PROXY_CONFIG__";
  var corsProxyWarningKeys = new Set();

  function normalizedCorsProxyConfig() {
    if (!CORS_PROXY_CONFIG || typeof CORS_PROXY_CONFIG !== "object") return null;
    if (
      typeof CORS_PROXY_CONFIG.url !== "string" ||
      !Array.isArray(CORS_PROXY_CONFIG.allowedRequestHeaderNames) ||
      typeof CORS_PROXY_CONFIG.allowAnonymousGetHeaderOmission !== "boolean"
    ) {
      return null;
    }
    return CORS_PROXY_CONFIG;
  }

  function normalizedCorsProxyUrl() {
    var config = normalizedCorsProxyConfig();
    return config ? new URL(config.url, self.location.href).href : "";
  }

  function isCorsProxyFetchUrl(targetUrl) {
    var proxyUrl = normalizedCorsProxyUrl();
    return proxyUrl && targetUrl.startsWith(proxyUrl);
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

  function projectCorsProxyRequest(request, outgoingUrl, targetUrl) {
    var config = normalizedCorsProxyConfig();
    if (!config) return Promise.resolve(request);
    var allowed = proxyAllowedHeaderNames(config);
    var headers = new Headers();
    var unsupported = [];
    var credential = false;
    request.headers.forEach(function (value, name) {
      var lower = name.toLowerCase();
      if (allowed.has(lower)) {
        headers.append(name, value);
      } else if (
        lower === "authorization" || lower === "cookie" ||
        lower === "cookie2" || lower === "proxy-authorization"
      ) {
        // Credentials are never silently dropped, even though some match the
        // browser-managed prefixes below — surface them so the request fails
        // loudly instead of going out unauthenticated.
        unsupported.push(lower);
        credential = true;
      } else if (isBrowserManagedRequestHeader(lower)) {
        // Fetch adds these fields independently of the Headers supplied by
        // callers. Do not copy them into the proxy request or classify them as
        // application-owned unsupported occurrences; Fetch will manage the
        // outer request's own values.
      } else {
        unsupported.push(lower);
      }
    });
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
    var init = {
      method: request.method,
      headers: headers,
      credentials: "omit",
      mode: "cors",
      redirect: request.redirect,
    };
    if (request.method === "GET" || request.method === "HEAD") {
      return Promise.resolve(new Request(outgoingUrl, init));
    }
    return request.arrayBuffer().then(function (body) {
      if (body.byteLength > 0) init.body = body;
      return new Request(outgoingUrl, init);
    });
  }

  /**
   * Check if a URL is cross-origin relative to the service worker's origin.
   */
  function isCrossOrigin(url) {
    return url.origin !== self.location.origin;
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
      instanceNameFromPath(url.pathname) === null &&
      url.search === "" &&
      url.hash === "" &&
      url.pathname.startsWith(SCOPE_PATH + "vfs-groups/");
  }

  function cacheCompleteLazyVfsResponse(request, response) {
    if (response.status !== 200 || response.type !== "basic" || response.body === null) {
      return Promise.resolve(response);
    }
    // Keep the native response intact: rebuilding it would remove the
    // authenticated Content-Length the lazy VFS integrity check consumes.
    return response.clone().arrayBuffer().then(function () {
      return caches.open(LAZY_ASSET_CACHE).then(function (cache) {
        return cache.put(request, response.clone());
      });
    }).then(function () {
      return response;
    });
  }

  function fetchScopedLazyVfsRequest(request) {
    return caches.keys().then(function (cacheNames) {
      if (cacheNames.indexOf(LAZY_ASSET_CACHE) === -1) return null;
      return caches.open(LAZY_ASSET_CACHE).then(function (cache) {
        return cache.match(request);
      });
    }).then(function (cached) {
      if (cached) return cached;
      return fetch(request).then(function (response) {
        return cacheCompleteLazyVfsResponse(request, response);
      });
    });
  }

  // Return the machine name if `pathname` addresses SCOPE_PATH + "app/<name>"
  // or "app/<name>/..." with a validly-formatted (untrusted) name, else null.
  // The strict format check runs before any registry use.
  function instanceNameFromPath(pathname) {
    var base = SCOPE_PATH + "app/";
    if (pathname.indexOf(base) !== 0) return null;
    var rest = pathname.slice(base.length); // "<name>" or "<name>/..."
    var seg = rest.split("/")[0];
    return isValidInstanceName(seg) ? seg : null;
  }

  function appRootPathFor(record) {
    return record.appPrefix.slice(0, -1); // "/a/app/<name>"
  }

  function stripAppPathFor(record, pathname) {
    var root = appRootPathFor(record);
    if (pathname === root) return "/";
    return pathname.slice(root.length);
  }

  // Record that `event`'s client(s) are viewing this machine, so nameless
  // root-relative subresources they emit can be attributed back to it. This
  // generalizes the former single-instance appClientIds set.
  //
  // This maps clientId -> name unconditionally for any resolved record,
  // including the outer shell's own client. That is safe because the shell tab
  // never issues a named app fetch (app/<name>/...) from its own client — its
  // only role is to host the bridge and answer need-bridge; the app documents
  // that do issue named fetches live in the iframe/viewer clients. Task 1
  // dropped the old shell readiness-probe guard on this assumption, so if a
  // future shell ever fetched a named URL from its own client it would be
  // recorded as a viewer of that machine (and receive offline pushes for it).
  function isNavigationRequest(request) {
    return request.mode === "navigate" || request.destination === "document";
  }

  // The referer is the fetch-owned source of truth in a service worker; keep a
  // header fallback for engines that expose it. Returns the same-origin referer
  // pathname, or null when there is no usable same-origin referer.
  function sameOriginRefererPath(request) {
    var referer = request.referrer ||
      (request.headers && typeof request.headers.get === "function"
        ? request.headers.get("referer")
        : "") || "";
    if (!referer) return null;
    try {
      var refererUrl = new URL(referer);
      if (refererUrl.origin !== self.location.origin) return null;
      return refererUrl.pathname;
    } catch (_error) {
      return null;
    }
  }

  // True only when the request originates from within some machine's app
  // document (its referer is an /app/<name>/ path).
  function requestIsFromAppDocument(request) {
    var path = sameOriginRefererPath(request);
    return path !== null && instanceNameFromPath(path) !== null;
  }

  // Register a client as a viewer of `record` ONLY when the request genuinely
  // comes from within an app document: a navigation INTO the app (its resulting
  // document) or a subresource whose referer is an app path. This deliberately
  // excludes host-page requests to /app/<name>/ — the web-readiness probe and
  // the boot's kernel.wasm / VFS fetches all run on the host client, which lives
  // at "/" (or "/?demo="). Registering the host would put it in clientToInstance
  // and then redirect its later nameless boot fetches into a machine's app
  // prefix — fatally, into a PRIOR machine's now-dead prefix after an in-place
  // switch — which deadlocks every host fetch. The host is never a viewer.
  function markViewer(record, event, request) {
    if (isNavigationRequest(request)) {
      if (event.resultingClientId) {
        clientToInstance.set(event.resultingClientId, record.name);
        record.viewerClientIds.add(event.resultingClientId);
      }
      return;
    }
    if (event.clientId && requestIsFromAppDocument(request)) {
      clientToInstance.set(event.clientId, record.name);
      record.viewerClientIds.add(event.clientId);
    }
  }

  // Resolve the machine a fetch belongs to: a name in the path addresses one
  // directly (unknown but well-formed -> null, never a fallback to another
  // machine); otherwise attribute by the client's viewing map.
  function resolveInstanceForEvent(event, url) {
    var name = instanceNameFromPath(url.pathname);
    if (name) return instances.get(name) || null;
    var viewed = event.clientId ? clientToInstance.get(event.clientId) : null;
    return viewed ? (instances.get(viewed) || null) : null;
  }

  // Map a nameless root-relative path into a machine's app prefix. Strips the
  // deployment scope prefix (if present) before composing the app root, so a
  // "/base/foo" request from a "/base/" deployment becomes
  // "/base/app/<name>/foo".
  function pathInsideApp(pathname) {
    var scopeRoot = SCOPE_PATH === "/" ? "" : SCOPE_PATH.slice(0, -1);
    if (scopeRoot && pathname === scopeRoot) return "/";
    if (scopeRoot && pathname.indexOf(scopeRoot + "/") === 0) {
      return pathname.slice(scopeRoot.length);
    }
    return pathname;
  }

  function redirectIntoApp(record, url) {
    var redirectUrl = new URL(url.href);
    redirectUrl.pathname = appRootPathFor(record) + pathInsideApp(url.pathname);
    return new Response(null, {
      status: 307,
      headers: appRedirectHeaders(redirectUrl.href),
    });
  }

  function appRedirectHeaders(location) {
    var headers = new Headers();
    headers.set("Location", location);
    addAppIsolationHeaders(headers);
    return headers;
  }

  function addAppIsolationHeaders(headers) {
    if (!headers.has("Cross-Origin-Embedder-Policy")) {
      headers.set("Cross-Origin-Embedder-Policy", "require-corp");
    }
    if (!headers.has("Cross-Origin-Resource-Policy")) {
      headers.set("Cross-Origin-Resource-Policy", "same-origin");
    }
    return headers;
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

  function fetchCrossOrigin(request) {
    var targetUrl = request.url;

    // The page and worker runtime may already be deliberately fetching the
    // configured CORS proxy. Do not wrap that request in the same proxy again.
    if (isCorsProxyFetchUrl(targetUrl)) {
      var proxiedTargetUrl = corsProxyTargetUrl(targetUrl) || targetUrl;
      return projectCorsProxyRequest(request, targetUrl, proxiedTargetUrl).then(function (projected) {
        if (projected instanceof Response) return projected;
        return fetch(projected);
      }).then(function (response) {
        var headers = corsSafeResponseHeaders(response);
        return responseWithHeaders(response, headers);
      });
    }

    // If we have a CORS proxy, route through it
    if (normalizedCorsProxyConfig()) {
      var proxyUrl = corsProxyFetchUrl(targetUrl);
      return projectCorsProxyRequest(request, proxyUrl, targetUrl).then(function (projected) {
        if (projected instanceof Response) return projected;
        return fetch(projected);
      }).then(function (response) {
        var headers = corsSafeResponseHeaders(response);
        return responseWithHeaders(response, headers);
      });
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
      return responseWithHeaders(response, headers);
    });
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // A well-formed but unknown or offline machine resolves to no live instance.
  // Both cases are the same real boundary to a viewer — the machine is not
  // running here — so both get one 503 HTML page naming the machine. 503 (not
  // 404) keeps this consistent with the rest of the bridge: the name is a valid
  // route, the machine behind it is just unavailable. The isolation headers let
  // the page render inside the cross-origin-isolated app frame. `name` is always
  // a validated instance name ([a-z-]), but it is escaped anyway so this stays
  // safe if a future caller passes untrusted text.
  function offlineOrUnknownResponse(name) {
    var safeName = escapeHtml(name);
    var html = "<!doctype html>\n" +
      "<html lang=\"en\">\n" +
      "<head>\n" +
      "<meta charset=\"utf-8\">\n" +
      "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n" +
      "<title>Kandelo machine offline</title>\n" +
      "<style>\n" +
      "  :root { color-scheme: light dark; }\n" +
      "  body { margin: 0; min-height: 100vh; display: grid; place-items: center;\n" +
      "    font: 16px/1.5 system-ui, sans-serif; background: Canvas; color: CanvasText; }\n" +
      "  main { max-width: 32rem; padding: 2rem; text-align: center; }\n" +
      "  h1 { font-size: 1.4rem; margin: 0 0 0.5rem; }\n" +
      "  code { background: color-mix(in srgb, CanvasText 12%, transparent);\n" +
      "    padding: 0.1rem 0.35rem; border-radius: 0.25rem; }\n" +
      "  p { margin: 0.5rem 0 0; }\n" +
      "</style>\n" +
      "</head>\n" +
      "<body>\n" +
      "<main>\n" +
      "<h1>This Kandelo machine is offline</h1>\n" +
      "<p>The machine <code>" + safeName + "</code> is not running here.</p>\n" +
      "<p>Its hosting tab has closed. Open the machine again to start a new one.</p>\n" +
      "</main>\n" +
      "</body>\n" +
      "</html>\n";
    return new Response(html, {
      status: 503,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cross-Origin-Embedder-Policy": "require-corp",
        "Cross-Origin-Resource-Policy": "same-origin",
      },
    });
  }

  // --- Per-instance bridge restoration ---
  // When the browser terminates and restarts this worker, every record's live
  // MessagePort is lost. These functions ask the hosting tab to re-establish the
  // bridge for one specific machine, matched strictly by its SW-minted name.

  // Resolve true once the machine has a live bridge port. Concurrent fetches for
  // the same machine share a single in-flight need-bridge attempt.
  function ensureBridge(record) {
    if (record.bridgePort) return Promise.resolve(true);
    if (record.bridgeRestorePromise) return record.bridgeRestorePromise;
    record.bridgeRestorePromise = requestBridgeFromClient(record).then(
      function (result) {
        record.bridgeRestorePromise = null;
        if (result && record.bridgePort) return true;
        // No live port arrived: decide terminal offline vs transient
        // reconnecting from the owner's presence before reporting failure.
        return classifyFailedRestore(record).then(function () { return false; });
      },
    ).catch(function () {
      record.bridgeRestorePromise = null;
      return false;
    });
    return record.bridgeRestorePromise;
  }

  // Broadcast need-bridge to every window client and accept the first
  // bridge-restored whose name matches this machine and whose appPrefix and
  // sessionId match its durable authority. Responses for other machines, or
  // malformed responses, are dropped without touching this record.
  function requestBridgeFromClient(record) {
    return self.clients.matchAll({ type: "window" }).then(function (allClients) {
      if (allClients.length === 0) return false;
      return new Promise(function (resolve) {
        var settled = false;
        var responsePorts = [];
        var timeout;

        function cleanup() {
          responsePorts.forEach(function (port) {
            port.onmessage = null;
            port.close();
          });
          responsePorts = [];
        }

        function finish(result) {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          cleanup();
          resolve(result);
        }

        timeout = setTimeout(function () {
          finish(false);
        }, 5000);

        allClients.forEach(function (client) {
          var ch = new MessageChannel();
          responsePorts.push(ch.port1);
          ch.port1.onmessage = function (event) {
            var data = event.data;
            var candidatePort = event.ports[0];
            if (settled) {
              if (candidatePort && typeof candidatePort.close === "function") {
                candidatePort.close();
              }
              return;
            }
            if (!data || data.type !== "bridge-restored") return;
            var matchesName = data.name === record.name;
            if (
              !matchesName ||
              !record.durableAuthority ||
              data.appPrefix !== record.durableAuthority.appPrefix ||
              data.sessionId !== record.durableAuthority.sessionId ||
              !isBridgeMessagePort(candidatePort)
            ) {
              // A same-name response whose prefix/session/port is wrong is a
              // real scope-config error for the answering tab; a different-name
              // response simply belongs to another machine.
              if (matchesName) postInvalidScopeConfig(event.source);
              if (candidatePort && typeof candidatePort.close === "function") {
                candidatePort.close();
              }
              return;
            }
            scheduleBridgeRestoration(record, candidatePort, client.id).then(
              function (satisfied) {
                if (satisfied) finish(true);
              },
            ).catch(function () {
              /* the scheduler already closed the rejected port */
            });
          };
          try {
            client.postMessage({ type: "need-bridge" }, [ch.port2]);
          } catch (_error) {
            ch.port1.close();
          }
        });
      });
    });
  }

  // Install a restored port as the machine's live bridge, loading the jar from
  // its durable authority. The authority revision is unchanged: restoration
  // re-supplies a lost port, it does not create new durable state. clientId is
  // the window client that answered need-bridge; recording it as the record's
  // owningClientId is what lets a restarted-then-closed machine ever go
  // terminally offline (instance-closing, reconcileOwners, and
  // classifyFailedRestore all require a known owner). Without it a durable-
  // restored machine (owningClientId null) is stuck reconnecting forever and
  // its durable authority never gets garbage-collected.
  function scheduleBridgeRestoration(record, port, clientId) {
    return enqueueRecordMutation(record, function () {
      if (record.bridgePort) {
        // A concurrent candidate already restored this machine.
        if (typeof port.close === "function") port.close();
        return true;
      }
      if (!record.durableAuthority) {
        if (typeof port.close === "function") port.close();
        return false;
      }
      record.cookieJar = cloneCookieJar(record.durableAuthority.cookieJar);
      record.sessionId = record.durableAuthority.sessionId;
      initBridgePortFor(record, port);
      record.owningClientId = clientId || null;
      record.status = "live";
      record.liveBridgeEpoch += 1;
      return true;
    });
  }

  // A restarted worker serves a named machine whose live port was lost by
  // driving the need-bridge handshake; on success the request is served over
  // the restored bridge, otherwise the machine reports unavailable.
  function fetchRestoredAppRequest(record, request, url) {
    return ensureBridge(record).then(function (restored) {
      if (restored && record.bridgePort) {
        return handleAppRequest(record, request, url);
      }
      return offlineOrUnknownResponse(record.name);
    });
  }

  // --- Fetch interception ---
  self.addEventListener("fetch", function (event) {
    var url = new URL(event.request.url);

    // Host navigate-away is handled by the page's pagehide -> instance-closing
    // message (see sw-bridge-fetch.ts), which offlines the machines the tab
    // owns and notifies viewers. There is no navigation-branch teardown here:
    // event.clientId is the empty string for a navigation request, so keying a
    // teardown off it never matched an owning client.

    // Group assets have an immutable deployment-local identity. Cache only
    // their complete native responses before bridge/proxy/header rewriting.
    if (isScopedLazyVfsRequest(event.request, url)) {
      // appPrefixReady is a no-op in Task 1; the await keeps the ordering a
      // Task 2 durable restore will reinstate.
      event.respondWith(appPrefixReady.then(function () {
        if (isScopedLazyVfsRequest(event.request, url)) {
          return fetchScopedLazyVfsRequest(event.request);
        }
        return fetchWithCoiHeaders(event.request);
      }));
      return;
    }

    // Cross-origin requests — route through CORS proxy if available. This runs
    // before the per-machine dispatch so a cross-origin fetch from an app
    // viewer is never mistaken for a nameless in-app subresource.
    if (isCrossOrigin(url)) {
      event.respondWith(fetchCrossOrigin(event.request));
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

    // Per-machine bridge dispatch. A name in the path addresses a machine
    // directly; a nameless request from a client already viewing a machine is
    // attributed to it and redirected into that machine's app prefix so the
    // generic bridge can serve it without app-specific path allowlists.
    // A name in the path addresses a machine directly. Await the startup scan
    // so a request that arrives while a restarted worker is still repopulating
    // its registry sees the restored (reconnecting) record rather than an empty
    // map. A well-formed but unknown machine never falls back to another.
    var namedInPath = instanceNameFromPath(url.pathname);
    if (namedInPath) {
      event.respondWith(appPrefixReady.then(function () {
        // Lazy crash detection: reconcile owners before dispatch so a host tab
        // that crashed without sending instance-closing is retired on this
        // request and its viewers get a machine-offline push + the 503 page.
        return reconcileOwners();
      }).then(function () {
        var record = instances.get(namedInPath) || null;
        if (!record) return offlineOrUnknownResponse(namedInPath);
        markViewer(record, event, event.request);
        if (record.bridgePort) {
          return handleAppRequest(record, event.request, url);
        }
        return fetchRestoredAppRequest(record, event.request, url);
      }));
      return;
    }

    // A nameless request from a client already viewing a machine is attributed
    // to it and redirected into that machine's app prefix so the generic bridge
    // can serve it without app-specific path allowlists. The viewing map is
    // in-memory and only populated during this worker's lifetime, so no scan
    // await is needed here.
    if (event.clientId && clientToInstance.has(event.clientId)) {
      var record = resolveInstanceForEvent(event, url);
      if (record) {
        markViewer(record, event, event.request);
        event.respondWith(redirectIntoApp(record, url));
        return;
      }
    }

    // Defense in depth: any /app/-namespaced request that reached here resolved
    // to no live machine — a bare /app/, an invalid name, or a stale prefix
    // from a superseded boot. The app shell never lives under /app/, so never
    // serve it here: doing so mounts the whole Kandelo app inside a machine's
    // web-preview iframe, which boots another machine and another /app/ iframe,
    // recursing the app into itself (stacked docks). Return the truthful 503.
    var appNamespaceBase = SCOPE_PATH + "app";
    if (
      url.pathname === appNamespaceBase ||
      url.pathname === appNamespaceBase + "/" ||
      url.pathname.indexOf(appNamespaceBase + "/") === 0
    ) {
      event.respondWith(offlineOrUnknownResponse(namedInPath || ""));
      return;
    }

    // Same-origin requests — pass through but add COI headers
    event.respondWith(fetchWithCoiHeaders(event.request));
  });

  function handleAppRequest(record, request, url) {
    return (async function () {
      try {
        // The session/epoch this request belongs to. If the record's live
        // bridge switches while the request is in flight (page reload / new
        // port), we must not inject or store this request's cookies.
        var reqSessionId = record.sessionId;
        var reqBridgeEpoch = record.liveBridgeEpoch;
        // Strip the machine's app prefix so the app server sees the original
        // path. handleAppRequest is only reached for named-in-path requests, so
        // the prefix is present, but keep the guard explicit.
        var hasAppPrefix = url.pathname === appRootPathFor(record) ||
          url.pathname.indexOf(record.appPrefix) === 0;
        var appPath = hasAppPrefix
          ? stripAppPathFor(record, url.pathname)
          : url.pathname;

        var headers = {};
        request.headers.forEach(function (value, key) {
          headers[key] = value;
        });
        headers["host"] = url.host;
        headers["x-forwarded-host"] = url.host;
        headers["x-forwarded-prefix"] = appRootPathFor(record);
        headers["x-forwarded-proto"] = url.protocol.replace(":", "");
        headers["x-forwarded-uri"] = url.pathname + url.search;

        // Inject cookies from this machine's jar. Skip if the record's live
        // bridge changed out from under this request.
        var cookiePath = hasAppPrefix
          ? url.pathname
          : record.appPrefix.slice(0, -1) + url.pathname;
        var jarCookies =
          reqSessionId === record.sessionId &&
            reqBridgeEpoch === record.liveBridgeEpoch
            ? getCookiesForPath(record, cookiePath)
            : "";
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

        var bridgeResp = await bridgeFetch(record, {
          method: request.method,
          url: appPath + url.search,
          headers: headers,
          body: body,
        });


        // Store cookies from bridge response into this machine's jar. Only if
        // the request still belongs to the record's live bridge — an in-flight
        // response from a superseded port must not pollute the new jar. When the
        // jar actually changes, persist a new durable authority revision so the
        // login survives a worker restart; the persist re-checks the epoch and
        // session at commit time so a superseded write cannot repopulate the
        // successor's durable jar.
        var rawSetCookie =
          bridgeResp.headers["Set-Cookie"] ||
          bridgeResp.headers["set-cookie"];
        if (
          rawSetCookie && reqSessionId === record.sessionId &&
          reqBridgeEpoch === record.liveBridgeEpoch
        ) {
          var jarMutated = storeCookies(
            record.cookieJar,
            record.appPrefix,
            rawSetCookie.split("\n"),
          );
          if (jarMutated) {
            persistBridgeAuthority(record, reqBridgeEpoch, reqSessionId).catch(
              function () {},
            );
          }
        }

        // Build Response
        var respHeaders = new Headers();
        for (var key in bridgeResp.headers) {
          var lower = key.toLowerCase();
          if (
            lower === "transfer-encoding" ||
            lower === "connection" ||
            lower === "keep-alive" ||
            // Never hand Set-Cookie back to the browser. The SW cookie jar
            // (captured above via storeCookies) is the authoritative store and
            // replays cookies on outgoing requests. Forwarding Set-Cookie would
            // let the browser persist Kandelo cookies in its own cookie store,
            // where they would accumulate across sessions and outlive the
            // machine instance they belong to.
            lower === "set-cookie"
          ) {
            continue;
          }
          respHeaders.set(key, bridgeResp.headers[key]);
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
                if (!locUrl.pathname.startsWith(record.appPrefix)) {
                  locUrl.pathname = record.appPrefix.slice(0, -1) +
                    locUrl.pathname;
                }
              }
              var redirectStatus = bridgeResp.status;
              if (
                (redirectStatus === 301 || redirectStatus === 302) &&
                request.method !== "GET" &&
                request.method !== "HEAD"
              ) {
                redirectStatus = 303;
              }
              respHeaders.set("Location", locUrl.toString());
              addAppIsolationHeaders(respHeaders);
              return new Response(null, {
                status: redirectStatus,
                headers: respHeaders,
              });
            } catch (e) {
              /* leave as-is */
            }
          }
        }
        rewriteAppUrlHeader(record, respHeaders, "Link", url);

        // COEP/CORP for cross-origin isolation
        addAppIsolationHeaders(respHeaders);

        var body = bridgeResp.body;
        if (shouldRewriteAppResponseBody(respHeaders)) {
          var text = new TextDecoder().decode(body);
          var rewritten = rewriteSameHostAppUrls(record, text, url);
          // Inject the blob-iframe interceptor into HTML documents so that
          // app-created `blob:` iframes (e.g. the WordPress editor canvas)
          // render as SW-controlled about:srcdoc documents and their
          // subresource requests stay on the bridge instead of escaping to
          // the static origin. See injectBlobIframeInterceptor.
          var contentType = (respHeaders.get("Content-Type") || "").toLowerCase();
          if (contentType.indexOf("text/html") === 0) {
            rewritten = injectBlobIframeInterceptor(rewritten);
          }
          if (rewritten !== text) {
            body = new TextEncoder().encode(rewritten);
            respHeaders.delete("Content-Length");
          }
        }

        return new Response(responseBodyForStatus(bridgeResp.status, body), {
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

  function shouldRewriteAppResponseBody(headers) {
    if (headers.has("Content-Encoding")) return false;
    var contentType = (headers.get("Content-Type") || "").toLowerCase();
    return (
      contentType.indexOf("text/html") === 0 ||
      contentType.indexOf("text/css") === 0 ||
      contentType.indexOf("text/javascript") === 0 ||
      contentType.indexOf("application/javascript") === 0 ||
      contentType.indexOf("application/x-javascript") === 0 ||
      contentType.indexOf("application/json") === 0 ||
      contentType.indexOf("+json") !== -1 ||
      contentType.indexOf("application/xml") === 0 ||
      contentType.indexOf("text/xml") === 0 ||
      contentType.indexOf("+xml") !== -1 ||
      contentType.indexOf("image/svg+xml") === 0
    );
  }

  function rewriteAppUrlHeader(record, headers, name, requestUrl) {
    var value = headers.get(name);
    if (!value) return;
    var rewritten = rewriteSameHostAppUrls(record, value, requestUrl);
    if (rewritten !== value) {
      headers.set(name, rewritten);
    }
  }

  function rewriteSameHostAppUrls(record, text, requestUrl) {
    var rootPath = appRootPathFor(record);
    var publicOrigin = requestUrl.protocol + "//" + requestUrl.host + "/";
    var publicBase = requestUrl.protocol + "//" + requestUrl.host + rootPath + "/";
    var hostPattern = escapeRegExp(requestUrl.host);
    var appPathPattern = escapeRegExp(rootPath.slice(1));
    var plain = new RegExp(
      "http://" + hostPattern + "/(?!" + appPathPattern + "(?:/|$))",
      "g",
    );
    var escapedAppPathPattern = appPathPattern.replace(/\//g, "\\\\/");
    var escaped = new RegExp(
      "http:\\\\/\\\\/" + hostPattern + "\\\\/(?!" + escapedAppPathPattern + "(?:\\\\/|$))",
      "g",
    );
    var encodedAppPathPattern = appPathPattern.replace(/\//g, "%2F");
    var encoded = new RegExp(
      "http%3A%2F%2F" + hostPattern + "%2F(?!" + encodedAppPathPattern + "(?:%2F|$))",
      "gi",
    );
    return text
      .replace(plain, publicBase)
      .replace(escaped, publicBase.replace(/\//g, "\\/"))
      .replace(encoded, encodeURIComponent(publicBase))
      .replace(new RegExp("http://" + hostPattern + "/", "g"), publicOrigin)
      .replace(
        new RegExp("http:\\\\/\\\\/" + hostPattern + "\\\\/", "g"),
        publicOrigin.replace(/\//g, "\\/"),
      )
      .replace(
        new RegExp("http%3A%2F%2F" + hostPattern + "%2F", "gi"),
        encodeURIComponent(publicOrigin),
      );
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}

/**
 * Kandelo preview-origin service worker.
 *
 * Guest web pages (WordPress, nginx, any server inside a Kandelo machine) are
 * served from this origin, never from Kandelo's, so a guest script cannot
 * read or drive the Kandelo page, its storage or its credential prompt. This
 * worker owns `<scope>computer/<name>/…` and forwards each request to the
 * Kandelo tab that owns machine `<name>`, over a MessagePort that tab handed
 * over through its hidden relay frame (`__kandelo_preview/relay.html`, or
 * `relay.php` on a PHP host). It
 * holds no cookies and no persistent state: the owning tab keeps the cookie
 * jar and shapes every response. See docs/browser-support.md, "Guest web
 * previews run on their own origin", and apps/browser-demos/lib/preview/.
 *
 * Shared with the page (apps/browser-demos/lib/preview/protocol.ts; keep
 * equal): the protocol version, the relay path, the machine name patterns
 * and the name commitment.
 *
 * Every guest page on this origin is equally trusted (they share it): any of
 * them can message this worker through a relay window it scripts, so who
 * sent a message proves nothing. What proves ownership is a secret: a
 * machine's name ends in `t`, a commitment to a 128-bit secret only the
 * owning tab holds (`t` = 100 bits of SHA-256 of the secret, base32). This
 * worker binds a port to a name, replacing any port it held, and drops a
 * name, only for a message whose secret hashes to the name's own `t`. The
 * check needs no state, so it holds across this worker's restarts and new
 * versions. This worker never sends a secret anywhere.
 *
 * Each bind and closing also carries the owner's sequence number for the
 * name. Among messages that prove the secret, this worker ignores one no
 * larger than the newest it accepted (`ownerSeqs`): the relay can deliver a
 * bind late, after its owner gave up on it, closed its port and bound
 * again. That memory is lost with this worker, like the ports it orders.
 *
 * A guest can also register this same script with a query string, or at a
 * narrower scope, to replace this worker with one that holds no ports. Such
 * a worker refuses to install (see `isDeploymentWorker`), so only this
 * deployment's exact script URL at the deployment scope ever runs here.
 *
 * Machines are not isolated from each other here (they share this origin),
 * but a request this worker can attribute to one machine's page never
 * reaches another machine: see `requesterMachine`. Broadcasts to every
 * relay name a machine only by a hash of its name (`machineNameHash`), so a
 * guest that listens learns no machine it does not already know.
 */
"use strict";

// Injected by the build (apps/browser-demos/vite/preview-origin.ts):
// { protocolVersion, kandeloOrigins: [exact origins], kandeloOriginPattern,
//   relayPath, workerFile }; the last two depend on the host (the `static`
// paths, or `.php` entry points on a PHP host).
var PREVIEW_CONFIG = "__KANDELO_PREVIEW_ORIGIN_CONFIG__";
var PROTOCOL_VERSION = 3;
var NAME_PATTERN = /^[a-z]{2,12}-[a-z]{2,12}-[a-z]{2,12}-[a-z2-7]{20}$/;
var LEGACY_NAME_PATTERN = /^[a-z]{2,12}-[a-z]{2,12}-[a-z]{2,12}$/;
var SECRET_PATTERN = /^[0-9a-f]{32}$/;
var COMMITMENT_LENGTH = 20;
var BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
var NEED_BRIDGE_TIMEOUT_MS = 5000;
var OWNER_CHECK_INTERVAL_MS = 1000;
// Longer than the owner's own in-kernel request timeout (90 s), so the
// owner's answer, including its timeout error, normally arrives first.
var ASK_TIMEOUT_MS = 120000;
var BLOB_DOCUMENT_SEGMENT = "__kandelo_blob";
var KEEPALIVE_PROBE_SEGMENT = "__kandelo_keepalive_probe";
// A blob document lives while its blob URL does: until the page revokes it,
// its creating document goes away, or it is left unread this long.
var BLOB_DOCUMENT_IDLE_MS = 60 * 60 * 1000;
var BLOB_DOCUMENT_WAIT_MS = 5000;
var MAX_BLOB_DOCUMENTS = 64;
var MAX_BLOB_DOCUMENT_BYTES = 16 * 1024 * 1024;
// All blob documents together; the oldest go first.
var MAX_BLOB_TOTAL_BYTES = 64 * 1024 * 1024;
// Frames waiting for a document not yet posted.
var MAX_BLOB_WAITERS = 32;
var BLOB_ID_PATTERN = /^[0-9a-f]{32}$/;
// Names whose newest accepted sequence number is remembered; oldest go first.
var MAX_OWNER_SEQS = 1024;

var config = PREVIEW_CONFIG && typeof PREVIEW_CONFIG === "object" &&
    Array.isArray(PREVIEW_CONFIG.kandeloOrigins) &&
    PREVIEW_CONFIG.kandeloOrigins.length > 0 &&
    PREVIEW_CONFIG.protocolVersion === PROTOCOL_VERSION &&
    typeof PREVIEW_CONFIG.relayPath === "string" &&
    typeof PREVIEW_CONFIG.workerFile === "string"
  ? PREVIEW_CONFIG
  : null;
// The static host's paths stand in when the configuration is unusable; the
// worker then answers machine requests with "not configured" (below).
var LAYOUT = config || {
  relayPath: "__kandelo_preview/relay.html",
  workerFile: "preview-service-worker.js",
};

var SCOPE_PATH = new URL(self.registration.scope).pathname;
var WORKER_FILE = LAYOUT.workerFile;

function isKandeloOrigin(origin) {
  if (!config) return false;
  if (config.kandeloOrigins.indexOf(origin) !== -1) return true;
  return typeof config.kandeloOriginPattern === "string" &&
    new RegExp(config.kandeloOriginPattern).test(origin);
}

// Only the deployment's own registration may run: this exact script, with no
// query or fragment, registered for the directory that holds it. The static
// host ignores query strings, so `preview-service-worker.js?x` would
// otherwise install these same bytes as a new worker with no bridge ports;
// a narrower scope would take part of `computer/` away from the deployment.
function isDeploymentWorker() {
  var script = new URL(self.location.href);
  var directory = new URL("./", script.href).href;
  return script.search === "" && script.hash === "" &&
    script.pathname.slice(-WORKER_FILE.length - 1) === "/" + WORKER_FILE &&
    self.registration.scope === directory;
}
var deploymentWorker = isDeploymentWorker();
var COMPUTER_ROOT = SCOPE_PATH + "computer";
var COMPUTER_BASE = COMPUTER_ROOT + "/";
var RELAY_PATH = SCOPE_PATH + LAYOUT.relayPath;

// name -> { port, ownerClientId, pending: Map(id -> settle), ownerCheckedAt }
var bridges = new Map();
// name -> [resolve(bridge|null)] while a need-bridge round is open
var waiters = new Map();
// name -> newest sequence number of an accepted bind or closing; outlives a
// dropped bridge, so a late bind cannot revive a closed machine.
var ownerSeqs = new Map();
// clientId -> name: the machine each guest document (or worker) was loaded
// from, recorded when this worker served it. Its nameless root-relative
// requests (`/style.css`) go to that machine, and its requests for any other
// machine are refused (`requesterMachine`).
var viewers = new Map();
// clientId -> when it entered `viewers`. When `viewers` reaches
// VIEWER_PRUNE_AT entries, the worker drops every client that no longer
// exists, so a guest that opens and closes frames in a loop cannot grow the
// map without bound. A client recorded within VIEWER_PRUNE_GRACE_MS is kept:
// a navigation's `resultingClientId` names a document that may not exist
// yet. The next prune waits until the map has doubled, so pruning costs
// amortized constant time per entry.
var viewerSince = new Map();
var VIEWER_PRUNE_AT = 256;
var VIEWER_PRUNE_GRACE_MS = 30000;
var viewerPruneAt = 0;
var viewerPruning = false;
// id -> { name, bytes, creatorId, expires } posted by a guest document's
// blob-iframe helper, oldest first; and id -> [resolve] for a frame whose
// navigation arrived first.
var blobDocuments = new Map();
var blobBytes = 0;
var blobWaiters = new Map();
var nextRequestId = 1;

self.addEventListener("install", function (event) {
  if (!deploymentWorker) {
    // A failed install leaves the deployment's active worker in place.
    event.waitUntil(Promise.reject(new Error(
      "Kandelo's preview service worker runs only as " + WORKER_FILE +
        " registered for its own directory, not as " + self.location.href +
        " for " + self.registration.scope,
    )));
    return;
  }
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});

function isMachineName(value) {
  return typeof value === "string" && NAME_PATTERN.test(value);
}

function nameSegment(pathname) {
  if (pathname.indexOf(COMPUTER_BASE) !== 0) return null;
  return pathname.slice(COMPUTER_BASE.length).split("/")[0];
}

function nameFromPath(pathname) {
  var segment = nameSegment(pathname);
  return isMachineName(segment) ? segment : null;
}

// `t` for secret `s`: 100 bits of SHA-256(UTF-8 `s`), lowercase base32.
// Mirrors machineNameCommitment in lib/preview/protocol.ts.
function nameCommitment(secret) {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)).then(function (digest) {
    var bytes = new Uint8Array(digest);
    var out = "";
    var buffer = 0;
    var bits = 0;
    for (var index = 0; out.length < COMMITMENT_LENGTH; index++) {
      buffer = (buffer << 8) | bytes[index];
      bits += 8;
      while (bits >= 5 && out.length < COMMITMENT_LENGTH) {
        out += BASE32_ALPHABET[(buffer >> (bits - 5)) & 31];
        bits -= 5;
      }
      buffer &= (1 << bits) - 1;
    }
    return out;
  });
}

// True when `secret` is the one `name` commits to: only the owning tab
// knows it.
function provesName(name, secret) {
  if (!isMachineName(name) || typeof secret !== "string" || !SECRET_PATTERN.test(secret)) {
    return Promise.resolve(false);
  }
  return nameCommitment(secret).then(function (commitment) {
    return name.slice(-COMMITMENT_LENGTH) === commitment;
  }, function () {
    return false;
  });
}

function isSequence(value) {
  return Number.isSafeInteger(value) && value > 0;
}

// Accept `seq` for `name` if it is newer than any accepted before, and
// remember it. Called synchronously once the secret is proven, so two binds
// in flight are ordered by their numbers, not by which proof finished first.
function acceptSequence(name, seq) {
  var newest = ownerSeqs.get(name);
  if (newest !== undefined && seq <= newest) return false;
  ownerSeqs.delete(name);
  ownerSeqs.set(name, seq);
  if (ownerSeqs.size > MAX_OWNER_SEQS) ownerSeqs.delete(ownerSeqs.keys().next().value);
  return true;
}

function isRelayClient(client) {
  if (!client || typeof client.url !== "string") return false;
  try {
    var url = new URL(client.url);
    return url.origin === self.location.origin && url.pathname === RELAY_PATH;
  } catch (_error) {
    return false;
  }
}

function relayClients() {
  return self.clients.matchAll({ type: "window", includeUncontrolled: true })
    .then(function (clients) {
      return clients.filter(isRelayClient);
    });
}

// What broadcasts carry instead of a machine's name: lowercase hex SHA-256
// of the name's UTF-8 bytes. An owner or viewer that knows the name
// recognizes it; any other guest page that listens (it can script a relay)
// learns nothing, since a name ends in a 100-bit commitment it cannot guess.
// Mirrors machineNameHash in lib/preview/protocol.ts.
function machineNameHash(name) {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(name)).then(function (digest) {
    return Array.from(new Uint8Array(digest), function (byte) {
      return byte.toString(16).padStart(2, "0");
    }).join("");
  });
}

function broadcastAbout(name, message) {
  return machineNameHash(name).then(function (hash) {
    message.v = PROTOCOL_VERSION;
    message.nameHash = hash;
    return broadcast(message);
  });
}

function broadcast(message) {
  return relayClients().then(function (clients) {
    clients.forEach(function (client) {
      try {
        client.postMessage(message);
      } catch (_error) {
        /* a closing client */
      }
    });
  });
}

// --- Bridge ports, bound by owning tabs through their relay ---

function dropBridge(name, reason) {
  var bridge = bridges.get(name);
  if (!bridge) return;
  bridges.delete(name);
  if (bridge.ownerWatch) clearInterval(bridge.ownerWatch);
  bridge.port.onmessage = null;
  try {
    bridge.port.close();
  } catch (_error) {
    /* already closed */
  }
  bridge.pending.forEach(function (settle) {
    settle({ type: "http-error", error: reason, offline: true });
  });
  bridge.pending.clear();
  broadcastAbout(name, { type: "preview-machine-status", status: "offline" });
}

// A rebind replaced this bridge's port. Requests already sent on it are
// answered there; close it once they are.
function retireBridge(bridge) {
  if (bridge.ownerWatch) clearInterval(bridge.ownerWatch);
  bridge.ownerWatch = null;
  bridge.retired = true;
  if (bridge.pending.size === 0) closeBridgePort(bridge);
}

function closeBridgePort(bridge) {
  bridge.port.onmessage = null;
  try {
    bridge.port.close();
  } catch (_error) {
    /* already closed */
  }
}

function installBridge(name, port, ownerClientId) {
  var bridge = {
    port: port,
    ownerClientId: ownerClientId,
    pending: new Map(),
    ownerCheckedAt: Date.now(),
    ownerWatch: null,
  };
  port.onmessage = function (event) {
    var message = event.data;
    if (!message || message.v !== PROTOCOL_VERSION || !Number.isSafeInteger(message.id)) return;
    if (message.type === "bridge-ping") {
      // The owner checks that this worker still holds its port.
      port.postMessage({ type: "bridge-pong", v: PROTOCOL_VERSION, id: message.id });
      return;
    }
    var settle = bridge.pending.get(message.id);
    if (!settle) return;
    bridge.pending.delete(message.id);
    settle(message);
    if (bridge.retired && bridge.pending.size === 0) closeBridgePort(bridge);
  };
  bridges.set(name, bridge);
  var list = waiters.get(name) || [];
  waiters.delete(name);
  list.forEach(function (resolve) {
    resolve(bridge);
  });
  return bridge;
}

self.addEventListener("message", function (event) {
  var source = event.source;
  var message = event.data;
  if (!deploymentWorker || !source || !message || typeof message.type !== "string") return;
  if (message.type === "preview-blob-document") {
    if (message.v === PROTOCOL_VERSION) event.waitUntil(storeBlobDocument(source, message));
    return;
  }
  if (message.type === "preview-blob-revoked") {
    if (message.v === PROTOCOL_VERSION) event.waitUntil(revokeBlobDocument(source, message));
    return;
  }
  if (!isRelayClient(source)) return;
  var reply = function (body) {
    body.v = PROTOCOL_VERSION;
    source.postMessage(body);
  };
  var name = typeof message.name === "string" ? message.name : String(message.name);
  var seq = isSequence(message.seq) ? message.seq : null;
  if (message.v !== PROTOCOL_VERSION) {
    reply({ type: "preview-bridge-refused", name: name, seq: seq, code: "version-mismatch" });
    return;
  }
  if (message.type === "preview-bridge") {
    var port = event.ports && event.ports[0];
    if (!isMachineName(name) || !port || seq === null) {
      if (port) port.close();
      reply({ type: "preview-bridge-refused", name: name, seq: seq, code: "invalid" });
      return;
    }
    event.waitUntil(provesName(name, message.secret).then(function (owner) {
      if (!owner) {
        port.close();
        reply({ type: "preview-bridge-refused", name: name, seq: seq, code: "not-owner" });
        return;
      }
      if (!acceptSequence(name, seq)) {
        // A bind its owner already replaced or closed; its port is dead.
        port.close();
        reply({ type: "preview-bridge-refused", name: name, seq: seq, code: "superseded" });
        return;
      }
      // The owner binds again whenever this worker may have lost its port;
      // the new port replaces the old one.
      var previous = bridges.get(name);
      installBridge(name, port, source.id);
      if (previous) retireBridge(previous);
      reply({ type: "preview-bridge-ready", name: name, seq: seq });
    }));
  } else if (message.type === "preview-machine-closing") {
    if (seq === null) return;
    event.waitUntil(provesName(name, message.secret).then(function (owner) {
      if (owner && acceptSequence(name, seq)) dropBridge(name, "The tab that ran this computer closed it");
    }));
  }
});

// Resolve the live bridge for `name`, asking owning tabs for a fresh port when
// this worker has none (after the browser restarted it). Resolves null when
// no tab answers: the machine is not running here.
function bridgeFor(name) {
  var bridge = bridges.get(name);
  if (bridge) {
    if (Date.now() - bridge.ownerCheckedAt < OWNER_CHECK_INTERVAL_MS) {
      return Promise.resolve(bridge);
    }
    // A crashed owner never sends a closing notice; its relay client is gone.
    return self.clients.get(bridge.ownerClientId).then(function (owner) {
      if (bridges.get(name) !== bridge) return bridgeFor(name);
      if (!owner) {
        dropBridge(name, "The tab that ran this computer is gone");
        return null;
      }
      bridge.ownerCheckedAt = Date.now();
      return bridge;
    }, function () {
      return bridge;
    });
  }
  return new Promise(function (resolve) {
    var list = waiters.get(name);
    var first = !list;
    if (!list) {
      list = [];
      waiters.set(name, list);
    }
    var timer = setTimeout(function () {
      var current = waiters.get(name);
      if (!current) return;
      var index = current.indexOf(done);
      if (index !== -1) current.splice(index, 1);
      if (current.length === 0) waiters.delete(name);
      resolve(null);
      if (first) {
        broadcastAbout(name, { type: "preview-machine-status", status: "offline" });
      }
    }, NEED_BRIDGE_TIMEOUT_MS);
    function done(found) {
      clearTimeout(timer);
      resolve(found);
    }
    list.push(done);
    if (first) broadcastAbout(name, { type: "preview-need-bridge" });
  });
}

// A MessagePort gives no signal when the tab holding its other end dies, so
// a waiting request watches the owner's relay client and fails as offline
// when it is gone, instead of waiting forever.
function watchOwner(name, bridge) {
  if (bridge.ownerWatch) return;
  bridge.ownerWatch = setInterval(function () {
    if (bridges.get(name) !== bridge || bridge.pending.size === 0) {
      clearInterval(bridge.ownerWatch);
      bridge.ownerWatch = null;
      return;
    }
    self.clients.get(bridge.ownerClientId).then(function (owner) {
      if (!owner && bridges.get(name) === bridge) {
        dropBridge(name, "The tab that ran this computer is gone");
      }
    }, function () {});
  }, OWNER_CHECK_INTERVAL_MS);
}

function ask(name, bridge, message, transfer) {
  // A rebind may have replaced this bridge between looking it up and
  // asking; ask on the port that serves the name now.
  if (bridge.retired) {
    var current = bridges.get(name);
    if (!current) return Promise.resolve({ type: "http-error", error: "offline", offline: true });
    bridge = current;
  }
  return new Promise(function (resolve) {
    var id = nextRequestId++;
    message.id = id;
    message.v = PROTOCOL_VERSION;
    // An owner that holds the port but never answers (a wedged tab) must not
    // leave the guest's request open forever.
    var timer = setTimeout(function () {
      if (!bridge.pending.has(id)) return;
      bridge.pending.delete(id);
      // A replaced port stays open only for the requests it still owes.
      if (bridge.retired && bridge.pending.size === 0) closeBridgePort(bridge);
      resolve({ type: "http-error", error: "timeout", timeout: true });
    }, ASK_TIMEOUT_MS);
    bridge.pending.set(id, function (reply) {
      clearTimeout(timer);
      resolve(reply);
    });
    watchOwner(name, bridge);
    try {
      bridge.port.postMessage(message, transfer || []);
    } catch (error) {
      clearTimeout(timer);
      bridge.pending.delete(id);
      resolve({ type: "http-error", error: String(error) });
    }
  });
}

// --- Responses ---

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isolationHeaders(headers) {
  // The Kandelo page and its viewer shell are cross-origin isolated, so a
  // frame they embed must opt into COEP and allow cross-origin embedding.
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  headers.set("Origin-Agent-Cluster", "?1");
  return headers;
}

function htmlPage(status, title, paragraphs) {
  var body = "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n" +
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n" +
    "<title>" + escapeHtml(title) + "</title>\n<style>\n" +
    "  :root { color-scheme: light dark; }\n" +
    "  body { margin: 0; min-height: 100vh; display: grid; place-items: center;\n" +
    "    font: 16px/1.5 system-ui, sans-serif; background: Canvas; color: CanvasText; }\n" +
    "  main { max-width: 32rem; padding: 2rem; text-align: center; }\n" +
    "  h1 { font-size: 1.4rem; margin: 0 0 0.5rem; }\n" +
    "  code { background: color-mix(in srgb, CanvasText 12%, transparent);\n" +
    "    padding: 0.1rem 0.35rem; border-radius: 0.25rem; }\n" +
    "</style>\n</head>\n<body>\n<main>\n<h1>" + escapeHtml(title) + "</h1>\n" +
    paragraphs.map(function (text) { return "<p>" + text + "</p>\n"; }).join("") +
    "</main>\n</body>\n</html>\n";
  return new Response(body, {
    status: status,
    headers: isolationHeaders(new Headers({
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    })),
  });
}

function timeoutResponse(name) {
  return htmlPage(504, "This Kandelo computer did not answer", [
    "The tab that runs <code>" + escapeHtml(name) + "</code> did not answer this request in time.",
  ]);
}

function legacyNameResponse(name) {
  return htmlPage(404, "This Kandelo computer address is from an older version", [
    "<code>" + escapeHtml(name) + "</code> uses Kandelo's old three-word computer names, " +
      "which no longer name a computer.",
    "Open the computer again from the tab that runs it to get its current address.",
  ]);
}

function offlineResponse(name) {
  return htmlPage(503, "This Kandelo computer is offline", [
    "The computer <code>" + escapeHtml(name) + "</code> is not running here.",
    "Its hosting tab has closed. Open the computer again to start a new one.",
  ]);
}

// A request from one machine's page for another machine's address. The page
// is sandboxed (an opaque origin, no scripts), so a guest that navigated its
// own frame here cannot script this document to make requests in its name.
function crossMachineResponse(name) {
  var response = htmlPage(403, "This address belongs to another Kandelo computer", [
    "A page of one Kandelo computer asked for an address of <code>" + escapeHtml(name) +
      "</code>, a different computer. A computer's pages can reach only that computer's own pages.",
  ]);
  response.headers.set("Content-Security-Policy", "sandbox");
  return response;
}

function viewerUrlFor(url) {
  var origins = config.kandeloOrigins;
  var origin = origins[0];
  for (var i = 0; i < origins.length; i++) {
    if (new URL(origins[i]).hostname === self.location.hostname) {
      origin = origins[i];
      break;
    }
  }
  return origin + url.pathname + url.search + url.hash;
}

// A guest page opened outside Kandelo (a `target=_blank` link, a pasted
// preview URL) belongs in Kandelo's viewer shell, which embeds it again
// through the owning tab's bridge.
function topLevelResponse(request, url) {
  var viewer = viewerUrlFor(url);
  if (request.method === "GET" || request.method === "HEAD") {
    return new Response(null, {
      status: 302,
      headers: isolationHeaders(new Headers({ Location: viewer, "Cache-Control": "no-store" })),
    });
  }
  return htmlPage(405, "Open this page in Kandelo", [
    "A form was submitted to a Kandelo computer outside Kandelo, and it cannot be replayed.",
    "<a href=\"" + escapeHtml(viewer) + "\">Open the computer in Kandelo</a> and try again.",
  ]);
}

function nullBodyStatus(status) {
  return status === 101 || status === 103 || status === 204 || status === 205 || status === 304;
}

function guestResponse(reply) {
  if (!reply || reply.type !== "http-response") {
    return htmlPage(502, "Kandelo could not reach this computer's web server", [
      escapeHtml(reply && reply.error ? reply.error : "The bridge closed"),
    ]);
  }
  var status = reply.status;
  if (!Number.isInteger(status) || status < 200 || status > 599) {
    return htmlPage(502, "Kandelo could not read this computer's answer", [
      "The web server answered with an unusable status.",
    ]);
  }
  var headers = new Headers();
  (Array.isArray(reply.headers) ? reply.headers : []).forEach(function (pair) {
    try {
      headers.append(pair[0], pair[1]);
    } catch (_error) {
      /* drop a header the Fetch API cannot carry */
    }
  });
  isolationHeaders(headers);
  var body = nullBodyStatus(status) || !(reply.body instanceof ArrayBuffer) ? null : reply.body;
  return new Response(body, { status: status, headers: headers });
}

// --- Viewer attribution for nameless root-relative requests ---

function setViewer(clientId, name) {
  viewers.set(clientId, name);
  viewerSince.set(clientId, Date.now());
  if (viewers.size >= Math.max(VIEWER_PRUNE_AT, viewerPruneAt)) pruneViewers();
}

function pruneViewers() {
  if (viewerPruning) return;
  viewerPruning = true;
  self.clients.matchAll({ includeUncontrolled: true, type: "all" }).then(function (clients) {
    var live = new Set();
    clients.forEach(function (client) {
      live.add(client.id);
    });
    var graceStart = Date.now() - VIEWER_PRUNE_GRACE_MS;
    viewers.forEach(function (_name, clientId) {
      if (live.has(clientId) || viewerSince.get(clientId) > graceStart) return;
      viewers.delete(clientId);
      viewerSince.delete(clientId);
    });
  }).catch(function () {
    /* keep every entry: a client this worker cannot see may still exist */
  }).then(function () {
    viewerPruneAt = viewers.size * 2;
    viewerPruning = false;
  });
}

function markViewer(event, name) {
  // A document or a worker this request loads belongs to the machine it was
  // loaded from.
  if (event.resultingClientId) setViewer(event.resultingClientId, name);
  if (event.request.mode !== "navigate" && event.clientId && !viewers.has(event.clientId)) {
    // A client this worker never served (an about:blank or about:srcdoc
    // frame) belongs to the machine of its first request.
    setViewer(event.clientId, name);
  }
}

function viewerNameFor(event) {
  if (!event.clientId) return Promise.resolve(null);
  if (viewers.has(event.clientId)) return Promise.resolve(viewers.get(event.clientId));
  // A restarted worker lost the map; recover it from the document's own URL.
  // Only windows: a loading worker client can wait on this very fetch.
  return self.clients.matchAll({ type: "window" }).then(function (windows) {
    for (var i = 0; i < windows.length; i++) {
      if (windows[i].id !== event.clientId) continue;
      var url = new URL(windows[i].url);
      var name = url.origin === self.location.origin ? nameFromPath(url.pathname) : null;
      if (name) setViewer(event.clientId, name);
      return name;
    }
    return null;
  });
}

// Where a request's referrer points: a page of machine `machine`, a Kandelo
// page (`kandelo`), or neither.
function referrerSource(referrer) {
  try {
    var url = new URL(referrer);
    if (url.origin === self.location.origin) return { machine: nameFromPath(url.pathname), kandelo: false };
    return { machine: null, kandelo: isKandeloOrigin(url.origin) };
  } catch (_error) {
    return { machine: null, kandelo: false };
  }
}

// The machine whose page made this request, as far as this worker can tell,
// or null. Every guest page shares this origin, so this is attribution, not
// isolation: it keeps one machine's page from reading or writing another
// machine through this worker, and docs/browser-support.md ("Residual risks
// and boundaries") lists what it cannot see.
//
// - A subresource, fetch or XHR names its client (`clientId`): the machine
//   this worker served that document from (`viewers`), or after a restart
//   the machine in the document's URL.
// - A navigation names no initiator in any engine. Chromium gives the
//   `clientId` of the frame's current document; Firefox and WebKit give
//   none. Measured 2026-10-30, Chromium 153, Firefox 155, WebKit 26.6.
//   So a navigation is attributed to the frame's current document when the
//   engine names it, and otherwise to its referrer, a guest page's own URL
//   unless it chose to send none. A navigation whose referrer is a Kandelo
//   page (the preview pane, the viewer shell, a login form the app posts
//   into the frame) is Kandelo's own, whatever the frame showed before.
// - A client this worker cannot place (an about:blank or about:srcdoc
//   frame, a worker after a restart) falls back to its referrer as well.
function requesterMachine(event) {
  var from = referrerSource(event.request.referrer);
  if (event.request.mode === "navigate" && from.kandelo) return Promise.resolve(null);
  return viewerNameFor(event).then(function (name) {
    return name || from.machine;
  });
}

function pathInsideMachine(pathname) {
  var scopeRoot = SCOPE_PATH.slice(0, -1);
  if (scopeRoot && pathname === scopeRoot) return "/";
  if (scopeRoot && pathname.indexOf(scopeRoot + "/") === 0) return pathname.slice(scopeRoot.length);
  return pathname;
}

// --- Blob documents ---
//
// An app that shows an HTML document from a `blob:` URL in an iframe (the
// WordPress block and site editor canvas) gets a document no service worker
// controls, whose subresources would escape the bridge. The blob-iframe
// helper Kandelo injects into guest HTML (public/blob-iframe-interceptor.js)
// posts that HTML here (with the helper itself injected, so the document
// gets it too) under an unguessable id and points the iframe at
// `<scope>computer/<name>/__kandelo_blob/<id>`. This worker serves it, to
// frames of the same machine, as an ordinary controlled navigation, for as
// long as the blob URL lives: until the page revokes it, the creating
// document goes away, or it sits unread for BLOB_DOCUMENT_IDLE_MS. A reload
// or a history visit shows it again. Nothing depends on how an engine
// treats `blob:` or `about:srcdoc` documents inside a sandboxed frame.
//
// Bounds: each document at most MAX_BLOB_DOCUMENT_BYTES (UTF-8 bytes), all
// of them at most MAX_BLOB_TOTAL_BYTES and MAX_BLOB_DOCUMENTS (the oldest
// go first), and at most MAX_BLOB_WAITERS ids waiting for a document that
// has not arrived yet.

function forgetBlobDocument(id) {
  var entry = blobDocuments.get(id);
  if (!entry) return;
  blobDocuments.delete(id);
  blobBytes -= entry.bytes.byteLength;
}

function pruneBlobDocuments() {
  var now = Date.now();
  var entries = [];
  blobDocuments.forEach(function (entry, id) {
    if (entry.expires <= now) forgetBlobDocument(id);
    else entries.push([id, entry]);
  });
  return Promise.all(entries.map(function (pair) {
    return self.clients.get(pair[1].creatorId).then(function (creator) {
      if (!creator && blobDocuments.get(pair[0]) === pair[1]) forgetBlobDocument(pair[0]);
    }, function () {});
  }));
}

function storeBlobDocument(source, message) {
  // A string never has more UTF-16 units than UTF-8 bytes: reject the
  // obviously oversized before encoding.
  if (!BLOB_ID_PATTERN.test(String(message.id)) || typeof message.html !== "string" ||
      message.html.length > MAX_BLOB_DOCUMENT_BYTES) {
    return Promise.resolve();
  }
  return clientMachineName(source).then(function (name) {
    if (!name || blobDocuments.has(message.id)) return null;
    var base = typeof message.baseUrl === "string" ? safeSameOriginUrl(message.baseUrl) : null;
    var bytes = new TextEncoder().encode(withBase(message.html, base));
    if (bytes.byteLength > MAX_BLOB_DOCUMENT_BYTES) return null;
    return pruneBlobDocuments().then(function () {
      if (blobDocuments.has(message.id)) return;
      var oldest = blobDocuments.keys();
      while (blobDocuments.size > 0 &&
          (blobDocuments.size >= MAX_BLOB_DOCUMENTS || blobBytes + bytes.byteLength > MAX_BLOB_TOTAL_BYTES)) {
        forgetBlobDocument(oldest.next().value);
      }
      var entry = {
        name: name,
        bytes: bytes,
        creatorId: source.id,
        expires: Date.now() + BLOB_DOCUMENT_IDLE_MS,
      };
      blobDocuments.set(message.id, entry);
      blobBytes += bytes.byteLength;
      var waiting = blobWaiters.get(message.id);
      blobWaiters.delete(message.id);
      if (waiting) {
        waiting.forEach(function (resolve) { resolve(entry); });
      }
    });
  });
}

// The page revoked the blob URL: like the blob itself, the document can no
// longer be loaded again. Only a document of the same machine may revoke it.
function revokeBlobDocument(source, message) {
  var entry = blobDocuments.get(String(message.id));
  if (!entry) return Promise.resolve();
  return clientMachineName(source).then(function (name) {
    if (name === entry.name && blobDocuments.get(String(message.id)) === entry) {
      forgetBlobDocument(String(message.id));
    }
  });
}

function safeSameOriginUrl(value) {
  try {
    var url = new URL(value);
    return url.origin === self.location.origin ? url.href : null;
  } catch (_error) {
    return null;
  }
}

// The machine a guest document belongs to, from this worker's attribution
// map or the document's own URL.
function clientMachineName(client) {
  if (viewers.has(client.id)) return Promise.resolve(viewers.get(client.id));
  try {
    var url = new URL(client.url);
    if (url.origin === self.location.origin) {
      var name = nameFromPath(url.pathname);
      if (name) return Promise.resolve(name);
    }
  } catch (_error) {
    /* not a URL */
  }
  return Promise.resolve(null);
}

function findBlobDocument(id) {
  var entry = blobDocuments.get(id);
  if (entry) {
    if (entry.expires <= Date.now()) {
      forgetBlobDocument(id);
    } else {
      entry.expires = Date.now() + BLOB_DOCUMENT_IDLE_MS;
      return Promise.resolve(entry);
    }
  }
  // The helper posts the document, then sets the frame's URL; this
  // navigation may be handled before that message. Only so many may wait.
  var list = blobWaiters.get(id);
  if (!list && blobWaiters.size >= MAX_BLOB_WAITERS) return Promise.resolve(null);
  return new Promise(function (resolve) {
    if (!list) {
      list = [];
      blobWaiters.set(id, list);
    }
    var timer = setTimeout(function () {
      var current = blobWaiters.get(id);
      if (current) {
        var index = current.indexOf(done);
        if (index !== -1) current.splice(index, 1);
        if (current.length === 0) blobWaiters.delete(id);
      }
      resolve(null);
    }, BLOB_DOCUMENT_WAIT_MS);
    function done(found) {
      clearTimeout(timer);
      resolve(found);
    }
    list.push(done);
  });
}

function withBase(html, base) {
  // An about:srcdoc document resolved relative URLs against its creator's
  // base URL; keep that unless the document names its own base.
  if (!base || /<base[\s>]/i.test(html)) return html;
  var tag = "<base href=\"" + escapeHtml(base) + "\">";
  var head = /<head(?:\s[^>]*)?>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length);
  return tag + html;
}

function blobDocumentResponse(event, name, id) {
  if (!BLOB_ID_PATTERN.test(id) || event.request.method !== "GET") {
    return Promise.resolve(htmlPage(404, "No such Kandelo document", [
      "This address does not name a document a page of this computer created.",
    ]));
  }
  return findBlobDocument(id).then(function (entry) {
    if (!entry || entry.name !== name) {
      return htmlPage(404, "No such Kandelo document", [
        "This in-page document was revoked, has expired, or belongs to another computer.",
      ]);
    }
    markViewer(event, name);
    return new Response(entry.bytes.slice(), {
      status: 200,
      headers: isolationHeaders(new Headers({
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      })),
    });
  });
}

// --- Fetch ---

function dispatch(event, name, path) {
  var request = event.request;
  return bridgeFor(name).then(function (bridge) {
    if (!bridge) return offlineResponse(name);
    markViewer(event, name);
    var readBody = request.method === "GET" || request.method === "HEAD"
      ? Promise.resolve(null)
      : request.arrayBuffer();
    return readBody.then(function (body) {
      var headers = [];
      request.headers.forEach(function (value, key) {
        headers.push([key, value]);
      });
      return ask(name, bridge, {
        type: "http-request",
        method: request.method,
        url: path,
        headers: headers,
        body: body,
        mode: request.mode,
        destination: request.destination,
        navigation: request.mode === "navigate",
      }, body ? [body] : []);
    }).then(function (reply) {
      if (reply && reply.offline) return offlineResponse(name);
      if (reply && reply.timeout) return timeoutResponse(name);
      return guestResponse(reply);
    });
  }).catch(function (error) {
    return htmlPage(502, "Kandelo could not reach this computer's web server", [escapeHtml(error)]);
  });
}

function crossOriginRead(event, name) {
  var request = event.request;
  return bridgeFor(name).then(function (bridge) {
    if (!bridge) return fetch(request);
    var headers = [];
    request.headers.forEach(function (value, key) {
      headers.push([key, value]);
    });
    return ask(name, bridge, {
      type: "proxy-fetch",
      url: request.url,
      method: request.method,
      headers: headers,
    }).then(function (reply) {
      // Without the owning tab's proxy read, the guest's own request is the
      // truthful fallback: the browser decides it under COEP and CORS.
      if (!reply || reply.type !== "http-response") return fetch(request);
      var response = guestResponse(reply);
      response.headers.set("Access-Control-Allow-Origin", self.location.origin);
      response.headers.set("Access-Control-Expose-Headers",
        "Accept-Ranges, Content-Length, Content-Range, Content-Type, ETag, Last-Modified");
      return response;
    });
  });
}

function machineResponse(event, name, url) {
  var root = COMPUTER_BASE + name;
  var path = url.pathname === root ? "/" : url.pathname.slice(root.length);
  if (path === "/" + KEEPALIVE_PROBE_SEGMENT) {
    // [RUNTIME-WORKAROUND: FIREFOX-KEEPALIVE-FETCH-BYPASSES-SERVICE-WORKER]
    // The guest helper asks once per document whether a keepalive fetch
    // reaches this worker; only a worker-made answer carries this header.
    return Promise.resolve(new Response(null, {
      status: 204,
      headers: isolationHeaders(new Headers({
        "Cache-Control": "no-store",
        "X-Kandelo-Preview-Worker": "keepalive",
      })),
    }));
  }
  var blobPrefix = "/" + BLOB_DOCUMENT_SEGMENT + "/";
  if (path.indexOf(blobPrefix) === 0) {
    return blobDocumentResponse(event, name, path.slice(blobPrefix.length));
  }
  return dispatch(event, name, path + url.search);
}

self.addEventListener("fetch", function (event) {
  if (!deploymentWorker) return;
  var request = event.request;
  var url = new URL(request.url);

  if (url.origin !== self.location.origin) {
    // A guest's cross-origin read goes through its owning tab and Kandelo's
    // CORS proxy, as it did when guests shared Kandelo's origin.
    if (
      config && (request.method === "GET" || request.method === "HEAD") &&
      event.clientId
    ) {
      event.respondWith(viewerNameFor(event).then(function (name) {
        return name ? crossOriginRead(event, name) : fetch(request);
      }));
    }
    return;
  }

  var inComputerNamespace = url.pathname === COMPUTER_ROOT ||
    url.pathname.indexOf(COMPUTER_BASE) === 0;
  if (inComputerNamespace) {
    var name = nameFromPath(url.pathname);
    if (!config) {
      event.respondWith(htmlPage(503, "Kandelo previews are not configured here", [
        "This preview origin was deployed without its Kandelo app origin.",
      ]));
      return;
    }
    if (!name) {
      var segment = nameSegment(url.pathname);
      if (segment && LEGACY_NAME_PATTERN.test(segment)) {
        // An old link: the viewer shell says so on Kandelo's origin; any
        // other request gets the same explanation here.
        event.respondWith(request.mode === "navigate" && request.destination === "document"
          ? topLevelResponse(request, url)
          : legacyNameResponse(segment));
        return;
      }
      event.respondWith(htmlPage(404, "No such Kandelo computer", [
        "This address does not name a Kandelo computer.",
      ]));
      return;
    }
    if (request.mode === "navigate" && request.destination === "document") {
      event.respondWith(topLevelResponse(request, url));
      return;
    }
    event.respondWith(requesterMachine(event).then(function (from) {
      // Decided before asking any owner, so the answer says nothing about
      // whether the other machine is running.
      if (from && from !== name) return crossMachineResponse(name);
      return machineResponse(event, name, url);
    }));
    return;
  }

  if (url.pathname === RELAY_PATH || url.pathname === SCOPE_PATH + WORKER_FILE) {
    return;
  }

  // A nameless request from a guest document (`/style.css` written by a
  // server that ignores the forwarded prefix) belongs to the machine that
  // document shows.
  if (!config || !event.clientId) return;
  event.respondWith(viewerNameFor(event).then(function (name) {
    if (!name) return fetch(request);
    var inside = pathInsideMachine(url.pathname);
    if (request.method === "GET" || request.method === "HEAD") {
      var target = new URL(url.href);
      target.pathname = COMPUTER_BASE + name + inside;
      return new Response(null, {
        status: 307,
        headers: isolationHeaders(new Headers({ Location: target.href })),
      });
    }
    // WebKit drops request bytes when replaying a synthetic 307, so a write
    // is dispatched once, under the same machine path.
    return dispatch(event, name, inside + url.search);
  }));
});

# External Kernel HTTP Request Interface — Prototype

Status: prototype, rebased for review.
Date: 2026-04-30; updated 2026-05-20
Branch: `external-kernel-http-request-interface-prototype`

## Problem

The host can currently route HTTP into in-kernel servers (nginx, php-fpm, etc.)
in two ways, neither of which is a first-class API:

1. **Real TCP** — `NodePlatformIO` opens a real `net.Server` on the host and
   pumps bytes into the kernel's pipe-backed sockets via `kernel_inject_connection`.
   Works only on Node, requires OS port allocation, and the host has to talk
   to itself over TCP.
2. **Service-worker bridge** — In the browser, a `MessagePort` is transferred
   from the main thread to the kernel worker. The worker hardcodes a connection
   pump that decodes the SW's request shape and synthesizes raw HTTP bytes. The
   pump lives inline in `host/src/browser-kernel-worker-entry.ts` and is bound
   to one configured port.

Neither surface lets host code (a test, a wrapper app, a non-SW browser
caller) say *"send this HTTP request to the in-kernel server on port N and
give me back the response."*

## Goal

A single host-side API:

```ts
kernel.fetchInKernel(port, request: HttpRequest): Promise<HttpResponse>
```

available on both `BrowserKernel` and `NodeKernelHost`. Internally it reuses
the existing `kernel_inject_connection` / `kernel_pipe_*` exports — same path
both bridges already use — but consolidates the framing, pumping, and parsing
into one place.

## Design

### Where the work happens

The pump must run inside the kernel worker (it touches private state:
`tcpScratchOffset`, `processes`, `pendingPipeReaders`, `pendingPollRetries`,
`scheduleWakeBlockedRetries`, etc.). So:

- Add a public method **`CentralizedKernelWorker.sendHttpRequest(port, request)`**
  that owns the pump.
- Both worker entries (`host/src/browser-kernel-worker-entry.ts`,
  `host/src/node-kernel-worker-entry.ts`) get a small message handler that
  calls this method and posts the response.
- Both hosts (`BrowserKernel`, `NodeKernelHost`) get a `fetchInKernel` method
  that sends the message and awaits the response.

### Shared types and helpers

`host/src/networking/in-kernel-http.ts`:

```ts
export interface HttpRequest {
  method: string;
  url: string;                          // request-target, e.g. "/foo?bar=1"
  headers: Record<string, string>;
  body: Uint8Array | null;
}
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}
export function buildRawHttpRequest(req: HttpRequest): Uint8Array;
export function parseRawHttpResponse(bytes: Uint8Array): HttpResponse;
```

`buildRawHttpRequest` synthesizes HTTP/1.1 bytes (always sets
`Connection: close`, computes `Content-Length` if the caller didn't).
`parseRawHttpResponse` parses the status line, headers, body, and decodes
chunked transfer encoding. Both are extracted from the existing inline copies
in `apps/browser-demos/lib/connection-pump.ts` and
`host/src/browser-kernel-worker-entry.ts`.

### Worker-side method

```ts
class CentralizedKernelWorker {
  async sendHttpRequest(
    port: number,
    request: HttpRequest,
    opts?: { timeoutMs?: number; debugLabel?: string },
  ): Promise<HttpResponse>;
}
```

Steps:
1. Resolve listener target: `pickListenerTarget(port)` → `{pid, fd}` or fail.
2. Inject connection: call `kernel_inject_connection` → `recvPipeIdx`.
3. Wake any pending poll retries on the target pid (so accept fires fast).
4. Build raw request, write to recv pipe with chunked spilling through scratch.
5. Pump send pipe (`recvPipeIdx + 1`):
   - Read on every tick, push into chunk list.
   - Wake blocked writers each tick.
   - Done when we've seen write-end open AND it's now closed AND read returned 0.
   - Bail with 504 on timeout (default 60s).
6. Close both pipe ends, parse response, resolve.

`pickListenerTarget` becomes public (it's already used internally by the
service-worker pump).

### Browser plumbing

`MainToKernelMessage` adds `{ type: "http_request", requestId, port, request }`
and the existing `response` message carries the result back. `BrowserKernel`
adds:

```ts
async fetchInKernel(port: number, request: HttpRequest): Promise<HttpResponse>
```

The existing service-worker bridge handler in
`host/src/browser-kernel-worker-entry.ts` is rewritten to call
`kernelWorker.sendHttpRequest` so we don't carry two copies of the pump.

### Node plumbing

`node-kernel-protocol.ts` gets the same `http_request` message type. The
worker entry routes it to `kernelWorker.sendHttpRequest` and replies via the
existing `response` message. `NodeKernelHost` exposes `fetchInKernel`.

### Test

A new vitest `host/test/in-kernel-http.test.ts`:

1. Boots `NodeKernelHost` with a tiny C HTTP server program that listens on
   a port, accepts one connection, reads the request, writes a fixed
   response, closes, and exits.
2. Calls `host.fetchInKernel(port, { method: "GET", url: "/", ... })` and
   asserts status, headers, and body.

The C program lives at `programs/tiny-http-server.c` and is built by
`scripts/build-programs.sh`.

## Out of scope (prototype)

- Streaming request/response bodies (we send/buffer the whole thing).
- HTTPS / TLS — irrelevant for in-kernel servers; they speak plaintext on
  loopback-equivalent pipes.
- HTTP/2.
- WebSocket upgrade.
- Pipelining (each call opens a fresh injected connection).
- Removing the legacy `sendBridgePort` flow entirely. It still exists for
  browser demos that continue to bridge service-worker requests directly to
  the kernel worker; the migrated demos now use `fetchInKernel` through a thin
  main-thread adapter.

## Migration path

Once the API exists and ships, the SW bridge becomes a thin adapter that calls
`fetchInKernel`. The Node real-TCP path can stay as-is (it's a different
contract — the *outside world* connecting to the kernel — vs. this one which
is *the host* talking to the kernel). They coexist.

## Migration outcomes (2026-04-30)

### WordPress browser demos — DONE

`apps/browser-demos/pages/wordpress/main.ts` and
`apps/browser-demos/pages/lamp/main.ts` were the two largest consumers of the
old `kernel.sendBridgePort(port, kernelPort)` flow that transferred a
`MessagePort` to the kernel worker. Both now call

```ts
await setupServiceWorkerFetchBridge(SW_URL, APP_PREFIX, kernel, HTTP_PORT, ...);
```

(see `apps/browser-demos/lib/init/sw-bridge-fetch.ts`). The helper installs a
single `bridge.onRequest` handler that forwards each SW-intercepted request
to `kernel.fetchInKernel(port, request)` and replies with the parsed
response. The `MessagePort`-transfer path (`sendBridgePort`) is no longer
used by these two demos — it stays available for demos that still use the
older worker-side bridge.

End-to-end verified through Playwright: the WordPress install page renders
inside the iframe via the new fetchInKernel route.

### Node WordPress test (`wordpress-server.test.ts`) — DONE

The vitest test that previously stood up `CentralizedKernelWorker` directly,
allocated a real localhost port via `getRandomPort`, and used `fetch()` over
that port — ~240 lines of boilerplate — was rewritten to use `NodeKernelHost`
+ `host.fetchInKernel`. It is now ~80 lines, has no real port allocation,
and runs in <1s (vs. ~30s previously). It also asserts the WordPress install
page renders, not just "any HTTP response."

### Node `serve.ts` / `serve-nginx.ts` — NOT MIGRATED (intentional)

These scripts exist to expose an in-kernel server on a real localhost port
so that ordinary browsers and `curl` can talk to it. That is the opposite
contract from `fetchInKernel`: those scripts already use the
`NodePlatformIO`-managed `net.Server` to bridge real TCP into the kernel,
which is the right tool for "let the outside world reach the kernel."

`fetchInKernel` is for "the host wants to send a single HTTP request *to*
the kernel, in-process." Replacing the real-TCP listener in `serve.ts` with
a Node `http.Server` that internally calls `fetchInKernel` would re-add the
same TCP plumbing the existing path has, with worse fidelity (no real
client IPs, no TCP-level features). Not worth it.

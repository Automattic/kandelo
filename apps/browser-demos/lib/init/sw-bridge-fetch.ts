/**
 * Wire a service-worker HTTP bridge to BrowserKernel.fetchInKernel.
 *
 * The service-worker bridge gives us an `HttpBridgeHost` whose `onRequest`
 * fires whenever the SW intercepts an in-kernel app fetch. Each such
 * request gets forwarded to `kernel.fetchInKernel(port, ...)` and the
 * resulting response is sent back through the bridge.
 *
 * Replaces the older pattern that transferred the bridge's MessagePort to
 * the kernel worker via `kernel.sendBridgePort`. The new pattern keeps the
 * bridge entirely on the main thread; the kernel worker no longer needs a
 * special direct port.
 */
import type { BrowserKernel } from "@host/browser-kernel-host";
import { HttpBridgeHost, type HttpRequest } from "../http-bridge";
import { initServiceWorkerBridge } from "./service-worker-bridge";

interface ServiceWorkerFetchBridgeOptions {
  timeoutMs?: number;
  debugLog?: (line: string) => void;
  onRequestStart?: (request: HttpRequest) => ((status: number | null, error?: string) => void) | undefined;
  onPendingRequests?: (count: number) => void;
}

/** Hook a single bridge instance up to fetchInKernel. */
export function attachBridgeToKernel(
  bridge: HttpBridgeHost,
  kernel: BrowserKernel,
  port: number,
  options?: ServiceWorkerFetchBridgeOptions,
): void {
  let pendingRequests = 0;
  const updatePendingRequests = (delta: 1 | -1) => {
    pendingRequests = Math.max(0, pendingRequests + delta);
    options?.onPendingRequests?.(pendingRequests);
  };

  bridge.onRequest(async (requestId, request: HttpRequest) => {
    const completed = options?.onRequestStart?.(request);
    updatePendingRequests(1);
    try {
      const response = await kernel.fetchInKernel(port, request, {
        timeoutMs: options?.timeoutMs,
      });
      completed?.(response.status);
      bridge.respond(requestId, response);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      options?.debugLog?.(`bridge fetch failed: ${request.method} ${request.url}: ${msg}`);
      completed?.(null, msg);
      bridge.error(requestId, msg);
    } finally {
      updatePendingRequests(-1);
    }
  });
}

/**
 * Set up a service-worker HTTP bridge whose requests are routed to
 * `kernel.fetchInKernel(port, ...)`. Returns the bridge so callers can
 * track readiness or tear down.
 *
 * Also installs a `need-bridge` listener for service-worker restarts: when
 * the SW reincarnates and asks for a fresh bridge, we hand it a new
 * `HttpBridgeHost` already wired to `fetchInKernel` so the iframe keeps
 * working without a kernel restart.
 *
 * `sessionId` uniquely identifies this Kandelo machine instance and scopes the
 * SW cookie jar to it, so cookies are never shared between sessions. It is sent
 * on both the initial handshake and the restart handshake so the SW reloads the
 * same session's jar after it is terminated. This page keeps `sessionId` in
 * memory for its whole lifetime, so it is stable across SW restarts but fresh on
 * a full reload (a new temporary session).
 */
export async function setupServiceWorkerFetchBridge(
  swUrl: string,
  scopePath: string,
  kernel: BrowserKernel,
  port: number,
  sessionId: string,
  options?: ServiceWorkerFetchBridgeOptions,
): Promise<{ bridge: HttpBridgeHost; name: string; appPrefix: string }> {
  const created = await initServiceWorkerBridge(swUrl, scopePath, sessionId);
  if (!created) {
    throw new Error("Service workers unavailable — HTTP bridge not initialized");
  }
  const { bridge, name, appPrefix } = created;
  attachBridgeToKernel(bridge, kernel, port, options);

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (event) => {
      if (event.data?.type !== "need-bridge") return;
      const replyPort = event.ports[0];
      if (!replyPort) return;
      const fresh = new HttpBridgeHost();
      attachBridgeToKernel(fresh, kernel, port, options);
      // Re-assert this machine's SW-minted name so only its hosting tab answers
      // the SW's restart handshake for that name.
      replyPort.postMessage(
        { type: "bridge-restored", name, appPrefix, sessionId },
        [fresh.getSwPort()],
      );
      options?.debugLog?.("Bridge restored after service worker restart");
    });

    // Announce this machine's departure when the hosting tab goes away, so the
    // SW can immediately mark it offline and push machine-offline to any viewer
    // tabs instead of waiting for lazy owner reconciliation on a later request.
    // pagehide (not unload) fires reliably on bfcache and mobile tab teardown.
    // Only announce when the page is truly being discarded: a bfcache
    // suspension fires pagehide with event.persisted === true and the tab is
    // still alive (it can be restored), so offlining + GC'ing the machine then
    // would kill a live tab's machine on every back/forward navigation.
    window.addEventListener("pagehide", (event) => {
      if (event.persisted) return;
      navigator.serviceWorker.controller?.postMessage({
        type: "instance-closing",
        name,
      });
    });
  }

  return { bridge, name, appPrefix };
}

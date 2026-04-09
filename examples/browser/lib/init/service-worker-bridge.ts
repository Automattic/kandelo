/**
 * Service worker bridge initialization — shared across all demos that use
 * a service worker to intercept HTTP requests (nginx, nginx-php, wordpress, lamp).
 *
 * Extracted from the duplicated initBridge() function in those demo pages.
 */
import { HttpBridgeHost } from "../http-bridge";

/**
 * Initialize the service worker HTTP bridge.
 *
 * 1. Creates an HttpBridgeHost (MessageChannel pair)
 * 2. Registers the service worker at swUrl
 * 3. Waits for navigator.serviceWorker.ready
 * 4. Sends "init-bridge" message with the bridge's SW port and appPrefix
 * 5. Waits for the SW to confirm initialization
 * 6. Returns the ready bridge
 *
 * @param swUrl     — URL of the service worker script (e.g. "/demo/service-worker.js")
 * @param appPrefix — URL prefix the SW intercepts (e.g. "/demo/app/")
 * @returns The initialized HttpBridgeHost, or null if service workers are unavailable
 */
export async function initServiceWorkerBridge(
  swUrl: string,
  appPrefix: string,
): Promise<HttpBridgeHost | null> {
  if (!("serviceWorker" in navigator)) {
    return null;
  }

  const bridge = new HttpBridgeHost();

  // Register the unified service worker (no-op if already registered by COI script)
  await navigator.serviceWorker.register(swUrl);

  // Wait for the service worker to activate and claim this client
  const reg = await navigator.serviceWorker.ready;

  // Send bridge port and wait for SW to confirm it's initialized
  await new Promise<void>((resolve) => {
    const reply = new MessageChannel();
    reply.port1.onmessage = () => resolve();
    reg.active!.postMessage(
      { type: "init-bridge", appPrefix },
      [bridge.getSwPort(), reply.port2],
    );
  });

  return bridge;
}

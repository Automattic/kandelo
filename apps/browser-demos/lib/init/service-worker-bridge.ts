/**
 * Service worker bridge initialization — shared across all demos that use
 * a service worker to intercept HTTP requests (nginx, nginx-php, wordpress, lamp).
 *
 * Extracted from the duplicated initBridge() function in those demo pages.
 */
import { HttpBridgeHost } from "../http-bridge";

const SERVICE_WORKER_READY_TIMEOUT_MS = 10_000;

function waitForServiceWorkerController(
  timeoutMs = SERVICE_WORKER_READY_TIMEOUT_MS,
): Promise<ServiceWorker> {
  if (navigator.serviceWorker.controller) {
    return Promise.resolve(navigator.serviceWorker.controller);
  }

  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      reject(new Error("Timed out waiting for service worker control"));
    }, timeoutMs);

    const onControllerChange = () => {
      const controller = navigator.serviceWorker.controller;
      if (!controller) return;
      window.clearTimeout(timeout);
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      resolve(controller);
    };

    navigator.serviceWorker.addEventListener(
      "controllerchange",
      onControllerChange,
    );
  });
}

/**
 * Ensure the page is controlled by the unified service worker before code
 * starts work that depends on cross-origin isolation or SW-routed fetches.
 */
export async function ensureServiceWorkerReady(swUrl: string): Promise<ServiceWorker> {
  if (!("serviceWorker" in navigator)) {
    throw new Error("Service workers unavailable");
  }

  await navigator.serviceWorker.register(swUrl, { updateViaCache: "none" });
  await navigator.serviceWorker.ready;
  return waitForServiceWorkerController();
}

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
 * @param sessionId — unique id for this Kandelo machine instance; scopes the
 *                    SW cookie jar so sessions never share cookies
 * @returns The initialized HttpBridgeHost, or null if service workers are unavailable
 */
export async function initServiceWorkerBridge(
  swUrl: string,
  appPrefix: string,
  sessionId: string,
): Promise<HttpBridgeHost | null> {
  if (!("serviceWorker" in navigator)) {
    return null;
  }

  const bridge = new HttpBridgeHost();
  const controller = await ensureServiceWorkerReady(swUrl);

  // Send bridge port and wait for SW to confirm it's initialized
  await new Promise<void>((resolve) => {
    const reply = new MessageChannel();
    reply.port1.onmessage = () => resolve();
    controller.postMessage(
      { type: "init-bridge", appPrefix, sessionId },
      [bridge.getSwPort(), reply.port2],
    );
  });

  return bridge;
}

/**
 * Service worker bridge initialization — shared across all demos that use
 * a service worker to intercept HTTP requests (nginx, nginx-php, wordpress, lamp).
 *
 * Extracted from the duplicated initBridge() function in those demo pages.
 */
import { HttpBridgeHost } from "../http-bridge";
import { persistentWebRouteLock, persistentWebRouteName } from "./persistent-web-route";
import {
  deploymentScopeFromServiceWorkerUrl,
  normalizeDeploymentBase,
} from "../../../../web-libs/kandelo-session/src/deployment-scope";

const SERVICE_WORKER_READY_TIMEOUT_MS = 10_000;

export class UnconfirmedPersistentWebBridgeOwnership extends Error {
  constructor(cause: unknown) {
    super("persistent HTTP bridge claim drainage is unconfirmed; reload before restarting this computer", { cause });
  }
}

function waitForOwnedServiceWorker(
  registration: ServiceWorkerRegistration,
  expectedScriptUrl: string,
  expectedScopeUrl: string,
): Promise<ServiceWorker> {
  return new Promise((resolve, reject) => {
    const cleanupCallbacks: Array<() => void> = [];
    let settled = false;
    const timeout = window.setTimeout(() => {
      finish(() => reject(new Error(
        "Timed out waiting for service worker control by " +
          `${expectedScriptUrl} at scope ${expectedScopeUrl}`,
      )));
    }, SERVICE_WORKER_READY_TIMEOUT_MS);

    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      for (const cleanup of cleanupCallbacks.splice(0)) cleanup();
      complete();
    };

    const observedWorkers = new Set<ServiceWorker>();
    const observeWorker = (worker: ServiceWorker | null) => {
      if (!worker || observedWorkers.has(worker)) return;
      observedWorkers.add(worker);
      worker.addEventListener("statechange", checkOwnership);
      cleanupCallbacks.push(() => {
        worker.removeEventListener("statechange", checkOwnership);
      });
    };

    const checkOwnership = () => {
      if (settled) return;
      observeWorker(registration.installing);
      observeWorker(registration.waiting);
      observeWorker(registration.active);

      const active = registration.active;
      if (!active) return;
      if (active.scriptURL !== expectedScriptUrl) {
        finish(() => reject(new Error(
          `Returned registration active script ${active.scriptURL} does not match ` +
            `requested script ${expectedScriptUrl}`,
        )));
        return;
      }

      const controller = navigator.serviceWorker.controller;
      if (!controller || controller.scriptURL !== expectedScriptUrl) return;
      finish(() => resolve(controller));
    };

    const onControllerChange = () => {
      checkOwnership();
    };

    navigator.serviceWorker.addEventListener(
      "controllerchange",
      onControllerChange,
    );
    cleanupCallbacks.push(() => {
      navigator.serviceWorker.removeEventListener(
        "controllerchange",
        onControllerChange,
      );
    });
    registration.addEventListener("updatefound", checkOwnership);
    cleanupCallbacks.push(() => {
      registration.removeEventListener("updatefound", checkOwnership);
    });
    checkOwnership();
  });
}

/**
 * Ensure the page is controlled by the unified service worker before code
 * starts work that depends on cross-origin isolation or SW-routed fetches.
 */
export async function ensureServiceWorkerReady(
  swUrl: string,
  scopePath?: string,
): Promise<ServiceWorker> {
  if (!("serviceWorker" in navigator)) {
    throw new Error("Service workers unavailable");
  }

  const pageUrl = new URL(window.location.href);
  const scriptUrl = new URL(swUrl, pageUrl);
  const expectedScopePath = deploymentScopeFromServiceWorkerUrl(
    scriptUrl.href,
    pageUrl.href,
  );
  if (
    scopePath !== undefined &&
    normalizeDeploymentBase(scopePath) !== expectedScopePath
  ) {
    throw new Error(
      `Explicit service worker scope ${scopePath} does not match script directory ` +
        expectedScopePath,
    );
  }

  const registration = await navigator.serviceWorker.register(scriptUrl.href, {
    scope: expectedScopePath,
    updateViaCache: "none",
  });
  const expectedScopeUrl = new URL(expectedScopePath, pageUrl).href;
  if (registration.scope !== expectedScopeUrl) {
    throw new Error(
      `Returned service worker scope ${registration.scope} does not match ` +
        `expected scope ${expectedScopeUrl}`,
    );
  }
  return waitForOwnedServiceWorker(
    registration,
    scriptUrl.href,
    expectedScopeUrl,
  );
}

/**
 * Initialize the service worker HTTP bridge.
 *
 * 1. Creates an HttpBridgeHost (MessageChannel pair)
 * 2. Registers the service worker at swUrl
 * 3. Verifies the returned registration and waits for its matching controller
 * 4. Sends "init-bridge" message with the bridge's SW port and sessionId
 * 5. Waits for the SW to mint and confirm a machine name + app prefix
 * 6. Returns the ready bridge and the SW-minted name/appPrefix
 *
 * The service worker owns machine naming: the page no longer chooses the app
 * prefix. It sends only the sessionId and receives the minted `name` and
 * `appPrefix` in the bridge-ready reply.
 *
 * @param swUrl     — URL of the service worker script (e.g. "/demo/service-worker.js")
 * @param scopePath — normalized deployment scope owned by that script
 * @param sessionId — unique id for this Kandelo machine instance; scopes the
 *                    SW cookie jar so sessions never share cookies
 * @returns The initialized bridge with its SW-minted name and appPrefix, or
 *          null if service workers are unavailable
 */
export async function initServiceWorkerBridge(
  swUrl: string,
  scopePath: string,
  sessionId: string,
  persistentComputerName?: string,
): Promise<{ bridge: HttpBridgeHost; name: string; appPrefix: string } | null> {
  if (!("serviceWorker" in navigator)) {
    return null;
  }

  const bridge = new HttpBridgeHost();
  const controller = await ensureServiceWorkerReady(swUrl, scopePath);
  const persistentName = persistentComputerName === undefined ? undefined
    : await persistentWebRouteName(scopePath, persistentComputerName);
  let releaseProof: (() => void) | undefined;
  let holdingProof: Promise<unknown> | undefined;

  // Send bridge port and wait for the SW to mint and confirm the machine name.
  try {
    const minted = await new Promise<{ name: string; appPrefix: string }>(
    (resolve, reject) => {
      const reply = new MessageChannel();
      let settled = false;
      const timeout = persistentName === undefined ? undefined : window.setTimeout(() => finish(() => reject(new Error(
        "Timed out initializing service worker HTTP bridge",
      ))), SERVICE_WORKER_READY_TIMEOUT_MS);
      const finish = (complete: () => void) => {
        if (settled) return;
        settled = true;
        if (timeout !== undefined) window.clearTimeout(timeout);
        reply.port1.onmessage = null;
        reply.port1.close();
        complete();
      };
      reply.port1.onmessage = (event) => {
        const message = event.data;
        if (message?.type === "bridge-lease-challenge" && persistentName !== undefined &&
          typeof message.nonce === "string" && /^[a-f0-9-]{36}$/.test(message.nonce) && !holdingProof) {
          const released = new Promise<void>(complete => { releaseProof = complete; });
          holdingProof = navigator.locks.request(`kandelo-http-bridge-proof:${message.nonce}`,
            { mode: "exclusive", ifAvailable: true }, async lock => {
              if (!lock) throw new Error("HTTP bridge proof lease unavailable");
              if (settled) return;
              reply.port1.postMessage({ type: "bridge-lease-proof", nonce: message.nonce });
              await released;
            });
          void holdingProof.catch(error => finish(() => reject(error)));
        } else if (
          message?.type === "bridge-ready" &&
          typeof message.name === "string" &&
          typeof message.appPrefix === "string"
        ) {
          finish(() =>
            resolve({ name: message.name, appPrefix: message.appPrefix })
          );
        } else if (message?.type === "bridge-error") {
          const code = typeof message.code === "string"
            ? message.code
            : "unknown";
          finish(() => reject(new Error(
            `Service worker bridge initialization failed: ${code}`,
          )));
        } else {
          finish(() => reject(new Error(
            "Unexpected bridge initialization reply",
          )));
        }
      };
      try {
        controller.postMessage(
          { type: "init-bridge", sessionId,
            ...(persistentComputerName === undefined ? {} : { persistentComputerName }) },
          [bridge.getSwPort(), reply.port2],
        );
      } catch (error) {
        finish(() => reject(error));
      }
    },
  );

    return { bridge, name: minted.name, appPrefix: minted.appPrefix };
  } finally {
    releaseProof?.();
    try {
      await holdingProof;
    } finally {
      if (persistentName !== undefined) {
        try {
          await navigator.locks.request(persistentWebRouteLock(scopePath, persistentName), () => {});
        } catch (error) {
          throw new UnconfirmedPersistentWebBridgeOwnership(error);
        }
      }
    }
  }
}

/**
 * Kandelo service worker readiness. The app's own service worker gives the
 * page cross-origin isolation, the CORS proxy and its credential gate, and
 * the lazy VFS cache. It serves no guest web page: those come from the
 * deployment's preview origin (see lib/preview/).
 */
import {
  deploymentScopeFromServiceWorkerUrl,
  normalizeDeploymentBase,
} from "../../../../web-libs/kandelo-session/src/deployment-scope";

const SERVICE_WORKER_READY_TIMEOUT_MS = 10_000;

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

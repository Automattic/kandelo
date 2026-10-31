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
/** How long a worker has to name its build before it counts as unnamed. */
const BUILD_QUERY_TIMEOUT_MS = 2_000;
/**
 * How long the page waits for its own deployment's worker to take control
 * after asking the browser to update. The update fetch has already finished
 * when `registration.update()` settles; this covers install and activation.
 */
const BUILD_TAKEOVER_TIMEOUT_MS = 15_000;

/**
 * The page and the service worker controlling it belong to different builds,
 * and asking the browser to update did not bring this page's worker. Thrown
 * before boot starts any worker. `workerBuildId` is null when the worker did
 * not name a build (one deployed before build ids, or one that did not answer).
 */
export class ServiceWorkerBuildMismatchError extends Error {
  constructor(
    readonly pageBuildId: string,
    readonly workerBuildId: string | null,
    detail: string,
  ) {
    super(
      `This page is Kandelo build ${pageBuildId}, but the service worker ` +
        `controlling it is ${workerBuildId === null ? "a build that does not report its id" : `build ${workerBuildId}`}: ${detail}`,
    );
    this.name = "ServiceWorkerBuildMismatchError";
  }
}

export interface ServiceWorkerReadyOptions {
  /**
   * This page's build id (vite/build-id.ts). When set, readiness also
   * requires the controlling worker to report it.
   */
  buildId?: string;
  /** Called once if the controlling worker belongs to another build. */
  onBuildMismatch?: (workerBuildId: string | null) => void;
}

/**
 * Ask the worker that controls this page which build it belongs to; null if
 * it does not say. A fetch reaches exactly the worker that answers the page's
 * other requests, the one that matters, and the server (which has no such
 * file) when no worker answers it, as before build ids existed.
 */
async function queryControllerBuildId(scopeUrl: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), BUILD_QUERY_TIMEOUT_MS);
  try {
    const response = await fetch(new URL("__kandelo_build_id", scopeUrl), {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const data = await response.json() as { type?: unknown; buildId?: unknown } | null;
    return data?.type === "kandelo-build-id" && typeof data.buildId === "string"
      ? data.buildId
      : null;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timeout);
  }
}

/**
 * Resolve with a controller that reports `buildId`, or reject with
 * `ServiceWorkerBuildMismatchError`.
 *
 * WHY: the first navigation after a deploy is answered by the previous
 * deployment's worker. The browser fetches the new worker during that
 * navigation and lets it take over afterwards. A page that boots in between
 * starts its workers under the old worker (its kernel-worker script paths,
 * its caches), and in Chromium a worker created during the takeover was seen
 * never to start. Asking for the update and waiting for the takeover first
 * means the page's workers only ever run under its own deployment's worker.
 */
async function awaitControllerBuild(
  registration: ServiceWorkerRegistration,
  owned: ServiceWorker,
  expectedScriptUrl: string,
  scopeUrl: string,
  buildId: string,
  onBuildMismatch: ((workerBuildId: string | null) => void) | undefined,
): Promise<ServiceWorker> {
  const ownedBuildId = await queryControllerBuildId(scopeUrl);
  if (ownedBuildId === buildId) return owned;
  onBuildMismatch?.(ownedBuildId);
  return new Promise<ServiceWorker>((resolve, reject) => {
    let settled = false;
    let updated = false;
    let lastBuildId = ownedBuildId;
    // Controllers whose answer is final: a different build, or no id from an
    // activated worker. A worker still activating may not answer yet.
    const answered = new Set<ServiceWorker>([owned]);
    let asking: ServiceWorker | null = null;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      navigator.serviceWorker.removeEventListener("controllerchange", check);
      complete();
    };
    const mismatch = (detail: string) =>
      new ServiceWorkerBuildMismatchError(buildId, lastBuildId, detail);
    const timeout = window.setTimeout(() => {
      finish(() => reject(mismatch(
        `this deployment's service worker did not take control within ${BUILD_TAKEOVER_TIMEOUT_MS / 1000} s`,
      )));
    }, BUILD_TAKEOVER_TIMEOUT_MS);
    // After the update ran: with no newer worker on the way and the
    // controller's answer final, nothing will change by waiting.
    const decide = () => {
      if (settled || !updated) return;
      const current = navigator.serviceWorker.controller;
      const pending = registration.installing !== null || registration.waiting !== null ||
        registration.active !== current;
      if (pending || current === null || asking !== null || !answered.has(current)) return;
      finish(() => reject(mismatch(
        "the server's service-worker.js is the one already running, not this page's build",
      )));
    };
    function check(): void {
      const current = navigator.serviceWorker.controller;
      if (
        settled || !current || current.scriptURL !== expectedScriptUrl ||
        answered.has(current) || asking !== null
      ) {
        return;
      }
      asking = current;
      void queryControllerBuildId(scopeUrl).then((currentBuildId) => {
        asking = null;
        if (settled) return;
        if (navigator.serviceWorker.controller !== current) {
          // Another takeover while asking: ask the new controller.
          check();
          return;
        }
        lastBuildId = currentBuildId;
        if (currentBuildId === buildId) {
          finish(() => resolve(current));
          return;
        }
        if (currentBuildId === null && current.state !== "activated") {
          // Ask again once it has finished activating.
          current.addEventListener("statechange", check, { once: true });
        } else {
          answered.add(current);
        }
        decide();
      });
    }
    navigator.serviceWorker.addEventListener("controllerchange", check);
    // The browser checks for a new worker on every navigation. Ask only when
    // that has not already brought one: in Chromium, a second update request
    // racing the navigation's own was seen to keep the new worker from ever
    // activating while the page stayed (see public/service-worker.js).
    const update = registration.installing !== null || registration.waiting !== null
      ? Promise.resolve()
      : registration.update();
    update.then(() => {
      updated = true;
      check();
      decide();
    }, (error: unknown) => {
      finish(() => reject(mismatch(
        `updating the service worker failed: ${error instanceof Error ? error.message : String(error)}`,
      )));
    });
    check();
  });
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
  options: ServiceWorkerReadyOptions = {},
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
  const owned = await waitForOwnedServiceWorker(
    registration,
    scriptUrl.href,
    expectedScopeUrl,
  );
  if (options.buildId === undefined) return owned;
  return awaitControllerBuild(
    registration,
    owned,
    scriptUrl.href,
    expectedScopeUrl,
    options.buildId,
    options.onBuildMismatch,
  );
}

/**
 * This page's build id, from the `<meta name="kandelo-build-id">` every HTML
 * entry carries (vite/build-id.ts). Development pages carry the placeholder,
 * which their development worker reports too.
 */
export function pageBuildId(document: Pick<Document, "querySelector">): string {
  const content = document
    .querySelector('meta[name="kandelo-build-id"]')
    ?.getAttribute("content");
  if (!content) {
    throw new Error("This page carries no Kandelo build id (meta kandelo-build-id)");
  }
  return content;
}

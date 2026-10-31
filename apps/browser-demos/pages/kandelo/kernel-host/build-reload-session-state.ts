import { scopedStorageKey } from "../../../../../web-libs/kandelo-session/src/deployment-scope";
import type { CoiReloadSessionStorage } from "./coi-reload-session-state";

/**
 * At most one reload per (page build, worker build) pair, per tab and
 * deployment scope.
 *
 * A page whose controlling service worker belongs to another build, after
 * asking the browser to update it, reloads once: a fresh navigation can bring
 * both from the same deployment. If the same pair comes back, something in
 * front of the site (an edge cache holding an old `service-worker.js` or
 * page) keeps serving them apart, and reloading again would loop; the page
 * shows the mismatch instead. A different pair (another deploy) earns its own
 * single reload. See docs/browser-support.md, "Deployment updates".
 */
export interface BuildReloadSessionState {
  clear(): void;
  wasAttempted(pageBuildId: string, workerBuildId: string | null): boolean;
  markAttempted(pageBuildId: string, workerBuildId: string | null): void;
}

export function createBuildReloadSessionState(
  scopePath: string,
  storage: CoiReloadSessionStorage,
): BuildReloadSessionState {
  const key = scopedStorageKey(scopePath, "build-reload-attempted");
  const pair = (pageBuildId: string, workerBuildId: string | null) =>
    JSON.stringify([pageBuildId, workerBuildId]);
  return {
    clear: () => storage.removeItem(key),
    wasAttempted: (pageBuildId, workerBuildId) =>
      storage.getItem(key) === pair(pageBuildId, workerBuildId),
    markAttempted: (pageBuildId, workerBuildId) =>
      storage.setItem(key, pair(pageBuildId, workerBuildId)),
  };
}

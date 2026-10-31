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
 * single reload. Every attempted pair is remembered until a boot succeeds, so
 * an edge that hands out two deployments' pairs in turn cannot loop either.
 * See docs/browser-support.md, "Deployment updates".
 */
export interface BuildReloadSessionState {
  clear(): void;
  wasAttempted(pageBuildId: string, workerBuildId: string | null): boolean;
  markAttempted(pageBuildId: string, workerBuildId: string | null): void;
}

/** Bounds the stored list; a tab sees far fewer deployments than this. */
const MAX_REMEMBERED_PAIRS = 16;

export function createBuildReloadSessionState(
  scopePath: string,
  storage: CoiReloadSessionStorage,
): BuildReloadSessionState {
  const key = scopedStorageKey(scopePath, "build-reload-attempted");
  const pair = (pageBuildId: string, workerBuildId: string | null) =>
    JSON.stringify([pageBuildId, workerBuildId]);
  const attempted = (): string[] => {
    const stored = storage.getItem(key);
    if (stored === null) return [];
    try {
      const pairs: unknown = JSON.parse(stored);
      return Array.isArray(pairs) ? pairs.filter((p) => typeof p === "string") : [];
    } catch {
      return [];
    }
  };
  return {
    clear: () => storage.removeItem(key),
    wasAttempted: (pageBuildId, workerBuildId) =>
      attempted().includes(pair(pageBuildId, workerBuildId)),
    markAttempted: (pageBuildId, workerBuildId) =>
      storage.setItem(key, JSON.stringify([
        ...attempted().slice(-(MAX_REMEMBERED_PAIRS - 1)),
        pair(pageBuildId, workerBuildId),
      ])),
  };
}

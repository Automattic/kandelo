import { scopedStorageKey } from "../../../../../web-libs/kandelo-session/src/deployment-scope";

export interface CoiReloadSessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface CoiReloadSessionState {
  clear(): void;
  wasAttempted(): boolean;
  markAttempted(): void;
}

export function createCoiReloadSessionState(
  scopePath: string,
  storage: CoiReloadSessionStorage,
): CoiReloadSessionState {
  const key = scopedStorageKey(scopePath, "coi-reload-attempted");
  return {
    clear: () => storage.removeItem(key),
    wasAttempted: () => storage.getItem(key) === "1",
    markAttempted: () => storage.setItem(key, "1"),
  };
}

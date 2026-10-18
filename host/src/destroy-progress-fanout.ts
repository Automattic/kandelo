import type { DestroyProgressEvent } from "./browser-kernel-protocol";

export interface DestroyProgressFanout {
  subscribe(cb: (event: DestroyProgressEvent) => void): () => void;
  emit(event: DestroyProgressEvent): void;
  clear(): void;
}

/** Shared listener set so both hosts fan out teardown progress identically. */
export function createDestroyProgressFanout(): DestroyProgressFanout {
  const listeners = new Set<(event: DestroyProgressEvent) => void>();
  return {
    subscribe(cb) {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    emit(event) {
      for (const cb of listeners) {
        try { cb(event); } catch { /* listener errors don't break the loop */ }
      }
    },
    clear() { listeners.clear(); },
  };
}

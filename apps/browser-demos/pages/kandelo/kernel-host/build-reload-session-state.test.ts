import assert from "node:assert/strict";
import test from "node:test";

import { createBuildReloadSessionState } from "./build-reload-session-state";

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, value); },
    removeItem: (key: string) => { items.delete(key); },
  };
}

test("allows one reload per page/worker build pair, scoped to the deployment", () => {
  const storage = memoryStorage();
  const a = createBuildReloadSessionState("/a/", storage);
  const b = createBuildReloadSessionState("/b/", storage);
  assert.equal(a.wasAttempted("page-2", "worker-1"), false);
  a.markAttempted("page-2", "worker-1");
  assert.equal(a.wasAttempted("page-2", "worker-1"), true);
  // Another deploy is another pair; a sibling deployment keeps its own state.
  assert.equal(a.wasAttempted("page-3", "worker-1"), false);
  assert.equal(a.wasAttempted("page-2", null), false);
  assert.equal(b.wasAttempted("page-2", "worker-1"), false);
  a.markAttempted("page-2", null);
  assert.equal(a.wasAttempted("page-2", null), true);
  a.clear();
  assert.equal(a.wasAttempted("page-2", null), false);
  assert.equal(storage.items.size, 0);
});

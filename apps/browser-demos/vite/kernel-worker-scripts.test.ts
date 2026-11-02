import assert from "node:assert/strict";
import test from "node:test";

import {
  bundleIncludesModule,
  kernelWorkerScriptPathsForServiceWorker,
} from "./kernel-worker-scripts";

test("the production service worker names each emitted kernel worker chunk under the base", () => {
  assert.deepEqual(
    kernelWorkerScriptPathsForServiceWorker(
      new Set(["assets/browser-kernel-worker-entry-b.js", "assets/browser-kernel-worker-entry-a.js"]),
      "/kandelo/",
      true,
    ),
    ["/kandelo/assets/browser-kernel-worker-entry-a.js", "/kandelo/assets/browser-kernel-worker-entry-b.js"],
  );
});

test("a production build that bundles the kernel host but no kernel worker chunk fails instead of disabling every grant", () => {
  assert.throws(
    () => kernelWorkerScriptPathsForServiceWorker(new Set(), "/", true),
    /no kernel worker chunk was emitted/,
  );
});

test("a production build without the kernel host names no kernel worker and does not fail", () => {
  // No kernel can run in such a build, so no process can hold a grant: the
  // service worker truthfully names no kernel worker.
  assert.deepEqual(kernelWorkerScriptPathsForServiceWorker(new Set(), "/", false), []);
});

test("bundleIncludesModule finds a module in any output chunk, ignoring queries", () => {
  const host = "/repo/host/src/browser-kernel-host.ts";
  const bundle = {
    "assets/index.js": { type: "chunk", moduleIds: ["/repo/apps/main.ts", `${host}?v=1`] },
    "assets/style.css": { type: "asset" },
  };
  assert.equal(bundleIncludesModule(bundle, host), true);
  assert.equal(
    bundleIncludesModule(
      { "assets/entry.js": { type: "chunk", moduleIds: ["/repo/fixture/entry.ts"] } },
      host,
    ),
    false,
  );
});

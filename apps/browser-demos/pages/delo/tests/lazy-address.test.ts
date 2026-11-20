import assert from "node:assert/strict";
import test from "node:test";

import { deloLazyAddress } from "../src/lazy-address";

test("keeps a URL and puts a path under the binaries root", () => {
  assert.equal(deloLazyAddress("https://foo.test/bar.zip"), "https://foo.test/bar.zip");
  assert.equal(deloLazyAddress("programs/wasm32/foo.wasm"), "binaries/programs/wasm32/foo.wasm");
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  isLegacyShellProgramFetch,
} from "./test/homebrew-shell-request";

test("legacy shell request matching is shared by focused and product proofs", () => {
  assert.equal(
    isLegacyShellProgramFetch("fetch", "https://example.test/programs/bash.wasm"),
    true,
  );
  assert.equal(
    isLegacyShellProgramFetch("fetch", "https://example.test/dash.wasm?cache=1"),
    true,
  );
  assert.equal(
    isLegacyShellProgramFetch("fetch", "https://example.test/dash.wasm?import&url"),
    false,
  );
  assert.equal(
    isLegacyShellProgramFetch("script", "https://example.test/bash.wasm"),
    false,
  );
  assert.equal(
    isLegacyShellProgramFetch("fetch", "https://example.test/bash.wasm.map"),
    false,
  );
});

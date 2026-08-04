import assert from "node:assert/strict";
import test from "node:test";

import {
  validateHomebrewVfsAcceptanceRequest,
  type HomebrewVfsAcceptanceRequest,
} from "./pages/homebrew-vfs-test/acceptance-request";

function request(
  overrides: Partial<HomebrewVfsAcceptanceRequest> = {},
): HomebrewVfsAcceptanceRequest {
  return {
    vfsUrl: "https://example.test/image.vfs.zst",
    executable: "/opt/kandelo/homebrew/bin/dash",
    argv: ["dash", "-i"],
    timeoutMs: 1_000,
    ...overrides,
  };
}

test("focused PTY acceptance keeps stdin bounded by encoded bytes", () => {
  assert.equal(
    validateHomebrewVfsAcceptanceRequest(
      request({ pty: true, stdin: "a".repeat(65_536) }),
    )?.byteLength,
    65_536,
  );
  assert.throws(
    () => validateHomebrewVfsAcceptanceRequest(
      request({ pty: true, stdin: "a".repeat(65_537) }),
    ),
    /stdin must be a string of at most 65536 bytes/,
  );
  assert.throws(
    () => validateHomebrewVfsAcceptanceRequest(
      request({ pty: true, stdin: "é".repeat(32_769) }),
    ),
    /stdin must be a string of at most 65536 bytes/,
  );
});

test("focused PTY acceptance requires an input that can reach EOF", () => {
  assert.throws(
    () => validateHomebrewVfsAcceptanceRequest(request({ pty: true })),
    /focused PTY acceptance requires bounded stdin/,
  );
  assert.equal(
    validateHomebrewVfsAcceptanceRequest(request({ stdin: "input\n" }))
      ?.byteLength,
    6,
  );
});

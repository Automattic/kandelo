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
  const accepted = validateHomebrewVfsAcceptanceRequest(
    request({ pty: true, stdin: "a".repeat(65_536) }),
  );
  assert.equal(accepted.kind, "pty");
  assert.equal(accepted.kind === "pty" && accepted.input.byteLength, 65_536);
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

test("focused PTY acceptance requires bounded terminal input", () => {
  assert.throws(
    () => validateHomebrewVfsAcceptanceRequest(request({ pty: true })),
    /focused PTY acceptance requires bounded terminal input/,
  );
});

test("focused acceptance keeps stdio and PTY input transports distinct", () => {
  const stdio = validateHomebrewVfsAcceptanceRequest(
    request({ stdin: "input\n" }),
  );
  assert.equal(stdio.kind, "stdio");
  assert.equal(stdio.kind === "stdio" && stdio.stdin?.byteLength, 6);
  assert.equal("input" in stdio, false);

  const pty = validateHomebrewVfsAcceptanceRequest(
    request({ pty: true, stdin: "printf marker\\n\nexit\n" }),
  );
  assert.equal(pty.kind, "pty");
  assert.equal("stdin" in pty, false);
  assert.equal(
    pty.kind === "pty" && new TextDecoder().decode(pty.input),
    "printf marker\\n\nexit\n",
  );
});

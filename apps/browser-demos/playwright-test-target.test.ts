import assert from "node:assert/strict";
import test from "node:test";

import {
  configuredPlaywrightTestBaseUrl,
  usesManagedPlaywrightServer,
} from "./playwright-test-target";

test("normalizes a safe external deployment root", () => {
  assert.equal(configuredPlaywrightTestBaseUrl({}), undefined);
  assert.equal(
    configuredPlaywrightTestBaseUrl({
      KANDELO_TEST_BASE_URL: "https://automattic.github.io/kandelo",
    }),
    "https://automattic.github.io/kandelo/",
  );
});

test("starts Vite only for the configured local Playwright target", () => {
  assert.equal(usesManagedPlaywrightServer(undefined, 5401), true);
  assert.equal(
    usesManagedPlaywrightServer("http://127.0.0.1:5401/kandelo/", 5401),
    true,
  );
  assert.equal(
    usesManagedPlaywrightServer(
      "https://automattic.github.io/kandelo/",
      5401,
    ),
    false,
  );
  assert.equal(
    usesManagedPlaywrightServer("http://127.0.0.1:5402/kandelo/", 5401),
    false,
  );
});

test("rejects ambiguous or credential-bearing deployment roots", () => {
  for (const value of [
    "",
    " /kandelo/",
    "file:///tmp/kandelo/",
    "https://user@example.test/kandelo/",
    "https://example.test/kandelo/?demo=shell",
    "https://example.test/kandelo/#shell",
  ]) {
    assert.throws(
      () => configuredPlaywrightTestBaseUrl({
        KANDELO_TEST_BASE_URL: value,
      }),
      /KANDELO_TEST_BASE_URL/,
    );
  }
});

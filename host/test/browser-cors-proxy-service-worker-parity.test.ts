import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { BROWSER_CONTROLLED_REQUEST_HEADER_NAMES } from "../src/networking/browser-cors-proxy";

// The CORS proxy request-header projection is implemented twice: once in TS
// (browser-cors-proxy.ts, used by the guest-socket backends) and once in plain
// JS inside the service worker, which cannot import the TS module. The two must
// classify browser-controlled request headers identically or a request the
// backend accepts can still be rejected at the service-worker boundary (or vice
// versa). This test fails loudly if the hand-maintained copies drift.

const serviceWorkerSource = readFileSync(
  fileURLToPath(
    new URL(
      "../../apps/browser-demos/public/service-worker.js",
      import.meta.url,
    ),
  ),
  "utf8",
);

function serviceWorkerBrowserControlledNames(): Set<string> {
  const match = serviceWorkerSource.match(
    /BROWSER_CONTROLLED_REQUEST_HEADER_NAMES\s*=\s*new Set\(\[([\s\S]*?)\]\)/,
  );
  if (!match) {
    throw new Error(
      "service-worker.js no longer declares BROWSER_CONTROLLED_REQUEST_HEADER_NAMES as a Set literal; update this parity test",
    );
  }
  const names = [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  return new Set(names);
}

describe("browser CORS proxy service-worker parity", () => {
  it("shares the exact browser-controlled request-header set with the service worker", () => {
    const swNames = serviceWorkerBrowserControlledNames();
    expect([...swNames].sort()).toEqual(
      [...BROWSER_CONTROLLED_REQUEST_HEADER_NAMES].sort(),
    );
  });

  it("applies the same proxy-/sec- prefix rule in both implementations", () => {
    // The TS side treats proxy-* and sec-* as browser-controlled via
    // startsWith; the service worker must use the same prefixes.
    expect(serviceWorkerSource).toMatch(/indexOf\("proxy-"\)\s*===\s*0/);
    expect(serviceWorkerSource).toMatch(/indexOf\("sec-"\)\s*===\s*0/);
  });

  it("checks credential headers before the browser-controlled drop in the service worker", () => {
    // proxy-authorization matches the proxy- prefix, so the credential check
    // must run first or credentials would be silently dropped instead of
    // failing loudly. Assert the credential branch precedes the managed drop.
    const credentialIndex = serviceWorkerSource.indexOf('"proxy-authorization"');
    const managedIndex = serviceWorkerSource.indexOf(
      "isBrowserManagedRequestHeader(lower)",
    );
    expect(credentialIndex).toBeGreaterThan(-1);
    expect(managedIndex).toBeGreaterThan(-1);
    expect(credentialIndex).toBeLessThan(managedIndex);
  });
});

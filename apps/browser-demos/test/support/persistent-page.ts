import { test as base } from "../../playwright-test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const test = base.extend({
  context: async ({ playwright, browserName, launchOptions, channel, headless,
    contextOptions, baseURL, viewport, deviceScaleFactor, permissions,
    serviceWorkers, extraHTTPHeaders, proxy }, use) => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-computer-library-"));
    try {
      const context = await playwright[browserName].launchPersistentContext(directory, {
        // Why: real machine boot opens its storage-backed computer library;
        // WebKit's ephemeral context rejects native OPFS getDirectory(). Keep
        // the resolved test.use emulation/options when using that real profile.
        ...launchOptions, channel, headless,
        ...contextOptions, baseURL, viewport, deviceScaleFactor, permissions,
        serviceWorkers, extraHTTPHeaders, proxy,
      });
      try { await use(context); }
      finally { await context.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  },
});

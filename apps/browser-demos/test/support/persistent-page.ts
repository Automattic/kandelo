import { test as base } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const test = base.extend({
  context: async ({ playwright, browserName, baseURL }, use, testInfo) => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-computer-library-"));
    try {
      const context = await playwright[browserName].launchPersistentContext(directory, {
        ...testInfo.project.use.launchOptions,
        channel: testInfo.project.use.channel,
        proxy: testInfo.project.use.proxy,
        extraHTTPHeaders: testInfo.project.use.extraHTTPHeaders,
        baseURL,
      });
      try { await use(context); }
      finally { await context.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  },
});

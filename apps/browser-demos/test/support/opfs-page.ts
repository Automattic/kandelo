import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "@playwright/test";

export const opfsTest = test.extend({
  page: async ({ playwright, browserName }, use, testInfo) => {
    const profile = mkdtempSync(join(tmpdir(), "kandelo-opfs-page-"));
    try {
      const context = await playwright[browserName].launchPersistentContext(profile, {
        ...testInfo.project.use.launchOptions, channel: testInfo.project.use.channel,
        proxy: testInfo.project.use.proxy, extraHTTPHeaders: testInfo.project.use.extraHTTPHeaders,
      });
      try { await use(context.pages()[0] ?? await context.newPage()); }
      finally { await context.close(); }
    } finally { rmSync(profile, { recursive: true, force: true }); }
  },
});

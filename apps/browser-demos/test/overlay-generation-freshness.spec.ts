import { expect, test } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repository = resolve(import.meta.dirname, "../../..");

for (const scenario of ["seal", "index", "missing-index", "retirement", "newer-descendant",
  "unanchored-retirement", "unanchored-newer-descendant", "fingerprint-close"] as const) {
  test(`OPFS generation recovery handles ${scenario} without silently accepting an ambiguous stale target`, async ({ playwright, browserName, baseURL }, testInfo) => {
    const profile = mkdtempSync(join(tmpdir(), "kandelo-opfs-freshness-"));
    try {
      const context = await playwright[browserName].launchPersistentContext(profile, {
        ...testInfo.project.use.launchOptions,
        channel: testInfo.project.use.channel,
        proxy: testInfo.project.use.proxy,
        extraHTTPHeaders: testInfo.project.use.extraHTTPHeaders,
      });
      try {
        const page = context.pages()[0] ?? await context.newPage();
        const imageModuleUrl = new URL("/freshness-image-module.wasm", baseURL).href;
        await context.route(imageModuleUrl, route => route.fulfill({
          body: readFileSync(join(repository, "local-binaries/kandelo_image_module32.wasm")),
        }));
        await page.goto(new URL("/trap-signal-test.html", baseURL).href, { waitUntil: "domcontentloaded" });
        const result = await page.evaluate(async ({ scenario, imageModuleUrl }) => {
          const worker = new Worker("/test/fixtures/opfs-generation-freshness-worker.ts", { type: "module" });
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            return await new Promise((resolve, reject) => {
              let stage = "worker-start";
              timer = setTimeout(() => reject(new Error(`OPFS generation worker stalled at ${stage}`)), 30_000);
              worker.onmessage = event => {
                if (typeof event.data.stage === "string") stage = event.data.stage;
                else resolve(event.data);
              };
              worker.onerror = event => reject(new Error(event.message));
              worker.postMessage({ scenario, imageModuleUrl, name: `freshness-${crypto.randomUUID()}` });
            });
          } finally { clearTimeout(timer); worker.terminate(); }
        }, { scenario, imageModuleUrl });
        if (scenario === "fingerprint-close") {
          expect(result).toEqual({ refused: true, enabled: 0, indexCloses: 1, fingerprintReads: 1 });
        } else {
          const successful = scenario === "retirement" || scenario === "newer-descendant";
          expect(result).toEqual({ selected: successful ? scenario === "retirement" ? "g1" : "g2" : null,
            refused: !successful, enabled: successful ? 1 : 0, unchanged: true });
        }
      } finally { await context.close(); }
    } finally { rmSync(profile, { recursive: true, force: true }); }
  });
}
